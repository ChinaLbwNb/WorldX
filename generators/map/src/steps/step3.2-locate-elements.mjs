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

// ─── Helpers ────────────────────────────────────────────────────────────────

function prepareInteractiveElements(worldDesign) {
  console.log("[Step 3.2] Preparing interactive elements...");
  const normalized = normalizeWorldDesign(worldDesign);
  const elements = (normalized.interactiveElements || []).map((el) => ({
    id: el.id,
    name: el.name,
    description: el.description,
    visualDescription: el.visualDescription,
    placementHint: el.placementHint,
    interactions: el.interactions || [],
  }));

  console.log(`[Step 3.2] Found ${elements.length} interactive element(s).`);
  for (const el of elements) {
    console.log(
      `[Step 3.2]   Element: ${el.id} (${el.name}) — ${el.interactions?.length || 0} interactions`,
    );
  }

  return elements;
}

function buildElementBoxes(elements) {
  return elements
    .filter((e) => e.topLeft && e.bottomRight)
    .map((e) => ({
      x: e.topLeft.x,
      y: e.topLeft.y,
      w: e.bottomRight.x - e.topLeft.x,
      h: e.bottomRight.y - e.topLeft.y,
      color: ELEMENT_COLOR,
      label: e.id,
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
  if (x2 - x1 < 4 || y2 - y1 < 4) return null;
  return { topLeft: { x: x1, y: y1 }, bottomRight: { x: x2, y: y2 } };
}

function parseJsonObject(raw) {
  const match = String(raw || "").match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : JSON.parse(raw);
}

async function locateElementsWithVision({ elements, userPrompt, mapDescription, imageBuffer, imageWidth, imageHeight, logStep, additionalConstraints }) {
  if (process.env.STEP3_2_VISION_BBOX_FALLBACK === "0" || elements.length === 0) return [];
  const list = elements.map((element, index) => [
    `${index + 1}. ${element.name} (${element.id})`,
    `   - 位置提示：${element.placementHint || "未指定"}`,
    `   - 外观提示：${element.visualDescription || element.description || "未指定"}`,
    `   - 说明：${element.description || "无"}`,
  ].join("\n")).join("\n");
  const prompt = [
    "你是游戏地图可交互元素定位器。请直接在给定地图原图中定位小型物件，返回 JSON 坐标，不要返回解释。",
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
    "需要定位的可交互元素：",
    list,
    "",
    "规则：",
    "- 每个元素返回一个紧贴物件视觉主体的轴对齐矩形 bbox。",
    "- 元素是小型物件或设施，不是房间/大区域。",
    "- 不要框周围大面积道路、空地或其他物体。",
    "- 如果同名物件有多个，选择最符合位置提示的一个。",
    "- 如果无法确认某个元素，放入 missing_element_ids，不要硬猜。",
    additionalConstraints ? `\n额外修正要求：\n${additionalConstraints}` : "",
    "",
    "只返回如下 JSON：",
    `{"elements":[{"id":"element_id","topLeft":{"x":0,"y":0},"bottomRight":{"x":100,"y":100}}],"missing_element_ids":[]}`,
  ].join("\n");
  try {
    const raw = await geminiProVision(prompt, [imageBuffer], {
      logStep,
      requestTimeoutMs: parseInt(
        process.env.STEP3_2_VISION_BBOX_TIMEOUT_MS || process.env.STEP3_VISION_BBOX_TIMEOUT_MS || "90000",
        10,
      ),
      temperature: 0.1,
    });
    const parsed = parseJsonObject(raw);
    const boxes = Array.isArray(parsed.elements) ? parsed.elements : [];
    return boxes.map((box) => {
      const element = elements.find((candidate) => candidate.id === box.id);
      const normalized = normalizeSuggestedBox(box, imageWidth, imageHeight);
      if (!element || !normalized) return null;
      return {
        id: element.id,
        name: element.name,
        topLeft: normalized.topLeft,
        bottomRight: normalized.bottomRight,
      };
    }).filter(Boolean);
  } catch (error) {
    console.warn(`[Step 3.2] Vision bbox fallback failed: ${error.message}`);
    return [];
  }
}

// ─── Nano Banana batch overlay ──────────────────────────────────────────────

async function processBatch({ batchIndex, elements, userPrompt, mapDescription, compressedMap, overlayInputMap, save, additionalConstraints }) {
  const IMAGE_EDIT_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_OVERLAY_TIMEOUT_MS || process.env.STEP3_OVERLAY_TIMEOUT_MS || "240000", 10,
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

  let markedBuffer;
  try {
    markedBuffer = await editImage(prompt, overlayInputMap, {
      imageSize: "1K",
      logStep: `Step 3.2 overlay batch ${batchIndex}`,
      requestTimeoutMs: IMAGE_EDIT_TIMEOUT_MS,
    });
  } catch (e) {
    console.warn(`[Step 3.2] Batch ${batchIndex}: overlay generation failed (${e.message}), returning empty batch`);
    return { batchIndex, detectedElements: [] };
  }
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
    detectedElements.forEach((el) => {
      console.log(
        `[Step 3.2]   ${el.id}: (${el.topLeft.x},${el.topLeft.y}) -> (${el.bottomRight.x},${el.bottomRight.y})`,
      );
    });
  }

  return { batchIndex, detectedElements };
}

// ─── Main export ────────────────────────────────────────────────────────────

/**
 * Locate interactive elements on the map using Nano Banana color overlays + image diff,
 * then run a single Gemini Pro confirmation pass to drop clearly wrong elements.
 * @param {Buffer} compressedBuffer - compressed map PNG
 * @param {object} worldDesign
 * @param {string} userPrompt
 * @param {(name: string, data: any) => void} save
 * @returns {{ elements: object[], annotatedImage: Buffer, reviewPassed: boolean, attempts: number, droppedElementIds: string[] }}
 */
export async function locateElements(compressedBuffer, worldDesign, userPrompt, save) {
  const preparedElements = prepareInteractiveElements(worldDesign);
  if (preparedElements.length === 0) {
    console.log("[Step 3.2] No interactive elements for this world; skipping localization.");
    return {
      elements: [],
      annotatedImage: compressedBuffer,
      reviewPassed: true,
      attempts: 0,
      droppedElementIds: [],
    };
  }

  const elements = JSON.parse(JSON.stringify(preparedElements));
  const mapDescription = worldDesign.mapDescription || userPrompt;

  const MAX_RETRIES = parseInt(
    process.env.STEP3_2_MAX_RETRIES || process.env.STEP3_MAX_RETRIES || "2", 10,
  );
  const TOTAL_ATTEMPTS = Math.max(1, MAX_RETRIES + 1);
  const CONFIRM_TIMEOUT_MS = parseInt(
    process.env.STEP3_2_CONFIRM_TIMEOUT_MS || process.env.STEP3_CONFIRM_TIMEOUT_MS || "90000", 10,
  );
  const { width: imageWidth, height: imageHeight } = await getImageSize(compressedBuffer);
  const overlayWorkingImage = await buildOverlayWorkingImage(compressedBuffer);
  if (overlayWorkingImage.resized) {
    console.log(
      `[Step 3.2] Using resized overlay working image ${overlayWorkingImage.width}x${overlayWorkingImage.height} (source ${imageWidth}x${imageHeight})`,
    );
  }

  let reviewPassed = false;
  let attemptsUsed = 0;
  let lastProblematicIds = [];
  let additionalConstraints = "";

  for (let attempt = 1; attempt <= TOTAL_ATTEMPTS; attempt++) {
    const pendingElements = elements.filter((e) => !e.topLeft || !e.bottomRight);
    if (pendingElements.length === 0) break;

    attemptsUsed = attempt;
    console.log(
      `[Step 3.2] Attempt ${attempt}/${TOTAL_ATTEMPTS}: locating ${pendingElements.length} element(s) via color overlay...`,
    );

    // ── Phase A: Vision bbox first, then Nano Banana overlay for remaining elements ──
    let elementsForOverlay = pendingElements;
    const visionFirst = process.env.STEP3_2_VISION_BBOX_FIRST !== "0";
    if (visionFirst) {
      console.log(
        `[Step 3.2] Attempt ${attempt}: using Vision bbox first for ${pendingElements.length} pending element(s)...`,
      );
      const visionElements = await locateElementsWithVision({
        elements: pendingElements,
        userPrompt,
        mapDescription,
        imageBuffer: compressedBuffer,
        imageWidth,
        imageHeight,
        logStep: `Step 3.2 vision bbox first attempt ${attempt}`,
        additionalConstraints,
      });
      const visionMap = new Map(visionElements.map((d) => [d.id, d]));
      for (const element of elements) {
        if ((!element.topLeft || !element.bottomRight) && visionMap.has(element.id)) {
          const d = visionMap.get(element.id);
          element.topLeft = d.topLeft;
          element.bottomRight = d.bottomRight;
        }
      }
      if (visionElements.length > 0) {
        console.log(`[Step 3.2] Attempt ${attempt}: Vision bbox first located ${visionElements.length} element(s)`);
      }
      elementsForOverlay = elements.filter((e) => !e.topLeft || !e.bottomRight);
    }

    const batches = chunkArray(elementsForOverlay, MAX_BATCH_SIZE);
    console.log(`[Step 3.2] Split into ${batches.length} batch(es), max ${MAX_BATCH_SIZE} per batch`);

    const attemptSave = attempt === 1
      ? save
      : (name, data) => save(name.replace(/\.png$/, `-a${attempt}.png`), data);

    const batchResults = batches.length === 0
      ? []
      : await Promise.all(
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

    const detectedElements = batchResults.flatMap((r) => r.detectedElements);
    const detectedMap = new Map(detectedElements.map((d) => [d.id, d]));

    for (const element of elements) {
      if ((!element.topLeft || !element.bottomRight) && detectedMap.has(element.id)) {
        const d = detectedMap.get(element.id);
        element.topLeft = d.topLeft;
        element.bottomRight = d.bottomRight;
      }
    }

    const missingAfterOverlay = elements.filter((e) => !e.topLeft || !e.bottomRight);
    if (missingAfterOverlay.length > 0) {
      console.log(
        `[Step 3.2] Attempt ${attempt}: using Vision bbox fallback for ${missingAfterOverlay.length} missing element(s)...`,
      );
      const fallbackElements = await locateElementsWithVision({
        elements: missingAfterOverlay,
        userPrompt,
        mapDescription,
        imageBuffer: compressedBuffer,
        imageWidth,
        imageHeight,
        logStep: `Step 3.2 vision bbox fallback attempt ${attempt}`,
        additionalConstraints,
      });
      const fallbackMap = new Map(fallbackElements.map((d) => [d.id, d]));
      for (const element of elements) {
        if ((!element.topLeft || !element.bottomRight) && fallbackMap.has(element.id)) {
          const d = fallbackMap.get(element.id);
          element.topLeft = d.topLeft;
          element.bottomRight = d.bottomRight;
        }
      }
      if (fallbackElements.length > 0) {
        console.log(`[Step 3.2] Attempt ${attempt}: Vision bbox fallback located ${fallbackElements.length} element(s)`);
      }
    }

    const locatedElements = elements.filter((e) => e.topLeft && e.bottomRight);
    const stillMissingIds = elements
      .filter((e) => !e.topLeft || !e.bottomRight)
      .map((e) => e.id);

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

    // ── Phase B: Draw annotated image for confirmation ──
    const boxes = buildElementBoxes(locatedElements);
    const annotatedImage = await drawBoundingBoxes(compressedBuffer, boxes, ELEMENT_BOX_STYLE);
    save(`03.2-elements-attempt-${attempt}.png`, annotatedImage);

    // ── Phase C: Gemini Pro confirmation pass ──
    const elementsList = locatedElements
      .map((e) => {
        const lines = [`- ${e.id}: ${e.name} (${e.topLeft.x},${e.topLeft.y})→(${e.bottomRight.x},${e.bottomRight.y})`];
        if (e.visualDescription) lines.push(`  外观：${e.visualDescription}`);
        if (e.placementHint) lines.push(`  位置提示：${e.placementHint}`);
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
      confirmResult = parseJsonObject(raw);
    } catch (e) {
      console.warn(
        `[Step 3.2] Attempt ${attempt}: confirmation call failed (keeping all detected elements): ${e.message}`,
      );
      confirmResult = { pass: true, problematic_element_ids: [] };
    }

    const allowVisionBoxAdjust = process.env.STEP3_ALLOW_VISION_BBOX_ADJUST !== "0";
    const suggestedBoxes = confirmResult.suggested_boxes || confirmResult.suggested_element_boxes || {};
    let problematicIds = confirmResult.problematic_element_ids || [];
    if (allowVisionBoxAdjust && problematicIds.length > 0 && suggestedBoxes && typeof suggestedBoxes === "object") {
      const adjustedIds = [];
      for (const id of problematicIds) {
        const nextBox = normalizeSuggestedBox(suggestedBoxes[id], imageWidth, imageHeight);
        const element = elements.find((candidate) => candidate.id === id);
        if (!nextBox || !element) continue;
        element.topLeft = nextBox.topLeft;
        element.bottomRight = nextBox.bottomRight;
        adjustedIds.push(id);
      }
      if (adjustedIds.length > 0) {
        console.log(`[Step 3.2] Attempt ${attempt}: applied Vision box adjustment(s): ${adjustedIds.join(", ")}`);
        problematicIds = problematicIds.filter((id) => !adjustedIds.includes(id));
      }
    }
    lastProblematicIds = problematicIds;

    if (confirmResult.pass) {
      console.log(`[Step 3.2] Attempt ${attempt}: confirmation passed — all detected elements accepted.`);
      reviewPassed = true;
      break;
    }

    if (problematicIds.length === 0) {
      console.log(`[Step 3.2] Attempt ${attempt}: confirmation issues resolved by box adjustment.`);
      reviewPassed = true;
      break;
    }

    console.log(
      `[Step 3.2] Attempt ${attempt}: flagged ${problematicIds.length} problematic element(s): ${problematicIds.join(", ")}`,
    );

    // Accumulate review feedback as constraints for next overlay attempt
    const feedback = confirmResult.feedback || {};
    const feedbackLines = problematicIds
      .filter((id) => feedback[id])
      .map((id) => `- ${id}：${feedback[id]}`);
    if (feedbackLines.length > 0) {
      additionalConstraints +=
        `\n## 上一次标注审查反馈（请特别注意）\n以下元素上次标注有误，请修正：\n${feedbackLines.join("\n")}\n`;
      console.log(`[Step 3.2] Accumulated constraints for next attempt: ${feedbackLines.join("; ")}`);
    }

    // Clear problematic boxes.
    // On retry: they become pending again and will be re-detected next attempt.
    // On the final attempt: they stay cleared and are dropped (existing behavior).
    if (problematicIds.length > 0) {
      for (const element of elements) {
        if (problematicIds.includes(element.id)) {
          element.topLeft = undefined;
          element.bottomRight = undefined;
        }
      }
    }
  }

  const finalElements = elements.filter((e) => e.topLeft && e.bottomRight);
  const droppedElementIds = elements
    .filter((e) => !e.topLeft || !e.bottomRight)
    .map((e) => e.id);

  let finalAnnotatedImage = compressedBuffer;
  if (finalElements.length > 0) {
    const finalBoxes = buildElementBoxes(finalElements);
    finalAnnotatedImage = await drawBoundingBoxes(compressedBuffer, finalBoxes, ELEMENT_BOX_STYLE);
  }

  if (!reviewPassed && lastProblematicIds.length > 0) {
    console.log(
      `[Step 3.2] Retries exhausted; dropped ${lastProblematicIds.length} problematic element(s): ${lastProblematicIds.join(", ")}`,
    );
  }

  return {
    elements: finalElements,
    annotatedImage: finalAnnotatedImage,
    reviewPassed,
    attempts: attemptsUsed,
    droppedElementIds,
  };
}

/**
 * Scale element coordinates from compressed to original resolution.
 */
export function scaleElements(elements, origWidth, compressedWidth) {
  const ratio = origWidth / compressedWidth;
  return elements
    .filter((e) => e.topLeft && e.bottomRight)
    .map((e) => ({
      ...e,
      topLeft: {
        x: Math.round(e.topLeft.x * ratio),
        y: Math.round(e.topLeft.y * ratio),
      },
      bottomRight: {
        x: Math.round(e.bottomRight.x * ratio),
        y: Math.round(e.bottomRight.y * ratio),
      },
    }));
}
