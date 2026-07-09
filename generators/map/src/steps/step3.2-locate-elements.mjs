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

const ELEMENT_COLOR = "rgba(0,200,200,0.95)";
const ELEMENT_BOX_STYLE = {
  lineWidth: 4,
  fontSize: 16,
  labelTextColor: "#ffffff",
  labelBgColor: "rgba(0,200,200,0.95)",
};

function prepareInteractiveElements(worldDesign) {
  console.log("[Step 3.2] Preparing interactive elements...");
  const normalized = normalizeWorldDesign(worldDesign);
  const elements = (normalized.interactiveElements || []).map((element) => ({
    id: element.id,
    name: element.name,
    description: element.description,
    visualDescription: element.visualDescription,
    placementHint: element.placementHint,
    interactions: element.interactions || [],
  }));

  console.log(`[Step 3.2] Found ${elements.length} interactive element(s).`);
  for (const element of elements) {
    console.log(
      `[Step 3.2]   Element: ${element.id} (${element.name}) — ${element.interactions?.length || 0} interactions`,
    );
  }
  return elements;
}

function buildElementBoxes(elements) {
  return elements
    .filter((element) => element.topLeft && element.bottomRight)
    .map((element) => ({
      x: element.topLeft.x,
      y: element.topLeft.y,
      w: element.bottomRight.x - element.topLeft.x,
      h: element.bottomRight.y - element.topLeft.y,
      color: ELEMENT_COLOR,
      label: element.id,
    }));
}

function parseConfirmation(raw) {
  if (!raw || !raw.trim()) throw new Error("Empty element confirmation response");
  const match = raw.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : raw);
  if (typeof parsed.pass !== "boolean") {
    throw new Error("Element confirmation response missing boolean pass");
  }
  return parsed;
}

async function processBatch({
  batchIndex,
  elements,
  userPrompt,
  mapDescription,
  compressedMap,
  overlayInputMap,
  save,
  additionalConstraints,
}) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_OVERLAY_TIMEOUT_MS || process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000",
    10,
  );

  const colorAssignments = elements.map((element, index) => ({
    region: element,
    color: COLOR_SPECS[index],
  }));

  const elementList = colorAssignments
    .map(({ region: element }, index) =>
      [
        `${index + 1}. ${element.name} (${element.id})`,
        `   - 位置提示：${element.placementHint || "未指定"}`,
        `   - 外观提示：${element.visualDescription || element.description || "未指定"}`,
        `   - 说明：${element.description || "无"}`,
      ].join("\n"),
    )
    .join("\n");

  const colorLegend = colorAssignments
    .map(
      ({ region: element, color }) =>
        `- ${element.id}: 使用 ${color.label}，色值 ${color.rgba}，对应 RGB(${color.rgb.join(", ")})`,
    )
    .join("\n");

  const prompt = loadPrompt("step3.2-overlay-generation.md", {
    userPrompt,
    mapDescription,
    elementList,
    colorLegend,
    additionalConstraints: additionalConstraints || "",
  });

  console.log(`[Step 3.2] Batch ${batchIndex}: marking ${elements.length} element(s) with Nano Banana...`);
  colorAssignments.forEach(({ region: element, color }) => {
    console.log(
      `[Step 3.2]   ${element.id} -> ${color.label} RGB(${color.rgb.join(", ")})`,
    );
  });

  const markedBuffer = await editImage(prompt, overlayInputMap, {
    imageSize: "1K",
    logStep: `Step 3.2 overlay batch ${batchIndex}`,
    requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
  });
  save(`03.2-overlay-batch-${batchIndex}.png`, markedBuffer);
  console.log(
    `[Step 3.2] Batch ${batchIndex}: overlay saved (${Math.round(markedBuffer.length / 1024)}KB)`,
  );

  const detectedElements = await extractRegionBoxesFromMarkedImage(
    compressedMap,
    markedBuffer,
    colorAssignments,
  );

  if (detectedElements.length === 0) {
    console.log(`[Step 3.2] Batch ${batchIndex}: no elements detected from overlay diff`);
  } else {
    console.log(`[Step 3.2] Batch ${batchIndex}: detected ${detectedElements.length} element(s)`);
    detectedElements.forEach((element) => {
      console.log(
        `[Step 3.2]   ${element.id}: (${element.topLeft.x},${element.topLeft.y}) -> (${element.bottomRight.x},${element.bottomRight.y})`,
      );
    });
  }

  return { batchIndex, detectedElements };
}

/**
 * Locate interactive elements using color overlays + image diff, then confirm
 * recovered boxes. Verification outages never count as successful review.
 */
export async function locateElements(compressedBuffer, worldDesign, userPrompt, save) {
  const preparedElements = prepareInteractiveElements(worldDesign);
  if (preparedElements.length === 0) {
    console.log("[Step 3.2] No interactive elements for this world; skipping localization.");
    return {
      elements: [],
      annotatedImage: compressedBuffer,
      reviewPassed: true,
      verificationStatus: "not_required",
      verifierUnavailable: false,
      attempts: 0,
      droppedElementIds: [],
    };
  }

  const elements = JSON.parse(JSON.stringify(preparedElements));
  const mapDescription = worldDesign.mapDescription || userPrompt;
  const MAX_RETRIES = parseInt(
    process.env.STEP3_2_MAX_RETRIES || process.env.STEP3_MAX_RETRIES || "2",
    10,
  );
  const TOTAL_ATTEMPTS = Math.max(1, MAX_RETRIES + 1);
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_CONFIRM_TIMEOUT_MS || process.env.STEP3_CONFIRM_TIMEOUT_MS || "90000",
    10,
  );
  const { width: imageWidth, height: imageHeight } = await getImageSize(compressedBuffer);
  const overlayWorkingImage = await buildOverlayWorkingImage(compressedBuffer);
  if (overlayWorkingImage.resized) {
    console.log(
      `[Step 3.2] Using resized overlay working image ${overlayWorkingImage.width}x${overlayWorkingImage.height} (source ${imageWidth}x${imageHeight})`,
    );
  }

  let reviewPassed = false;
  let verificationStatus = "not_run";
  let verifierUnavailable = false;
  let attemptsUsed = 0;
  let lastProblematicIds = [];
  let additionalConstraints = "";

  for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
    const pendingElements = elements.filter((element) => !element.topLeft || !element.bottomRight);
    if (pendingElements.length === 0) break;

    attemptsUsed = attempt;
    console.log(
      `[Step 3.2] Attempt ${attempt}/${TOTAL_ATTEMPTS}: locating ${pendingElements.length} element(s) via color overlay...`,
    );

    const batches = chunkArray(pendingElements, MAX_BATCH_SIZE);
    console.log(`[Step 3.2] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);
    const attemptSave = attempt === 1
      ? save
      : (name, data) => save(name.replace(/\.png$/, `-a${attempt}.png`), data);

    const batchResults = await Promise.all(
      batches.map((batchElements, idx) =>
        processBatch({
          batchIndex: idx + 1,
          elements: batchElements,
          userPrompt,
          mapDescription,
          compressedMap: compressedBuffer,
          overlayInputMap: overlayWorkingImage.buffer,
          save: attemptSave,
          additionalConstraints,
        }),
      ),
    );

    const detectedElements = batchResults.flatMap((result) => result.detectedElements);
    const detectedMap = new Map(detectedElements.map((detected) => [detected.id, detected]));
    for (const element of elements) {
      if ((!element.topLeft || !element.bottomRight) && detectedMap.has(element.id)) {
        const detected = detectedMap.get(element.id);
        element.topLeft = detected.topLeft;
        element.bottomRight = detected.bottomRight;
      }
    }

    const locatedElements = elements.filter((element) => element.topLeft && element.bottomRight);
    const stillMissingIds = elements
      .filter((element) => !element.topLeft || !element.bottomRight)
      .map((element) => element.id);
    if (stillMissingIds.length > 0) {
      console.warn(
        `[Step 3.2] Attempt ${attempt}: elements not detected from overlays: ${stillMissingIds.join(", ")}`,
      );
    }
    console.log(
      `[Step 3.2] Attempt ${attempt}: overlay extraction total ${locatedElements.length}/${elements.length} located`,
    );

    if (locatedElements.length === 0) {
      console.error(`[Step 3.2] Attempt ${attempt}: no elements detected from any overlay batch.`);
      lastProblematicIds = [];
      continue;
    }

    const annotatedImage = await drawBoundingBoxes(
      compressedBuffer,
      buildElementBoxes(locatedElements),
      ELEMENT_BOX_STYLE,
    );
    save(`03.2-elements-attempt-${attempt}.png`, annotatedImage);

    const elementsList = locatedElements
      .map((element) => {
        const lines = [
          `- ${element.id}: ${element.name} (${element.topLeft.x},${element.topLeft.y})→(${element.bottomRight.x},${element.bottomRight.y})`,
        ];
        if (element.visualDescription) lines.push(`  外观：${element.visualDescription}`);
        if (element.placementHint) lines.push(`  位置提示：${element.placementHint}`);
        return lines.join("\n");
      })
      .join("\n");
    const confirmPrompt = loadPrompt("step3.2-confirm-elements.md", {
      elementsList,
      imageWidth,
      imageHeight,
      userPrompt,
    });

    let confirmResult;
    try {
      console.log(`[Step 3.2] Attempt ${attempt}: running confirmation pass with Gemini Pro...`);
      const raw = await geminiProVision(confirmPrompt, [compressedBuffer, annotatedImage], {
        logStep: `Step 3.2 confirm attempt ${attempt}`,
        requestTimeoutMs: CONFIRM_TIMEOUT_MS,
      });
      confirmResult = parseConfirmation(raw);
      verificationStatus = confirmResult.pass ? "verified_pass" : "verified_fail";
    } catch (error) {
      verifierUnavailable = true;
      verificationStatus = "verifier_unavailable";
      console.warn(
        `[Step 3.2] Attempt ${attempt}: confirmation unavailable; keeping detected elements without counting review as pass: ${error.message}`,
      );
      break;
    }

    const problematicIds = confirmResult.problematic_element_ids || [];
    lastProblematicIds = problematicIds;
    if (confirmResult.pass) {
      console.log(`[Step 3.2] Attempt ${attempt}: confirmation passed — all detected elements accepted.`);
      reviewPassed = true;
      break;
    }

    console.log(
      `[Step 3.2] Attempt ${attempt}: flagged ${problematicIds.length} problematic element(s): ${problematicIds.join(", ")}`,
    );
    const feedback = confirmResult.feedback || {};
    const feedbackLines = problematicIds
      .filter((id) => feedback[id])
      .map((id) => `- ${id}：${feedback[id]}`);
    if (feedbackLines.length > 0) {
      additionalConstraints +=
        `\n## 上一次标注审查反馈（请特别注意）\n以下元素上次标注有误，请修正：\n${feedbackLines.join("\n")}\n`;
      console.log(`[Step 3.2] Accumulated constraints for next attempt: ${feedbackLines.join("; ")}`);
    }

    for (const element of elements) {
      if (problematicIds.includes(element.id)) {
        element.topLeft = undefined;
        element.bottomRight = undefined;
      }
    }
  }

  const finalElements = elements.filter((element) => element.topLeft && element.bottomRight);
  const droppedElementIds = elements
    .filter((element) => !element.topLeft || !element.bottomRight)
    .map((element) => element.id);
  let finalAnnotatedImage = compressedBuffer;
  if (finalElements.length > 0) {
    finalAnnotatedImage = await drawBoundingBoxes(
      compressedBuffer,
      buildElementBoxes(finalElements),
      ELEMENT_BOX_STYLE,
    );
  }

  if (!reviewPassed && !verifierUnavailable && lastProblematicIds.length > 0) {
    console.log(
      `[Step 3.2] Retries exhausted; dropped ${lastProblematicIds.length} problematic element(s): ${lastProblematicIds.join(", ")}`,
    );
  }

  return {
    elements: finalElements,
    annotatedImage: finalAnnotatedImage,
    reviewPassed,
    verificationStatus,
    verifierUnavailable,
    attempts: attemptsUsed,
    droppedElementIds,
  };
}

export function scaleElements(elements, origWidth, compressedWidth) {
  const ratio = origWidth / compressedWidth;
  return elements
    .filter((element) => element.topLeft && element.bottomRight)
    .map((element) => ({
      ...element,
      topLeft: {
        x: Math.round(element.topLeft.x * ratio),
        y: Math.round(element.topLeft.y * ratio),
      },
      bottomRight: {
        x: Math.round(element.bottomRight.x * ratio),
        y: Math.round(element.bottomRight.y * ratio),
      },
    }));
}
