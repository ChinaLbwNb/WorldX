import { chatJSON } from "../../../orchestrator/src/models/llm-client.mjs";

const DEFAULT_JSON_RETRIES = parseInt(process.env.MAP_NODE_DESIGNER_JSON_RETRIES || "2", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MAP_NODE_DESIGNER_TIMEOUT_MS || "120000", 10);

export async function designMapNode({
  worldConfig,
  sourceMap,
  sourceMapId,
  targetMapId,
  targetName,
  userPrompt,
  worldTheme,
  contentLanguage = "zh",
}) {
  if (process.env.MAP_NODE_DESIGNER_DISABLED === "1") {
    return null;
  }
  if (!process.env.ORCHESTRATOR_API_KEY) {
    throw new Error("ORCHESTRATOR_API_KEY is not configured");
  }

  const raw = await chatJSON(
    {
      systemMessage: [
        "You are a senior game world designer for an AI sandbox simulation.",
        "Design one standalone map node inside an existing generated world.",
        "Return valid JSON only. Do not include markdown fences or explanations.",
      ].join("\n"),
      userMessage: buildDesignerPrompt({
        worldConfig,
        sourceMap,
        sourceMapId,
        targetMapId,
        targetName,
        userPrompt,
        worldTheme,
        contentLanguage,
      }),
      temperature: 0.45,
      logStep: "MapNodeDesigner",
    },
    {
      jsonRetries: DEFAULT_JSON_RETRIES,
      requestTimeoutMs: DEFAULT_TIMEOUT_MS,
      maxTokens: 6000,
    },
  );

  return normalizeMapNodeDesign(raw, {
    targetMapId,
    targetName,
    userPrompt,
    worldConfig,
    contentLanguage,
  });
}

function buildDesignerPrompt({
  worldConfig,
  sourceMap,
  sourceMapId,
  targetMapId,
  targetName,
  userPrompt,
  worldTheme,
  contentLanguage,
}) {
  const languageInstruction = contentLanguage === "en"
    ? "Use English for names and descriptions."
    : "名称、描述、交互文案使用中文。";
  const sourceMapSummary = sourceMap
    ? JSON.stringify(
        {
          id: sourceMap.id,
          name: sourceMap.name,
          gridX: sourceMap.gridX,
          gridY: sourceMap.gridY,
          source: sourceMap.source,
        },
        null,
        2,
      )
    : `{ "id": "${sourceMapId}", "name": "当前地图" }`;

  return [
    "请基于已有世界，为用户要扩展的新地图节点生成一个结构化 MapNodeDesign。",
    "",
    "## 已有世界",
    `世界名称：${worldConfig.worldName || "未命名世界"}`,
    `世界描述：${worldConfig.worldDescription || ""}`,
    worldConfig.worldSocialContext ? `世界社交背景：${worldConfig.worldSocialContext}` : "",
    worldConfig.originalPrompt ? `用户最初创世 prompt：${worldConfig.originalPrompt}` : "",
    worldTheme ? `世界视觉参考：\n${worldTheme}` : "",
    "",
    "## 来源地图",
    sourceMapSummary,
    "",
    "## 用户想生成的新地图",
    userPrompt,
    "",
    "## 设计目标",
    "- 这是同一个世界内部的独立地图节点，不是新世界。",
    "- 新地图通过世界地图 UI 传送进入，不要设计成和旧地图边缘拼接。",
    "- 必须保留原世界的时代、题材、视觉风格、建筑尺度和资源物件风格。",
    "- 只设计地图、区域和可交互物件，不要新增 NPC 角色。",
    "- 地图必须适合后续生成可行走网格、区域矩形标注和资源采集点。",
    "- 地图中央或主要道路附近必须有一个自然开阔的传送出生区。",
    "- 资源点和线索物件必须是无文字的自然场景物件，不要设计牌子、菜单、UI 或水印。",
    languageInstruction,
    "",
    "## 输出 JSON schema",
    JSON.stringify({
      targetName: "简短地图名，12字以内",
      worldDescription: "一句话描述该地图节点在当前世界中的作用",
      mapDescription: "直接传给图片模型的地图描述，一句话讲清时代/地点/风格/构图",
      mapPlan: {
        buildingMode: "mostly_enterable | mostly_scenery | outdoor_only | indoor_scene",
        compositionNotes: "构图说明",
        worldFunctionSummary: "这个地图节点在世界中的功能",
        regionDesignNotes: "区域矩形标注需要注意的边界",
      },
      regions: [
        {
          id: "英文 snake_case，不要中文，不要空格",
          name: "区域名称",
          description: "区域说明",
          type: "outdoor | building | room | landmark",
          enterable: false,
          placementHint: "地图中央/左侧/右下等位置提示",
          visualDescription: "视觉特征，方便图片模型画出来",
          interactions: [
            {
              id: "英文 snake_case",
              name: "交互名称",
              description: "交互说明",
              duration: 1,
              repeatable: true,
            },
          ],
        },
      ],
      interactiveElements: [
        {
          id: "必须至少一个以 resource_ 开头的英文 snake_case",
          name: "物件名称",
          description: "物件说明",
          visualDescription: "视觉特征",
          placementHint: "道路边/中心区附近等",
          interactions: [
            {
              id: "英文 snake_case",
              name: "交互名称",
              description: "交互说明",
              duration: 1,
              repeatable: true,
            },
          ],
        },
      ],
    }, null, 2),
    "",
    "## 数量约束",
    "- regions 输出 3 到 5 个。必须包含：出生/公共活动区、主题地标区、连接道路/路径区。",
    "- interactiveElements 输出 2 到 4 个。必须包含至少 1 个可采集资源点，id 以 resource_ 开头。",
    "- 所有 id 都必须稳定、简短、英文 snake_case。",
    `- targetMapId 参考：${targetMapId}`,
    `- fallback targetName 参考：${targetName}`,
  ].filter(Boolean).join("\n");
}

function normalizeMapNodeDesign(raw, context) {
  if (!raw || typeof raw !== "object") {
    throw new Error("MapNodeDesigner returned non-object JSON");
  }

  const prefix = normalizeId(context.targetMapId) || "map_node";
  const targetName = limitText(raw.targetName, context.targetName, 18);
  const mapDescription = limitText(raw.mapDescription, context.userPrompt, 600);
  const worldDescription = limitText(
    raw.worldDescription,
    `${context.worldConfig.worldName || "世界"}中的独立地图节点。${context.userPrompt}`,
    300,
  );

  const mapPlan = normalizeMapPlan(raw.mapPlan);
  const regions = normalizeRegions(raw.regions, prefix);
  const interactiveElements = normalizeInteractiveElements(raw.interactiveElements, prefix);

  return {
    targetName,
    worldDescription,
    mapDescription,
    mapPlan,
    regions,
    interactiveElements,
    designer: {
      provider: "orchestrator",
      model: process.env.ORCHESTRATOR_MODEL || "",
      generatedAt: new Date().toISOString(),
    },
  };
}

function normalizeMapPlan(value) {
  const plan = value && typeof value === "object" ? value : {};
  return {
    buildingMode: pickOne(plan.buildingMode, [
      "mostly_enterable",
      "mostly_scenery",
      "outdoor_only",
      "indoor_scene",
    ], "mostly_enterable"),
    compositionNotes: limitText(plan.compositionNotes, "独立可玩场景；道路、开阔区和地标边界清晰。", 300),
    worldFunctionSummary: limitText(plan.worldFunctionSummary, "由用户提示词定义的新地图节点。", 300),
    regionDesignNotes: limitText(plan.regionDesignNotes, "区域边界清晰，适合后续用矩形标注。", 300),
  };
}

function normalizeRegions(value, prefix) {
  const rawRegions = Array.isArray(value) ? value.slice(0, 5) : [];
  const regions = rawRegions
    .map((item, index) => normalizeRegion(item, prefix, index))
    .filter(Boolean);

  ensureRegion(regions, {
    id: `${prefix}_hub`,
    name: "入口空地",
    description: "玩家传送进入后的主要开阔活动区。",
    type: "outdoor",
    enterable: false,
    placementHint: "地图中央或主要道路交汇处",
    visualDescription: "开阔、可行走、和周围道路连通",
    interactions: [makeInteraction(`${prefix}_rest`, "观察环境", "在新区域观察周围动向。", "character_memory", "observation")],
  });
  ensureRegion(regions, {
    id: `${prefix}_landmark`,
    name: "主题地标",
    description: "代表该地图主题特色的建筑或地点。",
    type: "building",
    enterable: true,
    placementHint: "靠近地图一侧但不要贴边",
    visualDescription: "具有辨识度的主要建筑或设施",
    interactions: [],
  });
  ensureRegion(regions, {
    id: `${prefix}_path`,
    name: "连接道路",
    description: "连接出生点、资源点和地标的道路或街巷。",
    type: "outdoor",
    enterable: false,
    placementHint: "贯穿地图，与中心区域连接",
    visualDescription: "连续可行走道路",
    interactions: [],
  });

  return dedupeById(regions).slice(0, 5);
}

function normalizeRegion(item, prefix, index) {
  if (!item || typeof item !== "object") return null;
  const id = normalizeId(item.id) || `${prefix}_region_${index + 1}`;
  return {
    id,
    name: limitText(item.name, `区域${index + 1}`, 24),
    description: limitText(item.description, "", 220),
    type: pickOne(item.type, ["outdoor", "building", "room", "landmark"], "outdoor"),
    enterable: Boolean(item.enterable),
    shapeConstraint: typeof item.shapeConstraint === "string" ? item.shapeConstraint : undefined,
    placementHint: limitText(item.placementHint, "靠近主要道路", 160),
    visualDescription: limitText(item.visualDescription, item.description || "", 220),
    interactions: normalizeInteractions(item.interactions, `${id}_inspect`, "互动"),
  };
}

function normalizeInteractiveElements(value, prefix) {
  const rawElements = Array.isArray(value) ? value.slice(0, 4) : [];
  const elements = rawElements
    .map((item, index) => normalizeInteractiveElement(item, prefix, index))
    .filter(Boolean);

  if (!elements.some((element) => element.id.startsWith("resource_"))) {
    elements.unshift({
      id: `resource_${prefix}_supply`,
      name: "补给资源",
      description: "可采集的资源点。",
      visualDescription: "宝箱、木材、矿石、药草、水井或符合世界观的资源物件",
      placementHint: "放在可行走道路边，靠近中心区域",
      interactions: [makeInteraction(`collect_${prefix}_supply`, "采集资源", "采集这个区域的资源。", "world_state", "player_resources")],
    });
  }
  ensureElement(elements, {
    id: `${prefix}_detail`,
    name: "线索物件",
    description: "提供区域叙事线索的可交互物件。",
    visualDescription: "无文字的祭器、工具堆、货箱、灯架、破损器械、雕像或符合世界观的小物件",
    placementHint: "靠近道路或地标入口",
    interactions: [makeInteraction(`inspect_${prefix}_detail`, "查看线索", "查看该区域的信息。", "character_memory", "clue")],
  });

  return dedupeById(elements).slice(0, 4);
}

function normalizeInteractiveElement(item, prefix, index) {
  if (!item || typeof item !== "object") return null;
  const id = normalizeId(item.id) || `${prefix}_object_${index + 1}`;
  return {
    id,
    name: limitText(item.name, `物件${index + 1}`, 24),
    description: limitText(item.description, "", 220),
    visualDescription: limitText(item.visualDescription, item.description || "", 220),
    placementHint: limitText(item.placementHint, "靠近主要道路", 160),
    interactions: normalizeInteractions(item.interactions, `${id}_inspect`, id.startsWith("resource_") ? "采集资源" : "互动"),
  };
}

function normalizeInteractions(value, fallbackId, fallbackName) {
  const interactions = Array.isArray(value)
    ? value.slice(0, 3).map((item, index) => normalizeInteraction(item, fallbackId, fallbackName, index)).filter(Boolean)
    : [];
  if (interactions.length > 0) return interactions;
  return [makeInteraction(fallbackId, fallbackName, "", "character_memory", "interaction")];
}

function normalizeInteraction(item, fallbackId, fallbackName, index) {
  if (!item || typeof item !== "object") return null;
  const id = normalizeId(item.id) || `${fallbackId}_${index + 1}`;
  return {
    id,
    name: limitText(item.name, fallbackName, 24),
    description: limitText(item.description, "", 180),
    duration: Number.isFinite(Number(item.duration)) ? Math.max(1, Math.min(5, Number(item.duration))) : 1,
    effects: Array.isArray(item.effects) && item.effects.length > 0
      ? item.effects
      : [{ type: "character_memory", target: "interaction", value: 1 }],
    repeatable: item.repeatable !== false,
  };
}

function makeInteraction(id, name, description, effectType, effectTarget) {
  return {
    id,
    name,
    description,
    duration: 1,
    effects: [{ type: effectType, target: effectTarget, value: 1 }],
    repeatable: true,
  };
}

function ensureRegion(regions, fallback) {
  if (regions.some((region) => region.id === fallback.id)) return;
  regions.push(fallback);
}

function ensureElement(elements, fallback) {
  if (elements.some((element) => element.id === fallback.id)) return;
  elements.push(fallback);
}

function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function pickOne(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function limitText(value, fallback, maxLength) {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return String(text || "").slice(0, maxLength);
}

function normalizeId(value) {
  const raw = String(value || "").trim().toLowerCase();
  return raw
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}
