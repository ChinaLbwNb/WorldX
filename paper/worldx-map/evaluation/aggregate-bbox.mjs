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

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function round(value, digits = 6) {
  return value === null ? null : Number(value.toFixed(digits));
}

function summarize(method, files) {
  const rows = files.flatMap((file) => file.rows || []);
  const locatedRows = rows.filter((row) => row.located);
  const targetCount = rows.length;
  const locatedCount = locatedRows.length;
  return {
    method,
    maps: files.length,
    targetCount,
    locatedCount,
    missingCount: targetCount - locatedCount,
    missingRate: round(targetCount ? (targetCount - locatedCount) / targetCount : null),
    meanIoUAll: round(mean(rows.map((row) => Number(row.iou)))),
    meanIoULocated: round(mean(locatedRows.map((row) => Number(row.iou)))),
    meanNCEAll: round(mean(rows.map((row) => Number(row.nce)))),
    meanNCELocated: round(mean(locatedRows.map((row) => Number(row.nce)))),
    recallAt03: round(mean(rows.map((row) => Number(row.recallAt03)))),
    recallAt05: round(mean(rows.map((row) => Number(row.recallAt05)))),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.files) {
    throw new Error("Usage: node aggregate-bbox.mjs --files metrics1.json,metrics2.json [--out summary.json]");
  }

  const paths = args.files.split(",").map((item) => item.trim()).filter(Boolean);
  const metrics = paths.map((path) => JSON.parse(readFileSync(resolve(path), "utf-8")));
  const byMethod = new Map();
  for (const metric of metrics) {
    const method = metric.method || "unknown";
    if (!byMethod.has(method)) byMethod.set(method, []);
    byMethod.get(method).push(metric);
  }

  const output = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    methods: [...byMethod.entries()].map(([method, files]) => summarize(method, files)),
  };

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`[BBoxAggregate] wrote summary to ${outPath}`);
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

main().catch((error) => {
  console.error(`[BBoxAggregate] ${error.stack || error.message}`);
  process.exit(1);
});
