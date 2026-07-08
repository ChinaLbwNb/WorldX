import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";
import { evaluatePredictions } from "./bbox-metrics.mjs";

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

function round(value, digits = 6) {
  return value === null || value === undefined ? value : Number(value.toFixed(digits));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.gold || !args.pred) {
    throw new Error("Usage: node evaluate-bbox.mjs --gold ground-truth.json --pred predictions.json [--out metrics.json]");
  }

  const gold = JSON.parse(readFileSync(resolve(args.gold), "utf-8"));
  const predictions = JSON.parse(readFileSync(resolve(args.pred), "utf-8"));
  const result = evaluatePredictions(gold, predictions);

  const output = {
    ...result,
    missingRate: round(result.missingRate),
    meanIoUAll: round(result.meanIoUAll),
    meanIoULocated: round(result.meanIoULocated),
    meanNCEAll: round(result.meanNCEAll),
    meanNCELocated: round(result.meanNCELocated),
    recallAt03: round(result.recallAt03),
    recallAt05: round(result.recallAt05),
    rows: result.rows.map((row) => ({
      ...row,
      iou: round(row.iou),
      nce: round(row.nce),
    })),
  };

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`[BBoxEval] wrote metrics to ${outPath}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main().catch((error) => {
  console.error(`[BBoxEval] ${error.stack || error.message}`);
  process.exit(1);
});
