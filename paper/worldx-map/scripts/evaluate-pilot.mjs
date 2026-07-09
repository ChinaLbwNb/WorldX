import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { evaluatePredictions } from "../evaluation/bbox-metrics.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DEFAULT_RUNS = join(ROOT, "paper/worldx-map/runs");

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
  return value === null || value === undefined ? value : Number(value.toFixed(digits));
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function summarizeMethod(method, metrics) {
  const rows = metrics.flatMap((metric) => metric.rows || []);
  const absenceRows = metrics.flatMap((metric) => metric.absenceRows || []);
  const presenceRows = metrics.flatMap((metric) => metric.presenceRows || []);
  const located = rows.filter((row) => row.located);
  const absentFalsePositiveCount = absenceRows.filter((row) => row.falsePositive).length;
  return {
    method,
    maps: metrics.length,
    targetCount: rows.length,
    locatedCount: located.length,
    missingCount: rows.length - located.length,
    missingRate: round(rows.length ? (rows.length - located.length) / rows.length : null),
    meanIoUAll: round(mean(rows.map((row) => row.iou))),
    meanIoULocated: round(mean(located.map((row) => row.iou))),
    meanNCEAll: round(mean(rows.map((row) => row.nce))),
    meanNCELocated: round(mean(located.map((row) => row.nce))),
    recallAt03: round(mean(rows.map((row) => row.recallAt03))),
    recallAt05: round(mean(rows.map((row) => row.recallAt05))),
    absentTargetCount: absenceRows.length,
    absentFalsePositiveCount,
    absentFalsePositiveRate: round(
      absenceRows.length ? absentFalsePositiveCount / absenceRows.length : null,
    ),
    presenceAccuracy: round(mean(presenceRows.map((row) => row.correct))),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = resolve(args.runs || DEFAULT_RUNS);
  const ids = args.only
    ? args.only.split(",").map((item) => item.trim()).filter(Boolean)
    : Array.from({ length: 10 }, (_, index) => `P${String(index + 1).padStart(2, "0")}`);
  const methodFiles = {
    DirectCoord: "direct.json",
    GridCoord: "grid.json",
    GOG: "gog.json",
    "GOG-V": "gog-v.json",
  };
  const metricsByMethod = new Map();
  const skipped = [];

  for (const id of ids) {
    const mapDir = join(runsDir, id);
    const goldPath = join(mapDir, "gold.json");
    if (!existsSync(goldPath)) {
      skipped.push({ id, reason: "missing_gold" });
      continue;
    }
    const gold = JSON.parse(readFileSync(goldPath, "utf-8"));
    if (gold.annotationStatus !== "complete") {
      skipped.push({ id, reason: `gold_not_complete:${gold.annotationStatus || "unset"}` });
      continue;
    }

    for (const [method, filename] of Object.entries(methodFiles)) {
      const predPath = join(mapDir, filename);
      if (!existsSync(predPath)) {
        skipped.push({ id, method, reason: "missing_prediction" });
        continue;
      }
      const predictions = JSON.parse(readFileSync(predPath, "utf-8"));
      const metric = evaluatePredictions(gold, predictions);
      saveJson(join(mapDir, `${filename.replace(/\.json$/, "")}.metrics.json`), metric);
      if (!metricsByMethod.has(method)) metricsByMethod.set(method, []);
      metricsByMethod.get(method).push(metric);
    }
  }

  const output = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    mapsRequested: ids,
    methods: [...metricsByMethod.entries()].map(([method, metrics]) => summarizeMethod(method, metrics)),
    skipped,
  };
  const outPath = resolve(args.out || join(runsDir, "pilot-summary.json"));
  saveJson(outPath, output);
  console.log(`[PilotEval] summary -> ${outPath}`);
  console.log(JSON.stringify(output.methods, null, 2));
}

main().catch((error) => {
  console.error(`[PilotEval] ${error.stack || error.message}`);
  process.exit(1);
});
