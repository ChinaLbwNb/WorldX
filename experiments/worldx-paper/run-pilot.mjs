import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");
const RUNNER = path.join(__dirname, "run-benchmark.mjs");
const PROMPTS = path.join(__dirname, "pilot-prompts.v0.json");
const VARIANTS = [
  "full",
  "first_pass_no_repair",
  "no_map_structure_conditioning",
];

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

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

const args = parseArgs(process.argv);
const pilotId = String(args.id || new Date().toISOString().replace(/[:.]/g, "-"));
const rootOut = path.resolve(args.out || path.join(__dirname, "pilot-results", pilotId));
const dryRun = args["dry-run"] === true;
const timeoutMs = String(args.timeoutMs || "1800000");

fs.mkdirSync(rootOut, { recursive: true });
fs.writeFileSync(path.join(rootOut, "pilot-manifest.json"), `${JSON.stringify({
  pilotId,
  prompts: PROMPTS,
  variants: VARIANTS,
  dryRun,
  startedAt: new Date().toISOString(),
}, null, 2)}\n`, "utf-8");

for (const variant of VARIANTS) {
  const variantOut = path.join(rootOut, variant);
  const runnerArgs = [
    RUNNER,
    "--prompts", PROMPTS,
    "--variant", variant,
    "--out", variantOut,
    "--timeoutMs", timeoutMs,
  ];
  if (dryRun) runnerArgs.push("--dry-run");

  console.log(`\n[Pilot] variant=${variant}`);
  const result = await run(process.execPath, runnerArgs, {
    cwd: REPO_ROOT,
    env: process.env,
  });

  if (result.code !== 0) {
    console.error(`[Pilot] variant failed: ${variant} code=${result.code} signal=${result.signal || ""}`);
    process.exit(result.code || 1);
  }
}

console.log(`\n[Pilot] complete: ${rootOut}`);
