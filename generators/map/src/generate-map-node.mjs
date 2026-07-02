import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMapPipeline } from "./index.mjs";

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
  const worldTheme = [
    worldConfig.worldName,
    worldConfig.worldDescription,
    worldConfig.originalPrompt,
  ].filter(Boolean).join("\n");
  const targetName = buildTargetName(worldConfig, userPrompt);
  const prompt = buildPrompt({
    sourceName,
    targetName,
    userPrompt,
    worldTheme,
    contentLanguage: worldConfig.contentLanguage || "zh",
  });
  const worldDesign = buildWorldDesign({
    worldConfig,
    targetMapId,
    targetName,
    userPrompt,
    prompt,
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
    styleReference: {
      sourceMapId,
      sourceName,
      worldTheme,
    },
    generation: {
      userPrompt,
      prompt,
      model: process.env.IMAGE_GEN_MODEL || "",
      mapImageSize: process.env.MAP_IMAGE_SIZE_K || "1",
    },
    validationRules: {
      minWalkableRatio: 0.08,
      maxWalkableRatio: 0.85,
      requireDefaultSpawn: true,
      requireMainAreaPoint: true,
    },
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(workDir, "map-node-contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf-8");

  console.log(`[MapNode · Step 1] Generating standalone map node: ${targetMapId}`);
  const pipelineResult = await runMapPipeline({
    userPrompt: prompt,
    runId: targetMapId,
    runDir: workDir,
    logDir: workDir,
    worldDesign,
    originalUserPrompt: worldConfig.originalPrompt || worldConfig.worldDescription || "",
    requireStep1Review: true,
    updateRuns: false,
  });

  console.log("[MapNode · Step 2] Building world fragment and validating package...");
  const tmjPath = path.join(workDir, "06-final.tmj");
  const tmj = JSON.parse(fs.readFileSync(tmjPath, "utf-8"));
  const fragment = buildWorldFragment({
    tmj,
    worldDesign,
    targetMapId,
    targetName,
    worldConfig,
  });
  fs.writeFileSync(path.join(workDir, "world-fragment.json"), `${JSON.stringify(fragment, null, 2)}\n`, "utf-8");

  const validation = validateMapPackage(workDir, tmj, fragment);
  const spawn = fragment.mainAreaPoints.find((point) => point.id === `${targetMapId}_spawn`) || fragment.mainAreaPoints[0] || null;
  const nodeMetadata = {
    id: targetMapId,
    name: targetName,
    sourceMapId,
    userPrompt,
    gridWidth: tmj.width,
    gridHeight: tmj.height,
    tileSize: tmj.tilewidth,
    spawn,
    createdAt: new Date().toISOString(),
    pipeline: {
      runId: pipelineResult.runId,
      warnings: pipelineResult.warnings || [],
      steps: pipelineResult.metadata?.steps || {},
    },
  };
  fs.writeFileSync(path.join(workDir, "metadata.json"), `${JSON.stringify(nodeMetadata, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(workDir, "generation-report.json"), `${JSON.stringify({
    targetMapId,
    sourceMapId,
    userPrompt,
    validation,
    timings: {
      totalMs: Date.now() - startedAt,
    },
    pipeline: pipelineResult,
  }, null, 2)}\n`, "utf-8");

  if (!validation.passed) {
    throw new Error(`Map node validation failed: ${validation.issues.join("; ")}`);
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(workDir, targetDir);

  console.log(JSON.stringify({
    ok: true,
    targetMapId,
    targetName,
    targetDir,
    validation,
    timings: {
      totalMs: Date.now() - startedAt,
    },
    gridWidth: tmj.width,
    gridHeight: tmj.height,
    tileSize: tmj.tilewidth,
    spawn,
    locations: fragment.locations.length,
    mainAreaPoints: fragment.mainAreaPoints.length,
  }));
}

function readWorldConfig(worldDir) {
  const candidates = [
    path.join(worldDir, "world.json"),
    path.join(worldDir, "config", "world.json"),
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, "utf-8"));
    }
  }
  throw new Error(`world.json not found in ${worldDir}`);
}

function buildPrompt({ sourceName, targetName, userPrompt, worldTheme, contentLanguage }) {
  const languageHint = contentLanguage === "en"
    ? "Use English only in metadata. Do not render any written text inside the image."
    : "元数据名称使用中文；画面内禁止出现任何文字。";
  return [
    "画面硬性限制：不要画任何文字、标题、标签、路牌字、箭头、图标、UI、水印、字幕、地图名、区域名或出生点标记。",
    `用户想生成的新地图：${userPrompt}`,
    `为同一个游戏世界生成一张新的独立本地地图，地图名参考为「${targetName}」。`,
    `它通过世界地图 UI 从「${sourceName}」传送进入；不要表现成东南西北相邻区域，不要画拼接边界、入口箭头或传送门 UI。`,
    "这是一张可以单独加载和游玩的俯视/轻横切像素风游戏地图，需要完整场景、清晰道路、可行走开阔区、建筑或功能区，以及少量可交互资源点。",
    "优先满足用户提示词，同时保持原世界的时代、题材、色调、建筑尺度、资源物件风格和游戏可读性一致。",
    "地图中央或主要道路附近保留一片自然的开阔可行走空地，适合玩家传送进入；不要用任何符号标出它。",
    "资源点要像自然物件或场景道具，不要做成带字的告示牌、菜单、铭牌或说明牌。",
    "避免人物大头像、重复旧图主体、纯装饰边框和无法通行的大面积封闭区域。",
    languageHint,
    worldTheme ? `原世界参考：\n${worldTheme}` : "",
  ].filter(Boolean).join("\n");
}

function buildWorldDesign({ worldConfig, targetMapId, targetName, userPrompt, prompt }) {
  const prefix = targetMapId.replace(/[^A-Za-z0-9_]/g, "_");
  const names = buildSemanticNames(worldConfig, userPrompt);
  return {
    worldName: targetName,
    worldDescription: `${worldConfig.worldName || "世界"}中的独立传送地图。${userPrompt}`,
    worldSocialContext: worldConfig.worldSocialContext || worldConfig.worldDescription || "",
    contentLanguage: worldConfig.contentLanguage || "zh",
    sceneType: worldConfig.scene?.sceneType || "open",
    timeConfig: {
      startTime: worldConfig.scene?.startTime || "08:00",
      displayFormat: worldConfig.scene?.displayFormat || "modern",
      maxTicks: worldConfig.scene?.maxTicks ?? null,
    },
    multiDay: worldConfig.scene?.multiDay,
    mapDescription: prompt,
    mapPlan: {
      buildingMode: "mostly_enterable",
      compositionNotes: "独立可玩场景，不拼接旧地图；道路和开阔区需要明显，便于寻路和资源采集。",
      worldFunctionSummary: "由用户提示词定义的新区域，作为世界地图节点传送进入。",
      regionDesignNotes: "区域边界清晰，适合后续用矩形标注。",
    },
    regions: [
      {
        id: `${prefix}_hub`,
        name: names.hub,
        description: "玩家传送进入后的主要开阔活动区。",
        type: "outdoor",
        enterable: false,
        placementHint: "地图中央或主要道路交汇处",
        visualDescription: "开阔、可行走、和周围道路连通",
        interactions: [
          {
            id: `${prefix}_rest`,
            name: "观察环境",
            description: "在新区域观察周围动向。",
            duration: 2,
            effects: [{ type: "character_memory", target: "observation", value: 1 }],
            repeatable: true,
          },
        ],
      },
      {
        id: `${prefix}_landmark`,
        name: names.landmark,
        description: "代表该地图主题特色的建筑或地点。",
        type: "building",
        enterable: true,
        placementHint: "靠近地图一侧但不要贴边",
        visualDescription: "具有辨识度的主要建筑或设施",
        interactions: [],
      },
      {
        id: `${prefix}_path`,
        name: names.path,
        description: "连接出生点、资源点和地标的道路或街巷。",
        type: "outdoor",
        enterable: false,
        placementHint: "贯穿地图，与中心区域连接",
        visualDescription: "连续可行走道路",
        interactions: [],
      },
    ],
    interactiveElements: [
      {
        id: `resource_${prefix}_supply`,
        name: names.resource,
        description: "可采集的资源点。",
        visualDescription: "宝箱、木材、矿石、药草、水井或符合世界观的资源物件",
        placementHint: "放在可行走道路边，靠近中心区域",
        interactions: [
          {
            id: `collect_${prefix}_supply`,
            name: "采集资源",
            description: "采集这个区域的资源。",
            duration: 1,
            effects: [{ type: "world_state", target: "player_resources", value: 1 }],
            repeatable: true,
          },
        ],
      },
      {
        id: `${prefix}_detail`,
        name: names.detail,
        description: "提供区域叙事线索的可交互物件。",
        visualDescription: "无文字的祭器、工具堆、货箱、灯架、破损器械、雕像或符合世界观的小物件",
        placementHint: "靠近道路或地标入口",
        interactions: [
          {
            id: `inspect_${prefix}_notice`,
            name: "查看线索",
            description: "查看该区域的信息。",
            duration: 1,
            effects: [{ type: "character_memory", target: "clue", value: 1 }],
            repeatable: true,
          },
        ],
      },
    ],
    characters: [],
    worldActions: worldConfig.worldActions || [],
  };
}

function buildWorldFragment({ tmj, worldDesign, targetMapId, targetName, worldConfig }) {
  const regionLayer = tmj.layers?.find((layer) => layer.name === "regions");
  const objectLayer = tmj.layers?.find((layer) => layer.name === "interactive_objects");
  const regions = regionLayer?.objects || [];
  const objects = objectLayer?.objects || [];
  const designedRegions = new Map((worldDesign.regions || []).map((region) => [region.id, region]));
  const designedElements = new Map((worldDesign.interactiveElements || []).map((element) => [element.id, element]));
  const locations = regions.length
    ? regions.map((region) => {
        const regionId = getProperty(region, "id") || sanitizeId(region.name) || `${targetMapId}_region_${region.id}`;
        const designed = designedRegions.get(regionId);
        const containedObjects = objects
          .filter((object) => rectCenterInside(object, region))
          .map((object) => buildObjectConfig(object, regionId, designedElements));
        return {
          id: regionId,
          name: region.name || designed?.name || regionId,
          description: getProperty(region, "description") || designed?.description || "",
          adjacentLocations: [],
          objects: containedObjects,
        };
      })
    : [{
        id: "main_area",
        name: targetName,
        description: `${worldConfig.worldName || "世界"}中的独立地图区域。`,
        adjacentLocations: [],
        objects: objects.map((object) => buildObjectConfig(object, "main_area", designedElements)),
      }];

  ensureMainArea(locations, targetName, worldConfig, objects, designedElements);
  const mainAreaPoints = buildMainAreaPointsFromTmj(tmj, regions, targetMapId);
  const worldSize = {
    width: tmj.width * tmj.tilewidth,
    height: tmj.height * tmj.tileheight,
    tileSize: tmj.tilewidth,
    gridWidth: tmj.width,
    gridHeight: tmj.height,
  };
  return {
    locations,
    mainAreaPoints,
    worldActions: worldConfig.worldActions || [],
    worldSize,
  };
}

function buildObjectConfig(object, locationId, designedElements) {
  const objectId = getProperty(object, "objectId") || sanitizeId(object.name) || `object_${object.id}`;
  const designed = designedElements.get(objectId);
  const isResource = objectId.startsWith("resource_");
  return {
    id: objectId,
    name: object.name || designed?.name || objectId,
    locationId,
    defaultState: "available",
    capacity: 2,
    pixelX: Math.round((object.x || 0) + (object.width || 0) / 2),
    pixelY: Math.round((object.y || 0) + (object.height || 0) / 2),
    width: Math.round(object.width || 64),
    height: Math.round(object.height || 64),
    ...(isResource ? { resourcePerClick: 1, cooldownMs: 0 } : {}),
    interactions: designed?.interactions || [{
      id: `${objectId}_inspect`,
      name: isResource ? "采集资源" : "互动",
      description: designed?.description || "",
      availableWhenState: ["available"],
      duration: 1,
      effects: [{ type: "character_memory", target: "interaction", value: 1 }],
      repeatable: true,
    }],
  };
}

function ensureMainArea(locations, targetName, worldConfig, objects, designedElements) {
  if (locations.some((location) => location.id === "main_area")) return;
  locations.unshift({
    id: "main_area",
    name: targetName,
    description: `${worldConfig.worldName || "世界"}中的公共活动区。`,
    adjacentLocations: locations.map((location) => location.id),
    objects: objects
      .filter((object) => !locations.some((location) => location.objects.some((item) => item.id === (getProperty(object, "objectId") || sanitizeId(object.name)))))
      .map((object) => buildObjectConfig(object, "main_area", designedElements)),
  });
  for (const location of locations) {
    if (location.id !== "main_area" && !location.adjacentLocations.includes("main_area")) {
      location.adjacentLocations.push("main_area");
    }
  }
}

function buildMainAreaPointsFromTmj(tmj, regions, targetMapId) {
  const collision = tmj.layers?.find((layer) => layer.name === "collision")?.data || [];
  const tileSize = tmj.tilewidth || 8;
  const points = [];
  const center = findNearestWalkablePixel(tmj, Math.round((tmj.width * tileSize) / 2), Math.round((tmj.height * tileSize) / 2));
  if (center) {
    points.push({
      id: `${targetMapId}_spawn`,
      name: "入口空地",
      x: center.x,
      y: center.y,
      adjacentPointIds: [],
    });
  }
  for (const region of regions.slice(0, 8)) {
    const candidate = findNearestWalkablePixel(
      tmj,
      Math.round((region.x || 0) + (region.width || 0) / 2),
      Math.round((region.y || 0) + (region.height || 0) / 2),
    );
    if (!candidate) continue;
    points.push({
      id: `${targetMapId}_point_${points.length + 1}`,
      name: region.name || `活动点${points.length + 1}`,
      x: candidate.x,
      y: candidate.y,
      adjacentPointIds: [],
    });
  }
  const ids = points.map((point) => point.id);
  return points.map((point) => ({
    ...point,
    adjacentPointIds: ids.filter((id) => id !== point.id),
  }));
}

function buildTargetName(worldConfig, userPrompt) {
  const cleaned = String(userPrompt || "")
    .replace(/[，。！？,.!?；;：:]/g, " ")
    .trim()
    .split(/\s+/)[0]
    ?.replace(/[^\p{L}\p{N}_\u4e00-\u9fa5-]/gu, "")
    .slice(0, 12);
  if (cleaned) return cleaned;
  return `${worldConfig.worldName || "世界"}新地图`;
}

function buildSemanticNames(worldConfig, userPrompt) {
  const theme = `${worldConfig.worldName || ""} ${worldConfig.worldDescription || ""} ${worldConfig.originalPrompt || ""} ${userPrompt || ""}`;
  const isModern = /现代|都市|网红|公司|街区|学校|科幻|机库|格纳库|实验室/.test(theme);
  const isAncient = /古代|宋朝|唐朝|江湖|客栈|市集|衙门|山寨|修仙/.test(theme);
  const variant = Math.abs(hashString(String(userPrompt || theme || "map"))) % 4;
  const palettes = isModern
    ? [
        ["街角广场", "旧仓库", "巷道", "补给箱", "灯架"],
        ["维修空场", "维修站", "支路", "工具箱", "机器残件"],
        ["社区庭院", "小卖部", "步道", "储物柜", "货架"],
        ["观景平台", "管理亭", "连廊", "材料堆", "控制台"],
      ]
    : isAncient
    ? [
        ["坊间空场", "茶棚", "石板路", "水井", "灯笼架"],
        ["市集路口", "货栈", "青石巷", "木箱", "陶罐"],
        ["河畔庭院", "酒棚", "河边小路", "药草丛", "竹篮"],
        ["驿亭小院", "驿亭", "土路", "柴堆", "石灯"],
      ]
    : [
        ["林间空地", "高台", "小径", "补给物资", "石堆"],
        ["村道路口", "棚屋", "弯路", "材料箱", "旧器具"],
        ["月下庭院", "屋舍", "步道", "水源", "篝火台"],
        ["石台营地", "岗亭", "坡道", "木材堆", "灯架"],
      ];
  const [hub, landmark, pathName, resource, detail] = palettes[variant];
  return { hub, landmark, path: pathName, resource, detail };
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function validateMapPackage(mapDir, tmj, fragment) {
  const issues = [];
  if (!fs.existsSync(path.join(mapDir, "06-background.png"))) issues.push("06-background.png missing");
  if (!fs.existsSync(path.join(mapDir, "06-final.tmj"))) issues.push("06-final.tmj missing");
  if (!fs.existsSync(path.join(mapDir, "background-tiles", "manifest.json"))) issues.push("background tiles manifest missing");
  if (!Number.isFinite(tmj.width) || !Number.isFinite(tmj.height) || !Number.isFinite(tmj.tilewidth)) {
    issues.push("invalid TMJ dimensions");
  }
  const collision = tmj.layers?.find((layer) => layer.name === "collision")?.data;
  if (!Array.isArray(collision) || collision.length !== tmj.width * tmj.height) {
    issues.push("invalid collision layer");
  } else {
    const walkable = collision.filter((tile) => tile === 0).length;
    const ratio = walkable / collision.length;
    if (ratio < 0.08) issues.push(`walkable ratio too low: ${ratio.toFixed(3)}`);
    if (ratio > 0.85) issues.push(`walkable ratio too high: ${ratio.toFixed(3)}`);
  }
  if (!Array.isArray(fragment.locations) || fragment.locations.length === 0) issues.push("no locations");
  if (!Array.isArray(fragment.mainAreaPoints) || fragment.mainAreaPoints.length === 0) {
    issues.push("no main area points");
  }
  for (const point of fragment.mainAreaPoints || []) {
    if (!isPixelInside(tmj, point.x, point.y)) {
      issues.push(`mainAreaPoint out of bounds: ${point.id}`);
    } else if (!isPixelWalkable(tmj, point.x, point.y)) {
      issues.push(`mainAreaPoint not walkable: ${point.id}`);
    }
  }
  return { passed: issues.length === 0, issues };
}

function findNearestWalkablePixel(tmj, x, y) {
  const tileSize = tmj.tilewidth || 8;
  const cx = Math.max(0, Math.min(tmj.width - 1, Math.floor(x / tileSize)));
  const cy = Math.max(0, Math.min(tmj.height - 1, Math.floor(y / tileSize)));
  for (let radius = 0; radius < Math.max(tmj.width, tmj.height); radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const gx = cx + dx;
        const gy = cy + dy;
        if (gx < 0 || gy < 0 || gx >= tmj.width || gy >= tmj.height) continue;
        if (isTileWalkable(tmj, gx, gy)) {
          return { x: gx * tileSize + tileSize / 2, y: gy * tileSize + tileSize / 2 };
        }
      }
    }
  }
  return null;
}

function isPixelInside(tmj, x, y) {
  return x >= 0 && y >= 0 && x < tmj.width * tmj.tilewidth && y < tmj.height * tmj.tileheight;
}

function isPixelWalkable(tmj, x, y) {
  const tileSize = tmj.tilewidth || 8;
  return isTileWalkable(tmj, Math.floor(x / tileSize), Math.floor(y / tileSize));
}

function isTileWalkable(tmj, gx, gy) {
  const collision = tmj.layers?.find((layer) => layer.name === "collision")?.data || [];
  if (gx < 0 || gy < 0 || gx >= tmj.width || gy >= tmj.height) return false;
  return collision[gy * tmj.width + gx] === 0;
}

function getProperty(object, name) {
  const prop = object.properties?.find((item) => item.name === name);
  return prop?.value;
}

function rectCenterInside(object, region) {
  const cx = (object.x || 0) + (object.width || 0) / 2;
  const cy = (object.y || 0) + (object.height || 0) / 2;
  return cx >= region.x && cy >= region.y && cx <= region.x + region.width && cy <= region.y + region.height;
}

function sanitizeId(value) {
  if (!value || typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[^a-z0-9_\u4e00-\u9fa5]+/gi, "_").replace(/^_+|_+$/g, "");
}

main().catch((error) => {
  console.error(`[generate-map-node] ${error.stack || error.message}`);
  console.log(JSON.stringify({ ok: false, error: error.message }));
  process.exit(1);
});