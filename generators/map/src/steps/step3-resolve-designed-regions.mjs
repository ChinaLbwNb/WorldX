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

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function normalizeSuggestedBox(box, imageWidth, imageHeight) {
  const topLeft = box?.topLeft || box?.top_left || box?.tl;
  const bottomRight = box?.bottomRight || box?.bottom_right || box?.br;
  if (!topLeft || !bottomRight) return null;
  const x1 = Math.max(0, Math.min(imageWidth, Math.round(Number(topLeft.x))));
  const y1 = Math.max(0, Math.min(imageHeight, Math.round(Number(topLeft.y))));
  const x2 = Math.max(0, Math.min(imageWidth, Math.round(Number(bottomRight.x))));
  const y2 = Math.max(0, Math.min(imageHeight, Math.round(Number(bottomRight.y))));
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  if (x2 - x1 < 8 || y2 - y1 < 8) return null;
  return { topLeft: { x: x1, y: y1 }, bottomRight: { x: x2, y: y2 } };
}

function parseJsonObject(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : JSON.parse(raw);
}

async function locateRegionsWithVision({ regions, userPrompt, mapDescription, imageBuffer, imageWidth, imageHeight, logStep, additionalConstraints }) {
  if (process.env.STEP3_VISION_BBOX_FALLBACK === "0" || regions.length === 0) return [];
  const list = regions.map((region, index) => [
    `${index + 1}. ${region.name} (${region.id})`,
    `   - 类型：${region.type}${region.enterable ? " / 可进入" : ""}`,
    `   - 位置提示：${region.placementHint || "未指定"}`,
    `   - 外观提示：${region.visualDescription || region.description || "未指定"}`,
    `   - 说明：${region.description || "无"}`,
  ].join("\n")).join("\n");
  const prompt = [
    "你是游戏地图区域定位器。请直接在给定地图原图中定位功能区域，返回 JSON 坐标，不要返回解释。",
    "",
    `地图尺寸：${imageWidth} x ${imageHeight}`,
    "坐标系：左上角为 (0,0)，x 向右，y 向下。",
    "",
    "原始需求：",
    userPrompt,
    "",
    "地图描述：",
    mapDescription,
    "",
    "需要定位的区域：",
    list,
    "",
    "规则：",
    "- 每个区域返回一个轴对齐矩形 bbox。",
    "- 室内区域只框室内主要可活动地板，不要框外墙、门外道路或台阶。",
    "- 室外区域只框核心功能范围。",
    "- 不确定时宁小勿大。",
    "- 如果无法确认某个区域，放入 missing_region_ids，不要硬猜。",
    additionalConstraints ? `\n额外修正要求：\n${additionalConstraints}` : "",
    "",
    "只返回如下 JSON：",
    `{"regions":[{"id":"region_id","topLeft":{"x":0,"y":0},"bottomRight":{"x":100,"y":100}}],"missing_region_ids":[]}`,
  ].join("\n");
  try {
    const raw = await geminiProVision(prompt, [imageBuffer], {
      logStep,
      requestTimeoutMs: parseInt(process.env.STEP3_VISION_BBOX_TIMEOUT_MS || "90000", 10),
      temperature: 0.1,
    });
    const parsed = parseJsonObject(raw);
    const boxes = Array.isArray(parsed.regions) ? parsed.regions : [];
    return boxes.map((box) => {
      const region = regions.find((candidate) => candidate.id === box.id);
      const normalized = normalizeSuggestedBox(box, imageWidth, imageHeight);
      if (!region || !normalized) return null;
      return {
        id: region.id,
        name: region.name,
        type: region.type,
        topLeft: normalized.topLeft,
        bottomRight: normalized.bottomRight,
      };
    }).filter(Boolean);
  } catch (error) {
    console.warn(`[Step 3] Vision bbox fallback failed: ${error.message}`);
    return [];
  }
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

// ─── Nano Banana batch overlay + image-diff extraction ──────────────────────

async function processBatch({ batchIndex, regions, userPrompt, mapDescription, compressedMap, overlayInputMap, save, additionalConstraints }) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000", 10,
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

  let markedBuffer;
  try {
    markedBuffer = await editImage(prompt, overlayInputMap, {
      imageSize: "1K",
      logStep: `Step 3 overlay batch ${batchIndex}`,
      requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn(`[Step 3] Batch ${batchIndex}: overlay generation failed (${e.message}), returning empty batch`);
    return { batchIndex, detectedRegions: [] };
  }
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

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Locate predesigned regions on the map using Nano Banana color overlays + image diff,
 * then run a single Gemini Pro confirmation pass to drop clearly wrong regions.
 * @param {Buffer} compressedBuffer - compressed map PNG
 * @param {object} worldDesign
 * @param {string} userPrompt
 * @param {(name: string, data: any) => void} save
 * @returns {{ preparedRegions: object[], regions: object[], annotatedImage: Buffer, reviewPassed: boolean, attempts: number, droppedRegionIds: string[] }}
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
      attempts: 0,
      droppedRegionIds: [],
    };
  }

  const regions = cloneRegions(preparedRegions);
  const mapDescription = worldDesign.mapDescription || userPrompt;

  const MAX_RETRIES = parseInt(process.env.STEP3_MAX_RETRIES || "2", 10);
  const TOTAL_ATTEMPTS = Math.max(1, MAX_RETRIES + 1);
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_CONFIRM_TIMEOUT_MS || process.env.STEP3_REVIEW_TIMEOUT_MS || "90000", 10,
  );
  const { width: imageWidth, height: imageHeight } = await getImageSize(compressedBuffer);
  const overlayWorkingImage = await buildOverlayWorkingImage(compressedBuffer);
  if (overlayWorkingImage.resized) {
    console.log(
      `[Step 3] Using resized overlay working image ${overlayWorkingImage.width}x${overlayWorkingImage.height} (source ${imageWidth}x${imageHeight})`,
    );
  }

  let reviewPassed = false;
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

    // ── Phase A: Batch overlay via Nano Banana (only for pending regions) ──
    let regionsForOverlay = pendingRegions;
    const visionFirst = process.env.STEP3_VISION_BBOX_FIRST !== "0";
    if (visionFirst) {
      console.log(
        `[Step 3] Attempt ${attempt}: using Vision bbox first for ${pendingRegions.length} pending region(s)...`,
      );
      const visionRegions = await locateRegionsWithVision({
        regions: pendingRegions,
        userPrompt,
        mapDescription,
        imageBuffer: compressedBuffer,
        imageWidth,
        imageHeight,
        logStep: `Step 3 vision bbox first attempt ${attempt}`,
        additionalConstraints,
      });
      const visionMap = new Map(visionRegions.map((d) => [d.id, d]));
      for (const region of regions) {
        if ((!region.topLeft || !region.bottomRight) && visionMap.has(region.id)) {
          const d = visionMap.get(region.id);
          region.topLeft = d.topLeft;
          region.bottomRight = d.bottomRight;
        }
      }
      if (visionRegions.length > 0) {
        console.log(`[Step 3] Attempt ${attempt}: Vision bbox first located ${visionRegions.length} region(s)`);
      }
      regionsForOverlay = regions.filter((r) => !r.topLeft || !r.bottomRight);
    }

    const batches = chunkArray(regionsForOverlay, MAX_BATCH_SIZE);
    console.log(`[Step 3] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);

    const attemptSave = attempt === 1
      ? save
      : (name, data) => save(name.replace(/\.png$/, `-a${attempt}.png`), data);

    const batchResults = batches.length === 0
      ? []
      : await Promise.all(
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

    const detectedRegions = batchResults.flatMap((r) => r.detectedRegions);
    const detectedMap = new Map(detectedRegions.map((d) => [d.id, d]));

    for (const region of regions) {
      if ((!region.topLeft || !region.bottomRight) && detectedMap.has(region.id)) {
        const d = detectedMap.get(region.id);
        region.topLeft = d.topLeft;
        region.bottomRight = d.bottomRight;
      }
    }

    const missingAfterOverlay = regions.filter((r) => !r.topLeft || !r.bottomRight);
    if (missingAfterOverlay.length > 0) {
      console.log(
        `[Step 3] Attempt ${attempt}: using Vision bbox fallback for ${missingAfterOverlay.length} missing region(s)...`,
      );
      const fallbackRegions = await locateRegionsWithVision({
        regions: missingAfterOverlay,
        userPrompt,
        mapDescription,
        imageBuffer: compressedBuffer,
        imageWidth,
        imageHeight,
        logStep: `Step 3 vision bbox fallback attempt ${attempt}`,
        additionalConstraints,
      });
      const fallbackMap = new Map(fallbackRegions.map((d) => [d.id, d]));
      for (const region of regions) {
        if ((!region.topLeft || !region.bottomRight) && fallbackMap.has(region.id)) {
          const d = fallbackMap.get(region.id);
          region.topLeft = d.topLeft;
          region.bottomRight = d.bottomRight;
        }
      }
      if (fallbackRegions.length > 0) {
        console.log(`[Step 3] Attempt ${attempt}: Vision bbox fallback located ${fallbackRegions.length} region(s)`);
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

    // ── Phase B: Draw annotated image for confirmation ──
    const boxes = buildRegionBoxes(locatedRegions);
    const annotatedImage = await drawBoundingBoxes(compressedBuffer, boxes, REGION_BOX_STYLE);
    save(`03-regions-attempt-${attempt}.png`, annotatedImage);

    // ── Phase C: Gemini Pro confirmation pass ──
    const regionsList = locatedRegions
      .map((r) =>
        `- ${r.id}: ${r.name} (${r.type}) (${r.topLeft.x},${r.topLeft.y})→(${r.bottomRight.x},${r.bottomRight.y})`,
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
      confirmResult = parseJsonObject(raw);
    } catch (e) {
      console.warn(
        `[Step 3] Attempt ${attempt}: confirmation call failed (keeping all detected regions): ${e.message}`,
      );
      confirmResult = { pass: true, problematic_region_ids: [] };
    }

    const allowVisionBoxAdjust = process.env.STEP3_ALLOW_VISION_BBOX_ADJUST !== "0";
    const suggestedBoxes = confirmResult.suggested_boxes || confirmResult.suggested_region_boxes || {};
    let problematicIds = confirmResult.problematic_region_ids || [];
    if (allowVisionBoxAdjust && problematicIds.length > 0 && suggestedBoxes && typeof suggestedBoxes === "object") {
      const adjustedIds = [];
      for (const id of problematicIds) {
        const nextBox = normalizeSuggestedBox(suggestedBoxes[id], imageWidth, imageHeight);
        const region = regions.find((candidate) => candidate.id === id);
        if (!nextBox || !region) continue;
        region.topLeft = nextBox.topLeft;
        region.bottomRight = nextBox.bottomRight;
        adjustedIds.push(id);
      }
      if (adjustedIds.length > 0) {
        console.log(`[Step 3] Attempt ${attempt}: applied Vision box adjustment(s): ${adjustedIds.join(", ")}`);
        problematicIds = problematicIds.filter((id) => !adjustedIds.includes(id));
      }
    }
    lastProblematicIds = problematicIds;

    if (confirmResult.pass) {
      console.log(`[Step 3] Attempt ${attempt}: confirmation passed — all detected regions accepted.`);
      reviewPassed = true;
      break;
    }

    if (problematicIds.length === 0) {
      console.log(`[Step 3] Attempt ${attempt}: confirmation issues resolved by box adjustment.`);
      reviewPassed = true;
      break;
    }

    console.log(
      `[Step 3] Attempt ${attempt}: flagged ${problematicIds.length} problematic region(s): ${problematicIds.join(", ")}`,
    );

    // Accumulate review feedback as constraints for next overlay attempt
    const feedback = confirmResult.feedback || {};
    const feedbackLines = problematicIds
      .filter((id) => feedback[id])
      .map((id) => `- ${id}：${feedback[id]}`);
    if (feedbackLines.length > 0) {
      additionalConstraints +=
        `\n## 上一次标注审查反馈（请特别注意）\n以下区域上次标注有误，请修正：\n${feedbackLines.join("\n")}\n`;
      console.log(`[Step 3] Accumulated constraints for next attempt: ${feedbackLines.join("; ")}`);
    }

    // Clear problematic boxes.
    // On retry: they become pending again and will be re-detected next attempt.
    // On the final attempt: they stay cleared and are dropped (existing behavior).
    if (problematicIds.length > 0) {
      for (const region of regions) {
        if (problematicIds.includes(region.id)) {
          region.topLeft = undefined;
          region.bottomRight = undefined;
        }
      }
    }
  }

  const finalRegions = regions.filter((r) => r.topLeft && r.bottomRight);
  const droppedRegionIds = regions
    .filter((r) => !r.topLeft || !r.bottomRight)
    .map((r) => r.id);

  let finalAnnotatedImage = compressedBuffer;
  if (finalRegions.length > 0) {
    const finalBoxes = buildRegionBoxes(finalRegions);
    finalAnnotatedImage = await drawBoundingBoxes(compressedBuffer, finalBoxes, REGION_BOX_STYLE);
  }

  if (!reviewPassed && lastProblematicIds.length > 0) {
    console.log(
      `[Step 3] Retries exhausted; dropped ${lastProblematicIds.length} problematic region(s): ${lastProblematicIds.join(", ")}`,
    );
  }

  return {
    preparedRegions,
    regions: finalRegions,
    annotatedImage: finalAnnotatedImage,
    reviewPassed,
    attempts: attemptsUsed,
    droppedRegionIds,
  };
}

/**
 * Scale region coordinates from compressed to original resolution.
 */
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
