import { normalizeWorldDesign } from "../../../../orchestrator/src/world-design-utils.mjs";
import { geminiProVision } from "../models/gemini-pro.mjs";
import { editImage } from "../models/gemini-flash-img.mjs";
import { loadPrompt } from "../utils/prompt-loader.mjs";
import { buildOverlayWorkingImage, drawBoundingBoxes, getImageSize } from "../utils/image-utils.mjs";
import {
  COLOR_SPECS,
  MAX_BATCH_SIZE,
  chunkArray,
  extractRegionBoxesFromMarkedImage,
} from "../utils/overlay-extraction.mjs";

const REGION_COLOR = "rgba(255,0,255,0.95)";
const REGION_BOX_STYLE = {
  lineWidth: 6,
  fontSize: 18,
  labelTextColor: "#ffffff",
  labelBgColor: "rgba(255,0,255,0.95)",
};

function cloneRegions(regions) {
  return JSON.parse(JSON.stringify(regions));
}

function buildRegionBoxes(regions) {
  return regions
    .filter((r) => r.topLeft && r.bottomRight)
    .map((r) => ({
      x: r.topLeft.x,
      y: r.topLeft.y,
      w: r.bottomRight.x - r.topLeft.x,
      h: r.bottomRight.y - r.topLeft.y,
      color: REGION_COLOR,
      label: r.id,
    }));
}

function prepareDesignedRegions(worldDesign) {
  console.log("[Step 3] Preparing predesigned regions...");
  const normalized = normalizeWorldDesign(worldDesign);
  const regions = (normalized.regions || []).map((region) => ({
    id: region.id,
    name: region.name,
    description: region.description,
    type: region.type,
    enterable: region.enterable,
    shapeConstraint: region.shapeConstraint,
    placementHint: region.placementHint,
    visualDescription: region.visualDescription,
    actions: (region.interactions || []).map((interaction) => interaction.id),
    adjacentRegions: [],
    interactions: region.interactions || [],
  }));

  console.log(`[Step 3] Using ${regions.length} predesigned regions.`);
  for (const region of regions) {
    console.log(
      `[Step 3]   Region: ${region.id} (${region.name}) — ${region.actions?.length || 0} actions`,
    );
  }
  return regions;
}

function parseConfirmation(raw) {
  if (!raw || !raw.trim()) throw new Error("Empty region confirmation response");
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);
  if (typeof parsed.pass !== "boolean") {
    throw new Error("Region confirmation response missing boolean pass");
  }
  return parsed;
}

async function processBatch({
  batchIndex,
  regions,
  userPrompt,
  mapDescription,
  compressedMap,
  overlayInputMap,
  save,
  additionalConstraints,
}) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000",
    10,
  );

  const colorAssignments = regions.map((region, index) => ({
    region,
    color: COLOR_SPECS[index],
  }));

  const regionList = colorAssignments
    .map(({ region }, index) =>
      [
        `${index + 1}. ${region.name} (${region.id})`,
        `   - 类型：${region.type}${region.enterable ? " / 可进入" : ""}`,
        `   - 位置提示：${region.placementHint || "未指定"}`,
        `   - 外观提示：${region.visualDescription || region.description || "未指定"}`,
        `   - 说明：${region.description || "无"}`,
      ].join("\n"),
    )
    .join("\n");

  const colorLegend = colorAssignments
    .map(
      ({ region, color }) =>
        `- ${region.id}: 使用 ${color.label}，色值 ${color.rgba}，对应 RGB(${color.rgb.join(", ")})`,
    )
    .join("\n");

  const prompt = loadPrompt("step3-overlay-generation.md", {
    userPrompt,
    mapDescription,
    regionList,
    colorLegend,
    additionalConstraints: additionalConstraints || "",
  });

  console.log(`[Step 3] Batch ${batchIndex}: marking ${regions.length} regions with Nano Banana...`);
  colorAssignments.forEach(({ region, color }) => {
    console.log(
      `[Step 3]   ${region.id} -> ${color.label} RGB(${color.rgb.join(", ")})`,
    );
  });

  const markedBuffer = await editImage(prompt, overlayInputMap, {
    imageSize: "1K",
    logStep: `Step 3 overlay batch ${batchIndex}`,
    requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
  });
  save(`03-overlay-batch-${batchIndex}.png`, markedBuffer);
  console.log(
    `[Step 3] Batch ${batchIndex}: overlay saved (${Math.round(markedBuffer.length / 1024)}KB)`,
  );

  const detectedRegions = await extractRegionBoxesFromMarkedImage(
    compressedMap,
    markedBuffer,
    colorAssignments,
  );

  if (detectedRegions.length === 0) {
    console.log(`[Step 3] Batch ${batchIndex}: no regions detected from overlay diff`);
  } else {
    console.log(`[Step 3] Batch ${batchIndex}: detected ${detectedRegions.length} region(s)`);
    detectedRegions.forEach((region) => {
      console.log(
        `[Step 3]   ${region.id}: (${region.topLeft.x},${region.topLeft.y}) -> (${region.bottomRight.x},${region.bottomRight.y})`,
      );
    });
  }

  return { batchIndex, detectedRegions };
}

/**
 * Locate predesigned regions on the map using color overlays + image diff,
 * then confirm the recovered boxes with the configured vision model.
 * Verification failures are explicit: unavailable verification never counts as pass.
 */
export async function resolveDesignedRegions(compressedBuffer, worldDesign, userPrompt, save) {
  const preparedRegions = prepareDesignedRegions(worldDesign);
  if (preparedRegions.length === 0) {
    console.log("[Step 3] No predesigned regions for this world; skipping localization.");
    return {
      preparedRegions,
      regions: [],
      annotatedImage: compressedBuffer,
      reviewPassed: true,
      verificationStatus: "not_required",
      verifierUnavailable: false,
      attempts: 0,
      droppedRegionIds: [],
    };
  }

  const regions = cloneRegions(preparedRegions);
  const mapDescription = worldDesign.mapDescription || userPrompt;
  const MAX_RETRIES = parseInt(process.env.STEP3_MAX_RETRIES || "2", 10);
  const TOTAL_ATTEMPTS = Math.max(1, MAX_RETRIES + 1);
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_CONFIRM_TIMEOUT_MS || process.env.STEP3_REVIEW_TIMEOUT_MS || "90000",
    10,
  );
  const { width: imageWidth, height: imageHeight } = await getImageSize(compressedBuffer);
  const overlayWorkingImage = await buildOverlayWorkingImage(compressedBuffer);
  if (overlayWorkingImage.resized) {
    console.log(
      `[Step 3] Using resized overlay working image ${overlayWorkingImage.width}x${overlayWorkingImage.height} (source ${imageWidth}x${imageHeight})`,
    );
  }

  let reviewPassed = false;
  let verificationStatus = "not_run";
  let verifierUnavailable = false;
  let attemptsUsed = 0;
  let lastProblematicIds = [];
  let additionalConstraints = "";

  for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
    const pendingRegions = regions.filter((r) => !r.topLeft || !r.bottomRight);
    if (pendingRegions.length === 0) break;

    attemptsUsed = attempt;
    console.log(
      `[Step 3] Attempt ${attempt}/${TOTAL_ATTEMPTS}: locating ${pendingRegions.length} region(s) via color overlay...`,
    );

    const batches = chunkArray(pendingRegions, MAX_BATCH_SIZE);
    console.log(`[Step 3] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);
    const attemptSave = attempt === 1
      ? save
      : (name, data) => save(name.replace(/\.png$/, `-a${attempt}.png`), data);

    const batchResults = await Promise.all(
      batches.map((batchRegions, idx) =>
        processBatch({
          batchIndex: idx + 1,
          regions: batchRegions,
          userPrompt,
          mapDescription,
          compressedMap: compressedBuffer,
          overlayInputMap: overlayWorkingImage.buffer,
          save: attemptSave,
          additionalConstraints,
        }),
      ),
    );

    const detectedRegions = batchResults.flatMap((result) => result.detectedRegions);
    const detectedMap = new Map(detectedRegions.map((detected) => [detected.id, detected]));
    for (const region of regions) {
      if ((!region.topLeft || !region.bottomRight) && detectedMap.has(region.id)) {
        const detected = detectedMap.get(region.id);
        region.topLeft = detected.topLeft;
        region.bottomRight = detected.bottomRight;
      }
    }

    const locatedRegions = regions.filter((r) => r.topLeft && r.bottomRight);
    const stillMissingIds = regions
      .filter((r) => !r.topLeft || !r.bottomRight)
      .map((r) => r.id);
    if (stillMissingIds.length > 0) {
      console.warn(
        `[Step 3] Attempt ${attempt}: regions not detected from overlays: ${stillMissingIds.join(", ")}`,
      );
    }
    console.log(
      `[Step 3] Attempt ${attempt}: overlay extraction total ${locatedRegions.length}/${regions.length} located`,
    );

    if (locatedRegions.length === 0) {
      console.error(`[Step 3] Attempt ${attempt}: no regions detected from any overlay batch.`);
      lastProblematicIds = [];
      continue;
    }

    const boxes = buildRegionBoxes(locatedRegions);
    const annotatedImage = await drawBoundingBoxes(compressedBuffer, boxes, REGION_BOX_STYLE);
    save(`03-regions-attempt-${attempt}.png`, annotatedImage);

    const regionsList = locatedRegions
      .map(
        (r) => `- ${r.id}: ${r.name} (${r.type}) (${r.topLeft.x},${r.topLeft.y})→(${r.bottomRight.x},${r.bottomRight.y})`,
      )
      .join("\n");
    const confirmPrompt = loadPrompt("step3-confirm-regions.md", {
      regionsList,
      imageWidth,
      imageHeight,
      userPrompt,
    });

    let confirmResult;
    try {
      console.log(`[Step 3] Attempt ${attempt}: running confirmation pass with Gemini Pro...`);
      const raw = await geminiProVision(confirmPrompt, [compressedBuffer, annotatedImage], {
        logStep: `Step 3 confirm attempt ${attempt}`,
        requestTimeoutMs: CONFIRM_TIMEOUT_MS,
      });
      confirmResult = parseConfirmation(raw);
      verificationStatus = confirmResult.pass ? "verified_pass" : "verified_fail";
    } catch (error) {
      verifierUnavailable = true;
      verificationStatus = "verifier_unavailable";
      console.warn(
        `[Step 3] Attempt ${attempt}: confirmation unavailable; keeping detected regions without counting review as pass: ${error.message}`,
      );
      break;
    }

    const problematicIds = confirmResult.problematic_region_ids || [];
    lastProblematicIds = problematicIds;
    if (confirmResult.pass) {
      console.log(`[Step 3] Attempt ${attempt}: confirmation passed — all detected regions accepted.`);
      reviewPassed = true;
      break;
    }

    console.log(
      `[Step 3] Attempt ${attempt}: flagged ${problematicIds.length} problematic region(s): ${problematicIds.join(", ")}`,
    );
    const feedback = confirmResult.feedback || {};
    const feedbackLines = problematicIds
      .filter((id) => feedback[id])
      .map((id) => `- ${id}：${feedback[id]}`);
    if (feedbackLines.length > 0) {
      additionalConstraints +=
        `\n## 上一次标注审查反馈（请特别注意）\n以下区域上次标注有误，请修正：\n${feedbackLines.join("\n")}\n`;
      console.log(`[Step 3] Accumulated constraints for next attempt: ${feedbackLines.join("; ")}`);
    }

    for (const region of regions) {
      if (problematicIds.includes(region.id)) {
        region.topLeft = undefined;
        region.bottomRight = undefined;
      }
    }
  }

  const finalRegions = regions.filter((r) => r.topLeft && r.bottomRight);
  const droppedRegionIds = regions
    .filter((r) => !r.topLeft || !r.bottomRight)
    .map((r) => r.id);
  let finalAnnotatedImage = compressedBuffer;
  if (finalRegions.length > 0) {
    finalAnnotatedImage = await drawBoundingBoxes(
      compressedBuffer,
      buildRegionBoxes(finalRegions),
      REGION_BOX_STYLE,
    );
  }

  if (!reviewPassed && !verifierUnavailable && lastProblematicIds.length > 0) {
    console.log(
      `[Step 3] Retries exhausted; dropped ${lastProblematicIds.length} problematic region(s): ${lastProblematicIds.join(", ")}`,
    );
  }

  return {
    preparedRegions,
    regions: finalRegions,
    annotatedImage: finalAnnotatedImage,
    reviewPassed,
    verificationStatus,
    verifierUnavailable,
    attempts: attemptsUsed,
    droppedRegionIds,
  };
}

export function scaleRegions(regions, origWidth, compressedWidth) {
  const ratio = origWidth / compressedWidth;
  return regions
    .filter((r) => r.topLeft && r.bottomRight)
    .map((r) => ({
      ...r,
      topLeft: {
        x: Math.round(r.topLeft.x * ratio),
        y: Math.round(r.topLeft.y * ratio),
      },
      bottomRight: {
        x: Math.round(r.bottomRight.x * ratio),
        y: Math.round(r.bottomRight.y * ratio),
      },
    }));
}
