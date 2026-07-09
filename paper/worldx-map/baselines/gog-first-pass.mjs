import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

const {
  COLOR_SPECS,
  MAX_BATCH_SIZE,
  chunkArray,
  extractRegionBoxesFromMarkedImage,
} = await import("../../../generators/map/src/utils/overlay-extraction.mjs");
const { getImageSize } = await import("../../../generators/map/src/utils/image-utils.mjs");

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

async function extractBatches({ originalBuffer, items, filePrefix, runDir, sourceFiles }) {
  const detected = [];
  const batches = chunkArray(items, MAX_BATCH_SIZE);

  for (let index = 0; index < batches.length; index++) {
    const overlayPath = join(runDir, `${filePrefix}${index + 1}.png`);
    if (!existsSync(overlayPath)) {
      console.warn(`[GOG] missing first-pass overlay: ${overlayPath}`);
      continue;
    }

    const batch = batches[index];
    const colorAssignments = batch.map((item, colorIndex) => ({
      region: item,
      color: COLOR_SPECS[colorIndex],
    }));
    const markedBuffer = readFileSync(overlayPath);
    const batchDetected = await extractRegionBoxesFromMarkedImage(
      originalBuffer,
      markedBuffer,
      colorAssignments,
    );
    detected.push(...batchDetected);
    sourceFiles.push(overlayPath);
  }

  return detected;
}

function toBBox(item) {
  if (!item?.topLeft || !item?.bottomRight) return null;
  return {
    x1: item.topLeft.x,
    y1: item.topLeft.y,
    x2: item.bottomRight.x,
    y2: item.bottomRight.y,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.run || !args["world-design"] || !args.out) {
    throw new Error("Usage: node gog-first-pass.mjs --run map-run-dir --world-design world-design.json --out predictions.json [--map-id P01]");
  }

  const runDir = resolve(args.run);
  const worldDesignPath = resolve(args["world-design"]);
  const outPath = resolve(args.out);
  const compressedMapPath = join(runDir, "02-compressed-map.png");
  if (!existsSync(compressedMapPath)) throw new Error(`Missing compressed map: ${compressedMapPath}`);

  const originalBuffer = readFileSync(compressedMapPath);
  const worldDesign = JSON.parse(readFileSync(worldDesignPath, "utf-8"));
  const regions = Array.isArray(worldDesign.regions) ? worldDesign.regions : [];
  const elements = Array.isArray(worldDesign.interactiveElements) ? worldDesign.interactiveElements : [];
  const sourceFiles = [];

  const detectedRegions = await extractBatches({
    originalBuffer,
    items: regions,
    filePrefix: "03-overlay-batch-",
    runDir,
    sourceFiles,
  });
  const detectedElements = await extractBatches({
    originalBuffer,
    items: elements,
    filePrefix: "03.2-overlay-batch-",
    runDir,
    sourceFiles,
  });

  const detectedById = new Map(
    [...detectedRegions, ...detectedElements].map((item) => [String(item.id), item]),
  );
  const allTargets = [
    ...regions.map((item) => ({ ...item, type: "region" })),
    ...elements.map((item) => ({ ...item, type: "element" })),
  ];
  const targets = allTargets.map((target) => {
    const detected = detectedById.get(String(target.id));
    const bbox = toBBox(detected);
    return {
      id: target.id,
      type: target.type,
      status: bbox ? "located" : "missing",
      bbox,
    };
  });

  const { width, height } = await getImageSize(originalBuffer);
  const output = {
    schemaVersion: "1.0",
    method: "GOG",
    stage: "first_pass_pre_verification",
    mapId: args["map-id"] || null,
    image: compressedMapPath,
    imageWidth: width,
    imageHeight: height,
    targets,
    sourceFiles,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[GOG] wrote ${targets.length} first-pass predictions to ${outPath}`);
}

main().catch((error) => {
  console.error(`[GOG] ${error.stack || error.message}`);
  process.exit(1);
});
