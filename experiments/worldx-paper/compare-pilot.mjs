import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function rate(values) {
  return values.length ? values.filter(Boolean).length / values.length : null;
}

function metric(row, pathParts) {
  let value = row;
  for (const part of pathParts) value = value?.[part];
  return value;
}

const args = parseArgs(process.argv);
const pilotDir = path.resolve(args.pilot || ".");
const variants = [
  "full",
  "first_pass_no_repair",
  "no_map_structure_conditioning",
];
const rowsByVariant = Object.fromEntries(variants.map((variant) => [
  variant,
  readJsonl(path.join(pilotDir, variant, "runs.jsonl")).filter((row) => !row.dryRun),
]));

const summary = {};
for (const variant of variants) {
  const rows = rowsByVariant[variant];
  summary[variant] = {
    runs: rows.length,
    e2eExecutableSuccessRate: rate(rows.map((row) => row.e2eExecutable === true)),
    processSuccessRate: rate(rows.map((row) => row.processSucceeded === true)),
    latencyMeanMs: mean(rows.map((row) => row.durationMs)),
    regionRetentionMean: mean(rows.map((row) => metric(row, ["validation", "retention", "regionRatio"]))),
    elementRetentionMean: mean(rows.map((row) => metric(row, ["validation", "retention", "elementRatio"]))),
    reachableRegionMean: mean(rows.map((row) => metric(row, ["validation", "spatial", "reachableRegionRatio"]))),
    reachableElementMean: mean(rows.map((row) => metric(row, ["validation", "spatial", "reachableElementRatio"]))),
  };
}

const fullById = new Map(rowsByVariant.full.map((row) => [row.id, row]));
const matched = {};
for (const variant of variants.filter((name) => name !== "full")) {
  const pairs = rowsByVariant[variant]
    .map((row) => [fullById.get(row.id), row])
    .filter(([full, ablated]) => full && ablated);

  matched[variant] = {
    pairs: pairs.length,
    deltaE2E: mean(pairs.map(([full, ablated]) =>
      Number(ablated.e2eExecutable === true) - Number(full.e2eExecutable === true))),
    deltaLatencyMs: mean(pairs.map(([full, ablated]) => ablated.durationMs - full.durationMs)),
    deltaRegionRetention: mean(pairs.map(([full, ablated]) => {
      const a = metric(ablated, ["validation", "retention", "regionRatio"]);
      const f = metric(full, ["validation", "retention", "regionRatio"]);
      return Number.isFinite(a) && Number.isFinite(f) ? a - f : null;
    })),
    deltaReachableRegion: mean(pairs.map(([full, ablated]) => {
      const a = metric(ablated, ["validation", "spatial", "reachableRegionRatio"]);
      const f = metric(full, ["validation", "spatial", "reachableRegionRatio"]);
      return Number.isFinite(a) && Number.isFinite(f) ? a - f : null;
    })),
  };
}

const output = { pilotDir, summary, matched };
const outputFile = path.resolve(args.output || path.join(pilotDir, "comparison.json"));
fs.writeFileSync(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf-8");
console.log(JSON.stringify(output, null, 2));
