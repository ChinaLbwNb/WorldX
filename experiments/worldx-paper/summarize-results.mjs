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

function mean(values) {
  const clean = values.filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function percentile(values, p) {
  const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(p * clean.length) - 1));
  return clean[index];
}

function rate(values) {
  return values.length ? values.filter(Boolean).length / values.length : null;
}

const args = parseArgs(process.argv);
const input = path.resolve(args.input || "runs.jsonl");
const output = path.resolve(args.output || path.join(path.dirname(input), "summary.json"));
const rows = fs.readFileSync(input, "utf-8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
const completed = rows.filter((row) => !row.dryRun);

const stageNames = ["worldDesign", "map", "characters", "grounding", "config", "runtimeReady"];
const stageSuccess = Object.fromEntries(stageNames.map((name) => [
  name,
  rate(completed.map((row) => Boolean(row.validation?.stage?.[name]))),
]));

const summary = {
  runs: completed.length,
  processSuccessRate: rate(completed.map((row) => row.processSucceeded === true)),
  e2eExecutableSuccessRate: rate(completed.map((row) => row.e2eExecutable === true)),
  stageSuccess,
  latencyMs: {
    mean: mean(completed.map((row) => row.durationMs)),
    p95: percentile(completed.map((row) => row.durationMs), 0.95),
  },
  retention: {
    characters: mean(completed.map((row) => row.validation?.retention?.characterConfigRatio)),
    regions: mean(completed.map((row) => row.validation?.retention?.regionRatio)),
    elements: mean(completed.map((row) => row.validation?.retention?.elementRatio)),
  },
  spatial: {
    walkableRatio: mean(completed.map((row) => row.validation?.spatial?.walkableRatio)),
    reachableWalkableRatio: mean(completed.map((row) => row.validation?.spatial?.reachableWalkableRatio)),
    reachableRegionRatio: mean(completed.map((row) => row.validation?.spatial?.reachableRegionRatio)),
    reachableElementRatio: mean(completed.map((row) => row.validation?.spatial?.reachableElementRatio)),
  },
  byDomain: {},
};

for (const domain of [...new Set(completed.map((row) => row.domain))].sort()) {
  const subset = completed.filter((row) => row.domain === domain);
  summary.byDomain[domain] = {
    runs: subset.length,
    processSuccessRate: rate(subset.map((row) => row.processSucceeded === true)),
    e2eExecutableSuccessRate: rate(subset.map((row) => row.e2eExecutable === true)),
    latencyMeanMs: mean(subset.map((row) => row.durationMs)),
  };
}

fs.writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");
console.log(JSON.stringify(summary, null, 2));
