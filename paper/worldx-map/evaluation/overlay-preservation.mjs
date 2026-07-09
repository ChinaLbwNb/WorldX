import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

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

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function dilateBox(box, width, height, ratio = 0.05) {
  const bw = Math.max(0, box.x2 - box.x1);
  const bh = Math.max(0, box.y2 - box.y1);
  const dx = bw * ratio;
  const dy = bh * ratio;
  return {
    x1: clamp(Math.floor(box.x1 - dx), 0, width),
    y1: clamp(Math.floor(box.y1 - dy), 0, height),
    x2: clamp(Math.ceil(box.x2 + dx), 0, width),
    y2: clamp(Math.ceil(box.y2 + dy), 0, height),
  };
}

function insideAnyBox(x, y, boxes) {
  return boxes.some((box) => x >= box.x1 && x < box.x2 && y >= box.y1 && y < box.y2);
}

/**
 * Compute unintended change outside human target boxes.
 * originalRgb and overlayRgb are flat RGB/RGBA byte arrays with equal dimensions.
 */
export function computeOverlayPreservation({
  originalRgb,
  overlayRgb,
  width,
  height,
  channels,
  excludedBoxes = [],
  changeThreshold = 12,
}) {
  if (![3, 4].includes(channels)) throw new Error("channels must be 3 or 4");
  const expected = width * height * channels;
  if (originalRgb.length !== expected || overlayRgb.length !== expected) {
    throw new Error("buffer length does not match width/height/channels");
  }

  let outsidePixels = 0;
  let changedOutsidePixels = 0;
  let absoluteChangeSum = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (insideAnyBox(x, y, excludedBoxes)) continue;
      const index = (y * width + x) * channels;
      const dr = Number(overlayRgb[index]) - Number(originalRgb[index]);
      const dg = Number(overlayRgb[index + 1]) - Number(originalRgb[index + 1]);
      const db = Number(overlayRgb[index + 2]) - Number(originalRgb[index + 2]);
      const magnitude = Math.hypot(dr, dg, db);
      outsidePixels++;
      if (magnitude >= changeThreshold) changedOutsidePixels++;
      absoluteChangeSum += Math.abs(dr) + Math.abs(dg) + Math.abs(db);
    }
  }

  return {
    outsidePixels,
    changedOutsidePixels,
    outsideTargetChangeRate: outsidePixels > 0 ? changedOutsidePixels / outsidePixels : null,
    outsideTargetMeanAbsoluteChange: outsidePixels > 0
      ? absoluteChangeSum / (outsidePixels * 3)
      : null,
  };
}

function selectBatchTargetIds(targetSpec, targetType, batchIndex, batchSize = 4) {
  const targets = (targetSpec.targets || []).filter((target) => target.type === targetType);
  const start = (batchIndex - 1) * batchSize;
  return targets.slice(start, start + batchSize).map((target) => String(target.id));
}

async function loadAlignedRaw(originalPath, overlayPath) {
  const sharp = (await import("sharp")).default;
  const overlayMeta = await sharp(overlayPath).metadata();
  const width = overlayMeta.width;
  const height = overlayMeta.height;
  if (!width || !height) throw new Error("Unable to read overlay image dimensions");

  const original = await sharp(originalPath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  const overlay = await sharp(overlayPath)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();
  return { original, overlay, width, height, channels: 3 };
}

function round(value, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.original || !args.overlay || !args.gold || !args.targets || !args.type || !args["batch-index"]) {
    throw new Error(
      "Usage: node overlay-preservation.mjs --original map.png --overlay overlay.png --gold gold.json --targets targets.json --type region|element --batch-index 1 [--out metrics.json]",
    );
  }

  const targetType = args.type;
  if (!new Set(["region", "element"]).has(targetType)) {
    throw new Error("--type must be region or element");
  }
  const batchIndex = Number(args["batch-index"]);
  if (!Number.isInteger(batchIndex) || batchIndex < 1) throw new Error("--batch-index must be >= 1");

  const gold = JSON.parse(readFileSync(resolve(args.gold), "utf-8"));
  const targetSpec = JSON.parse(readFileSync(resolve(args.targets), "utf-8"));
  const targetIds = selectBatchTargetIds(targetSpec, targetType, batchIndex, 4);
  if (targetIds.length === 0) throw new Error("Selected overlay batch has no targets");

  const { original, overlay, width, height, channels } = await loadAlignedRaw(
    resolve(args.original),
    resolve(args.overlay),
  );

  const sourceWidth = Number(gold.imageWidth || targetSpec.imageWidth || width);
  const sourceHeight = Number(gold.imageHeight || targetSpec.imageHeight || height);
  const scaleX = width / sourceWidth;
  const scaleY = height / sourceHeight;
  const targetSet = new Set(targetIds);
  const excludedBoxes = (gold.targets || [])
    .filter((target) => targetSet.has(String(target.id)) && target.present === true && target.bbox)
    .map((target) => ({
      x1: target.bbox.x1 * scaleX,
      y1: target.bbox.y1 * scaleY,
      x2: target.bbox.x2 * scaleX,
      y2: target.bbox.y2 * scaleY,
    }))
    .map((box) => dilateBox(box, width, height, 0.05));

  const result = computeOverlayPreservation({
    originalRgb: original,
    overlayRgb: overlay,
    width,
    height,
    channels,
    excludedBoxes,
    changeThreshold: Number(args.threshold || 12),
  });

  const output = {
    schemaVersion: "1.0",
    mapId: gold.mapId || targetSpec.mapId || null,
    targetType,
    batchIndex,
    targetIds,
    excludedPresentTargetIds: (gold.targets || [])
      .filter((target) => targetSet.has(String(target.id)) && target.present === true && target.bbox)
      .map((target) => target.id),
    imageWidth: width,
    imageHeight: height,
    changeThreshold: Number(args.threshold || 12),
    outsidePixels: result.outsidePixels,
    changedOutsidePixels: result.changedOutsidePixels,
    outsideTargetChangeRate: round(result.outsideTargetChangeRate),
    outsideTargetMeanAbsoluteChange: round(result.outsideTargetMeanAbsoluteChange),
  };

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`[OverlayPreservation] wrote metrics to ${outPath}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

const isDirectRun = process.argv[1]
  ? resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
  : false;

if (isDirectRun) {
  main().catch((error) => {
    console.error(`[OverlayPreservation] ${error.stack || error.message}`);
    process.exit(1);
  });
}
