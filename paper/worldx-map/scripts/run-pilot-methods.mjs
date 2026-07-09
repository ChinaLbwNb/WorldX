import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DEFAULT_MANIFEST = join(ROOT, "paper/worldx-map/runs/pilot-manifest.json");
const DEFAULT_EXECUTION = join(ROOT, "paper/worldx-map/runs/pilot-execution.json");

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

function runNode(script, args, label) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", rejectPromise);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${label} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}`));
    });
  });
}

function loadJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : fallback;
}

function saveJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = resolve(args.manifest || DEFAULT_MANIFEST);
  const executionPath = resolve(args.execution || DEFAULT_EXECUTION);
  const manifest = loadJson(manifestPath, null);
  if (!manifest) throw new Error(`Missing pilot manifest: ${manifestPath}`);

  const selectedIds = args.only
    ? new Set(args.only.split(",").map((item) => item.trim()).filter(Boolean))
    : null;
  const methods = new Set(
    (args.methods || "direct,grid,gog,gog-v").split(",").map((item) => item.trim()).filter(Boolean),
  );
  const allowed = new Set(["direct", "grid", "gog", "gog-v"]);
  for (const method of methods) {
    if (!allowed.has(method)) throw new Error(`Unknown method: ${method}`);
  }

  const execution = loadJson(executionPath, {
    schemaVersion: "1.0",
    createdAt: new Date().toISOString(),
    maps: {},
  });
  const continueOnError = args["continue-on-error"] === "1";

  for (const run of manifest.runs || []) {
    if (run.status !== "success" || !run.worldDir) continue;
    if (selectedIds && !selectedIds.has(run.id)) continue;

    const worldDir = resolve(ROOT, run.worldDir);
    const mapDir = join(worldDir, "map");
    const targetDir = join(ROOT, "paper/worldx-map/runs", run.id);
    const targetPath = join(targetDir, "targets.json");
    mkdirSync(targetDir, { recursive: true });

    if (!existsSync(targetPath) || args["rebuild-targets"] === "1") {
      await runNode(
        join(ROOT, "paper/worldx-map/scripts/build-target-spec.mjs"),
        ["--world-dir", worldDir, "--map-id", run.id, "--out", targetPath],
        `${run.id} target spec`,
      );
    }
    const targetSpec = JSON.parse(readFileSync(targetPath, "utf-8"));
    const imagePath = resolve(ROOT, targetSpec.image);
    const worldDesignPath = join(worldDir, "world-design.json");
    const logPath = join(worldDir, "logs/map-pipeline.log");

    execution.maps[run.id] ||= { worldDir: run.worldDir, methods: {} };

    const jobs = [];
    if (methods.has("direct")) {
      jobs.push({
        key: "DirectCoord",
        script: join(ROOT, "paper/worldx-map/baselines/direct-coord.mjs"),
        args: ["--image", imagePath, "--targets", targetPath, "--out", join(targetDir, "direct.json")],
      });
    }
    if (methods.has("grid")) {
      jobs.push({
        key: "GridCoord",
        script: join(ROOT, "paper/worldx-map/baselines/grid-coord.mjs"),
        args: [
          "--image", imagePath,
          "--targets", targetPath,
          "--grid-out", join(targetDir, "grid-overlay.png"),
          "--out", join(targetDir, "grid.json"),
        ],
      });
    }
    if (methods.has("gog")) {
      jobs.push({
        key: "GOG",
        script: join(ROOT, "paper/worldx-map/baselines/gog-first-pass.mjs"),
        args: [
          "--run", mapDir,
          "--world-design", worldDesignPath,
          "--map-id", run.id,
          "--out", join(targetDir, "gog.json"),
        ],
      });
    }
    if (methods.has("gog-v")) {
      const methodArgs = [
        "--run", mapDir,
        "--world-design", worldDesignPath,
        "--map-id", run.id,
        "--out", join(targetDir, "gog-v.json"),
      ];
      if (existsSync(logPath)) methodArgs.push("--log", logPath);
      jobs.push({
        key: "GOG-V",
        script: join(ROOT, "paper/worldx-map/baselines/gog-verified.mjs"),
        args: methodArgs,
      });
    }

    for (const job of jobs) {
      const previous = execution.maps[run.id].methods[job.key];
      if (previous?.status === "success" && args.resume !== "0") {
        console.log(`[PilotMethods] ${run.id} ${job.key} already succeeded; skipping`);
        continue;
      }

      const record = { status: "running", startedAt: new Date().toISOString() };
      execution.maps[run.id].methods[job.key] = record;
      saveJson(executionPath, execution);
      try {
        console.log(`\n[PilotMethods] ${run.id} -> ${job.key}`);
        await runNode(job.script, job.args, `${run.id} ${job.key}`);
        record.status = "success";
        record.completedAt = new Date().toISOString();
      } catch (error) {
        record.status = "failed";
        record.error = error.message;
        record.completedAt = new Date().toISOString();
        console.error(`[PilotMethods] ${run.id} ${job.key} failed: ${error.message}`);
        saveJson(executionPath, execution);
        if (!continueOnError) throw error;
      }
      saveJson(executionPath, execution);
    }
  }

  execution.updatedAt = new Date().toISOString();
  saveJson(executionPath, execution);
  console.log(`\n[PilotMethods] execution manifest: ${executionPath}`);
}

main().catch((error) => {
  console.error(`[PilotMethods] ${error.stack || error.message}`);
  process.exit(1);
});
