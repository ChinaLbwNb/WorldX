import dotenv from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

dotenv.config({ path: resolve(process.cwd(), ".env") });

const { geminiProVision } = await import("../../../generators/map/src/models/gemini-pro.mjs");
const { drawCoordinateGrid, getImageSize } = await import("../../../generators/map/src/utils/image-utils.mjs");
const { MAX_BATCH_SIZE, chunkArray } = await import("../../../generators/map/src/utils/overlay-extraction.mjs");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    i++;
  }
  return args;
}

function extractJson(text) {
  if (!text || !text.trim()) throw new Error("Empty model response");
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (!objectMatch) throw new Error(`No JSON object found: ${text.slice(0, 300)}`);
  return JSON.parse(objectMatch[0]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(Number(value))));
}

function normalizeBBox(raw, width, height) {
  if (!raw || typeof raw !== "object") return null;
  const x1 = raw.x1 ?? raw.left ?? raw.topLeft?.x;
  const y1 = raw.y1 ?? raw.top ?? raw.topLeft?.y;
  const x2 = raw.x2 ?? raw.right ?? raw.bottomRight?.x;
  const y2 = raw.y2 ?? raw.bottom ?? raw.bottomRight?.y;
  if (![x1, y1, x2, y2].every((v) => Number.isFinite(Number(v)))) return null;

  const box = {
    x1: clamp(Math.min(Number(x1), Number(x2)), 0, width),
    y1: clamp(Math.min(Number(y1), Number(y2)), 0, height),
    x2: clamp(Math.max(Number(x1), Number(x2)), 0, width),
    y2: clamp(Math.max(Number(y1), Number(y2)), 0, height),
  };
  if (box.x2 <= box.x1 || box.y2 <= box.y1) return null;
  return box;
}

function buildPrompt({ targets, width, height, mapDescription, targetType }) {
  const targetText = targets.map((target, index) => [
    `${index + 1}. id=${target.id}`,
    `   type=${target.type}`,
    `   name=${target.name || target.id}`,
    `   description=${target.description || ""}`,
    `   visualDescription=${target.visualDescription || ""}`,
    `   placementHint=${target.placementHint || ""}`,
  ].join("\n")).join("\n");

  return `You are evaluating spatial grounding on a generated top-down game map. The image has an artificial coordinate grid overlay added only to help estimate pixel locations. The grid labels are not part of the scene.\n\nMap description: ${mapDescription || "not provided"}\nImage size: ${width} x ${height} pixels.\nTarget group: ${targetType}.\n\nUse the visible coordinate grid to locate each requested target and return pixel-space bounding boxes. Do not use normalized 0-1 coordinates. Do not invent a target that is not visibly present. A region box should cover the visible functional footprint; an element box should tightly cover the visible object.\n\nTargets:\n${targetText}\n\nReturn JSON only:\n{\n  "targets": [\n    {"id": "target_id", "status": "located", "bbox": {"x1": 0, "y1": 0, "x2": 100, "y2": 100}},\n    {"id": "missing_id", "status": "missing", "bbox": null}\n  ]\n}\n\nEvery requested id must appear exactly once.`;
}

function buildBatches(targets) {
  const orderedTypes = ["region", "element"];
  const known = new Set(orderedTypes);
  const batches = [];
  for (const type of orderedTypes) {
    for (const items of chunkArray(targets.filter((target) => target.type === type), MAX_BATCH_SIZE)) {
      if (items.length) batches.push({ type, targets: items });
    }
  }
  const other = targets.filter((target) => !known.has(target.type));
  for (const items of chunkArray(other, MAX_BATCH_SIZE)) {
    if (items.length) batches.push({ type: "other", targets: items });
  }
  return batches;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.image || !args.targets || !args.out) {
    throw new Error("Usage: node grid-coord.mjs --image map.png --targets targets.json --out predictions.json [--grid-out grid.png]");
  }

  const imagePath = resolve(args.image);
  const targetPath = resolve(args.targets);
  const outPath = resolve(args.out);
  const imageBuffer = readFileSync(imagePath);
  const targetSpec = JSON.parse(readFileSync(targetPath, "utf-8"));
  const targets = Array.isArray(targetSpec.targets) ? targetSpec.targets : [];
  if (targets.length === 0) throw new Error("Target spec contains no targets");

  const { width, height } = await getImageSize(imageBuffer);
  const gridBuffer = await drawCoordinateGrid(imageBuffer);
  if (args["grid-out"]) {
    const gridOutPath = resolve(args["grid-out"]);
    mkdirSync(dirname(gridOutPath), { recursive: true });
    writeFileSync(gridOutPath, gridBuffer);
  }

  const batches = buildBatches(targets);
  const startedAt = new Date().toISOString();
  const rawResponses = [];
  const byId = new Map();

  for (let index = 0; index < batches.length; index++) {
    const batch = batches[index];
    const prompt = buildPrompt({
      targets: batch.targets,
      width,
      height,
      mapDescription: targetSpec.mapDescription || "",
      targetType: batch.type,
    });
    const rawResponse = await geminiProVision(prompt, [gridBuffer], {
      temperature: 0,
      logStep: `paper-rq2-grid-${targetSpec.mapId || "unknown"}-${batch.type}-${index + 1}`,
      requestTimeoutMs: Number(process.env.PAPER_VISION_TIMEOUT_MS || 180000),
    });
    const parsed = extractJson(rawResponse);
    for (const item of parsed.targets || []) byId.set(String(item.id), item);
    rawResponses.push({
      batchIndex: index + 1,
      targetType: batch.type,
      targetIds: batch.targets.map((target) => target.id),
      rawResponse,
    });
  }

  const predictions = targets.map((target) => {
    const item = byId.get(String(target.id));
    const bbox = normalizeBBox(item?.bbox, width, height);
    return {
      id: target.id,
      type: target.type,
      status: bbox ? "located" : "missing",
      bbox,
    };
  });

  const output = {
    schemaVersion: "1.0",
    method: "GridCoord",
    mapId: targetSpec.mapId || null,
    image: args.image,
    imageWidth: width,
    imageHeight: height,
    mapDescription: targetSpec.mapDescription || "",
    model: process.env.VISION_MODEL || "default",
    batchSize: MAX_BATCH_SIZE,
    batching: "type_separated",
    callCount: rawResponses.length,
    startedAt,
    completedAt: new Date().toISOString(),
    targets: predictions,
    rawResponses,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[GridCoord] wrote ${predictions.length} predictions from ${rawResponses.length} calls to ${outPath}`);
}

main().catch((error) => {
  console.error(`[GridCoord] ${error.stack || error.message}`);
  process.exit(1);
});
