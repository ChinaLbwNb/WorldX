import dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { dirname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
dotenv.config({ path: join(ROOT, ".env") });

const WORLDS_DIR = join(ROOT, "output/worlds");
const DEFAULT_PROMPTS = join(ROOT, "paper/worldx-map/benchmark/pilot-prompts.json");
const DEFAULT_MANIFEST = join(ROOT, "paper/worldx-map/runs/pilot-manifest.json");
const PROTOCOL_PATH = join(ROOT, "paper/worldx-map/configs/rq2-pilot.json");

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

function listWorldDirs() {
  if (!existsSync(WORLDS_DIR)) return [];
  return readdirSync(WORLDS_DIR)
    .map((name) => ({ name, path: join(WORLDS_DIR, name) }))
    .filter((entry) => statSync(entry.path).isDirectory());
}

function readManifest(path) {
  if (!existsSync(path)) {
    return { schemaVersion: "1.0", createdAt: new Date().toISOString(), runs: [] };
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  manifest.updatedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(manifest, null, 2));
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

function buildProvenance() {
  const protocol = existsSync(PROTOCOL_PATH)
    ? JSON.parse(readFileSync(PROTOCOL_PATH, "utf-8"))
    : {};
  return {
    capturedAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    nodeVersion: process.version,
    protocolVersion: protocol.version || "unknown",
    models: {
      orchestrator: process.env.ORCHESTRATOR_MODEL || "",
      imageGeneration: process.env.IMAGE_GEN_MODEL || "",
      imageProvider: process.env.IMAGE_GEN_PROVIDER || "openai-compatible",
      vision: process.env.VISION_MODEL || "",
      simulation: process.env.SIMULATION_MODEL || "",
    },
  };
}

function runWorldGeneration(prompt, env) {
  const script = join(ROOT, "orchestrator/src/index.mjs");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, prompt], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`generation failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function detectCreatedWorld(beforeNames, startedMs) {
  const candidates = listWorldDirs()
    .filter((entry) => !beforeNames.has(entry.name))
    .map((entry) => ({ ...entry, mtimeMs: statSync(entry.path).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startedMs - 2000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates[0] || null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const promptsPath = resolve(args.prompts || DEFAULT_PROMPTS);
  const manifestPath = resolve(args.manifest || DEFAULT_MANIFEST);
  const promptSet = JSON.parse(readFileSync(promptsPath, "utf-8"));
  const selected = args.only
    ? new Set(args.only.split(",").map((item) => item.trim()).filter(Boolean))
    : null;
  const prompts = (promptSet.prompts || []).filter((item) => !selected || selected.has(item.id));
  if (prompts.length === 0) throw new Error("No pilot prompts selected");

  const manifest = readManifest(manifestPath);
  manifest.promptSetVersion = promptSet.version;
  manifest.promptSetPath = relative(ROOT, promptsPath);
  manifest.provenance ||= buildProvenance();
  const continueOnError = args["continue-on-error"] === "1";

  for (const item of prompts) {
    const previous = manifest.runs.find((run) => run.id === item.id);
    if (previous?.status === "success" && args.resume !== "0") {
      console.log(`[Pilot] ${item.id} already succeeded; skipping`);
      continue;
    }

    const beforeNames = new Set(listWorldDirs().map((entry) => entry.name));
    const startedAt = new Date().toISOString();
    const startedMs = Date.now();
    console.log(`\n[Pilot] ===== ${item.id} =====`);
    console.log(`[Pilot] ${item.prompt}`);

    const record = {
      id: item.id,
      language: item.language,
      theme: item.theme,
      topology: item.topology,
      complexity: item.complexity,
      prompt: item.prompt,
      startedAt,
      status: "running",
    };
    manifest.runs = manifest.runs.filter((run) => run.id !== item.id);
    manifest.runs.push(record);
    saveManifest(manifestPath, manifest);

    try {
      await runWorldGeneration(item.prompt, {
        ...process.env,
        KEEP_GENERATION_ARTIFACTS: "1",
      });
      const created = detectCreatedWorld(beforeNames, startedMs);
      if (!created) throw new Error("Generation exited successfully but no new world directory was detected");
      record.status = "success";
      record.worldDir = relative(ROOT, created.path);
      record.completedAt = new Date().toISOString();
      console.log(`[Pilot] ${item.id} -> ${record.worldDir}`);
    } catch (error) {
      record.status = "failed";
      record.error = error.message;
      record.completedAt = new Date().toISOString();
      console.error(`[Pilot] ${item.id} failed: ${error.message}`);
      saveManifest(manifestPath, manifest);
      if (!continueOnError) throw error;
    }

    saveManifest(manifestPath, manifest);
  }

  console.log(`\n[Pilot] manifest: ${manifestPath}`);
}

main().catch((error) => {
  console.error(`[Pilot] ${error.stack || error.message}`);
  process.exit(1);
});
