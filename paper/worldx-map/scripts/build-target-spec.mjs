import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
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

function targetFrom(item, type) {
  return {
    id: item.id,
    name: item.name || item.id,
    type,
    description: item.description || "",
    visualDescription: item.visualDescription || "",
    placementHint: item.placementHint || "",
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args["world-dir"] || !args["map-id"] || !args.out) {
    throw new Error("Usage: node build-target-spec.mjs --world-dir output/worlds/<world> --map-id P01 --out targets.json");
  }

  const worldDir = resolve(args["world-dir"]);
  const designPath = join(worldDir, "world-design.json");
  const imagePath = join(worldDir, "map/02-compressed-map.png");
  if (!existsSync(designPath)) throw new Error(`Missing world design: ${designPath}`);
  if (!existsSync(imagePath)) throw new Error(`Missing compressed map: ${imagePath}`);

  const worldDesign = JSON.parse(readFileSync(designPath, "utf-8"));
  const imageBuffer = readFileSync(imagePath);
  const { width, height } = await getImageSize(imageBuffer);
  const targets = [
    ...(worldDesign.regions || []).map((item) => targetFrom(item, "region")),
    ...(worldDesign.interactiveElements || []).map((item) => targetFrom(item, "element")),
  ];

  const output = {
    schemaVersion: "1.0",
    mapId: args["map-id"],
    worldDir: relative(ROOT, worldDir),
    image: relative(ROOT, imagePath),
    imageWidth: width,
    imageHeight: height,
    targets,
  };
  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[TargetSpec] ${args["map-id"]}: ${targets.length} targets -> ${outPath}`);
}

main().catch((error) => {
  console.error(`[TargetSpec] ${error.stack || error.message}`);
  process.exit(1);
});
