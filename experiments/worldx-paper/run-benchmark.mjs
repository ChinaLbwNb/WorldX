import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateWorld } from "./lib/validate-world.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readPrompts(file) {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!Array.isArray(parsed)) throw new Error("prompt benchmark must be a JSON array");
  return parsed.map((item, index) => {
    if (typeof item === "string") return { id: `prompt_${index + 1}`, domain: "unspecified", prompt: item };
    if (!item || typeof item.prompt !== "string" || !item.prompt.trim()) {
      throw new Error(`invalid prompt item at index ${index}`);
    }
    return {
      id: String(item.id || `prompt_${index + 1}`),
      domain: String(item.domain || "unspecified"),
      prompt: item.prompt.trim(),
    };
  });
}

function listWorldDirs(root) {
  if (!fs.existsSync(root)) return new Set();
  return new Set(fs.readdirSync(root)
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory()));
}

function detectNewWorldDir(worldRoot, before, stdout) {
  const after = listWorldDirs(worldRoot);
  const created = [...after].filter((name) => !before.has(name));
  if (created.length === 1) return path.join(worldRoot, created[0]);
  const match = stdout.match(/World ID:\s*(\S+)/);
  if (match) {
    const candidate = path.join(worldRoot, match[1]);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (created.length > 1) {
    created.sort((a, b) => fs.statSync(path.join(worldRoot, b)).mtimeMs - fs.statSync(path.join(worldRoot, a)).mtimeMs);
    return path.join(worldRoot, created[0]);
  }
  return null;
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); process.stderr.write(chunk); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

function appendJsonl(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf-8");
}

const args = parseArgs(process.argv);
const promptsFile = path.resolve(args.prompts || path.join(__dirname, "benchmark-prompts.v0.json"));
const outDir = path.resolve(args.out || path.join(__dirname, "results", new Date().toISOString().replace(/[:.]/g, "-")));
const worldRoot = path.resolve(args.worldRoot || path.join(REPO_ROOT, "output", "worlds"));
const timeoutMs = Number.parseInt(String(args.timeoutMs || "1800000"), 10);
const limit = args.limit ? Number.parseInt(String(args.limit), 10) : null;
const dryRun = args["dry-run"] === true;

fs.mkdirSync(outDir, { recursive: true });
const allPrompts = readPrompts(promptsFile);
const prompts = limit ? allPrompts.slice(0, limit) : allPrompts;
const jsonlPath = path.join(outDir, "runs.jsonl");

console.log(`[Experiment] prompts=${prompts.length} out=${outDir}`);

for (let index = 0; index < prompts.length; index += 1) {
  const item = prompts[index];
  console.log(`\n[Experiment] ${index + 1}/${prompts.length} ${item.id} (${item.domain})`);
  if (dryRun) {
    const result = { id: item.id, domain: item.domain, prompt: item.prompt, dryRun: true };
    appendJsonl(jsonlPath, result);
    continue;
  }

  const before = listWorldDirs(worldRoot);
  const processResult = await runProcess(
    process.execPath,
    [path.join(REPO_ROOT, "orchestrator", "src", "index.mjs"), item.prompt],
    { cwd: REPO_ROOT, env: process.env, timeoutMs },
  );
  const worldDir = detectNewWorldDir(worldRoot, before, processResult.stdout);
  let validation = null;
  if (worldDir && fs.existsSync(worldDir)) {
    validation = validateWorld(worldDir);
  }

  const result = {
    id: item.id,
    domain: item.domain,
    prompt: item.prompt,
    exitCode: processResult.code,
    signal: processResult.signal,
    durationMs: processResult.durationMs,
    worldDir,
    validation,
    processSucceeded: processResult.code === 0,
    e2eExecutable: Boolean(validation?.e2eExecutable),
    timestamp: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(outDir, `${item.id}.json`), `${JSON.stringify(result, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(outDir, `${item.id}.stdout.log`), processResult.stdout, "utf-8");
  fs.writeFileSync(path.join(outDir, `${item.id}.stderr.log`), processResult.stderr, "utf-8");
  appendJsonl(jsonlPath, result);
}

console.log(`\n[Experiment] complete: ${jsonlPath}`);
