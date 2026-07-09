import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.targets || !args.out) {
    throw new Error("Usage: node init-gold.mjs --targets targets.json --out gold.json [--annotator A1]");
  }

  const targetSpec = JSON.parse(readFileSync(resolve(args.targets), "utf-8"));
  const output = {
    schemaVersion: "1.0",
    mapId: targetSpec.mapId,
    imageWidth: targetSpec.imageWidth,
    imageHeight: targetSpec.imageHeight,
    image: targetSpec.image,
    annotatorId: args.annotator || "UNASSIGNED",
    annotationStatus: "pending",
    targets: (targetSpec.targets || []).map((target) => ({
      id: target.id,
      type: target.type,
      present: null,
      bbox: null,
      confidence: null,
      note: "",
    })),
  };

  const outPath = resolve(args.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`[GoldInit] ${output.targets.length} targets -> ${outPath}`);
}

main().catch((error) => {
  console.error(`[GoldInit] ${error.stack || error.message}`);
  process.exit(1);
});
