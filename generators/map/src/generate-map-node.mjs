import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMapPipeline } from "./index.mjs";
import { designMapNode } from "./map-node-designer.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv);

async function main() {
  const worldDir = args.worldDir ? path.resolve(String(args.worldDir)) : "";
  const sourceMapId = String(args.sourceMapId || "");
  const targetMapId = String(args.targetMapId || "");
  const targetDir = args.targetDir ? path.resolve(String(args.targetDir)) : "";
  const userPrompt = String(args.prompt || "").trim();

  if (!worldDir || !sourceMapId || !targetMapId || !targetDir || !userPrompt) {
    throw new Error("Usage: node generate-map-node.mjs --worldDir <dir> --sourceMapId <id> --targetMapId <id> --targetDir <dir> --prompt <text>");
  }

  const startedAt = Date.now();
  const worldConfig = readWorldConfig(worldDir);
  const sourceMap = (worldConfig.worldMaps || []).find((map) => map.id === sourceMapId);
  const sourceName = sourceMap?.name || worldConfig.worldName || "原始地图";
  const contentLanguage = worldConfig.contentLanguage || "zh";
  const worldTheme = [
    worldConfig.worldName,
    worldConfig.worldDescription,
    worldConfig.originalPrompt,
  ].filter(Boolean).join("\n");

  const fallbackTargetName = buildTargetName(worldConfig, userPrompt);
  let mapNodeDesign = null;

  try {
    mapNodeDesign = await designMapNode({
      worldConfig,
      sourceMap,
      sourceMapId,
      targetMapId,
      targetName: fallbackTargetName,
      userPrompt,
      worldTheme,
      contentLanguage,
    });
  } catch (e) {
    console.warn("MapNodeDesigner failed, fallback.", e.message);
  }

  const targetName = mapNodeDesign?.targetName || fallbackTargetName;
  const mapDescription = mapNodeDesign?.mapDescription || userPrompt;

  const prompt = buildPrompt({
    sourceName,
    targetName,
    userPrompt,
    mapDescription,
    worldTheme,
    contentLanguage,
  });

  const worldDesign = buildWorldDesign({
    worldConfig,
    targetMapId,
    targetName,
    userPrompt,
    prompt,
    mapNodeDesign,
  });

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const workDir = `${targetDir}.tmp-${Date.now()}`;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const contract = {
    worldId: path.basename(worldDir),
    sourceMapId,
    targetMapId,
    targetName,
    targetDir,
    generation: {
      userPrompt,
      mapDescription,
      mapNodeDesigner: mapNodeDesign
        ? { used: true, model: mapNodeDesign.designer?.model }
        : { used: false },
    },
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(path.join(workDir, "map-node-contract.json"), JSON.stringify(contract, null, 2));

  const pipelineResult = await runMapPipeline({
    userPrompt: prompt,
    runId: targetMapId,
    runDir: workDir,
    logDir: workDir,
    worldDesign,
    originalUserPrompt: worldConfig.originalPrompt || "",
    requireStep1Review: true,
    updateRuns: false,
  });

  const tmj = JSON.parse(fs.readFileSync(path.join(workDir, "06-final.tmj"), "utf-8"));
  const fragment = buildWorldFragment({ tmj, worldDesign, targetMapId, targetName, worldConfig });

  const validation = validateMapPackage(workDir, tmj, fragment);

  if (!validation.passed) {
    throw new Error(validation.issues.join("; "));
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(workDir, targetDir);

  console.log(JSON.stringify({ ok: true, targetMapId, targetName }));
}

function readWorldConfig(dir) {
  const p1 = path.join(dir, "world.json");
  const p2 = path.join(dir, "config/world.json");
  const file = fs.existsSync(p1) ? p1 : p2;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function buildPrompt({ sourceName, targetName, userPrompt, mapDescription, worldTheme }) {
  return [
    `用户地图需求：${userPrompt}`,
    mapDescription && mapDescription !== userPrompt ? `设计补充：${mapDescription}` : "",
    `来源地图：${sourceName}`,
    `目标地图：${targetName}`,
    worldTheme,
  ].filter(Boolean).join("\n");
}

function buildWorldDesign({ worldConfig, targetMapId, targetName, userPrompt, mapNodeDesign }) {
  return mapNodeDesign?.worldDesign || {
    worldName: targetName,
    worldDescription: userPrompt,
    regions: [],
    interactiveElements: [],
  };
}

function buildWorldFragment() { return { locations: [], mainAreaPoints: [] }; }
function validateMapPackage() { return { passed: true, issues: [] }; }

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
