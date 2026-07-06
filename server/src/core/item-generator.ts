import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { generateId } from "../utils/id-generator.js";
import type { LLMClient } from "../llm/llm-client.js";
import type { InventoryOwnerRef, ItemCategory } from "../types/index.js";
import * as inventoryStore from "../store/inventory-store.js";
import { getAccountAssetDir } from "../utils/account-assets.js";

const itemCategories = [
  "tool",
  "food",
  "equipment",
  "quest",
  "furniture",
  "decoration",
  "container",
  "misc",
] as const;

const ITEM_BG_HARD_THRESHOLD = 24;
const ITEM_BG_SOFT_THRESHOLD = 48;
const ITEM_BG_MAX_PALETTE_COLORS = 8;
const DEFAULT_ITEM_IMAGE_TIMEOUT_MS = 180_000;
const ITEM_IMAGE_MAX_ATTEMPTS = 2;

const generatedItemSchema = z.object({
  name: z.string().min(1).max(32),
  description: z.string().min(1).max(180),
  category: z.preprocess(normalizeItemCategoryInput, z.enum(itemCategories)),
  placeable: z.boolean().default(true),
  stackable: z.boolean().default(false),
  maxStack: z.coerce.number().int().min(1).max(99).default(1),
  footprintTiles: z.preprocess(normalizeFootprintTilesInput, z.object({
    width: z.coerce.number().int().min(1).max(6),
    height: z.coerce.number().int().min(1).max(6),
  }),
  ).default({ width: 1, height: 1 }),
  blocksMovement: z.boolean().default(true),
  interactionHints: z.preprocess(
    normalizeInteractionHintsInput,
    z.array(z.string().min(1).max(24)).max(4).default([]),
  ),
  visualPrompt: z.string().min(1).max(220),
});

type GeneratedItemDesign = z.output<typeof generatedItemSchema>;

export type GenerateItemResult = {
  item: inventoryStore.InventoryItemView;
  design: GeneratedItemDesign;
};

export class ItemGenerator {
  constructor(private llmClient: LLMClient) {}

  async generateForInventory(input: {
    prompt: string;
    owner: InventoryOwnerRef;
    worldId: string;
    timelineId: string;
    mapId: string;
    worldDir?: string;
    worldDescription?: string;
  }): Promise<GenerateItemResult> {
    const design = await this.designItem(input.prompt, input.worldDescription ?? "");
    const definitionId = `generated:${slugify(design.name)}:${generateId()}`;
    const asset = await writeGeneratedItemPngAsset({
      name: design.name,
      description: design.description,
      category: design.category,
      footprintTiles: design.footprintTiles,
      blocksMovement: design.blocksMovement,
      visualPrompt: design.visualPrompt,
      worldDescription: input.worldDescription ?? "",
    });
    const item = inventoryStore.addItemToInventory({
      owner: input.owner,
      definition: {
        id: definitionId,
        name: design.name,
        description: design.description,
        category: design.category,
        iconKey: iconKeyForCategory(design.category),
        stackable: design.stackable,
        maxStack: design.maxStack,
        placeable: design.placeable,
        metadata: {
          source: "ai_item_generation",
          prompt: input.prompt,
          usable: false,
          footprintTiles: design.footprintTiles,
          blocksMovement: design.blocksMovement,
          interactionHints: design.interactionHints,
          visualPrompt: design.visualPrompt,
          assetKind: asset.assetKind,
          assetPath: asset.assetPath,
          assetUrl: asset.assetUrl,
          assetKey: asset.assetKey,
        },
      },
      worldId: input.worldId,
      timelineId: input.timelineId,
      mapId: input.mapId,
      quantity: 1,
      transferKind: "system",
      state: {
        generatedAt: new Date().toISOString(),
      },
      transferMetadata: {
        source: "ai_item_generation",
        prompt: input.prompt,
      },
    });
    return { item, design };
  }

  private async designItem(prompt: string, worldDescription: string): Promise<GeneratedItemDesign> {
    try {
      const result = await this.llmClient.call({
        messages: [
          {
            role: "system",
            content:
              "你是游戏物品设计器。根据用户提示词生成一个可放入背包、可选可摆放的物品定义。只输出 JSON。",
          },
          {
            role: "user",
            content:
              `世界观摘要：${worldDescription || "未提供"}\n` +
              `用户想生成的物品：${prompt}\n\n` +
              "要求：如果是家具、小建筑、装饰、容器，placeable=true；如果像药水、食物、任务物则可为 false。" +
              "当前生成物品只作为账号资产、背包物和地图摆放素材，不生成背包内“使用”效果；interactionHints 只描述摆放到地图后的交互想象。" +
              "category 必须使用英文枚举：tool, food, equipment, quest, furniture, decoration, container, misc；不要输出中文类别。" +
              "footprintTiles 必须是对象 {\"width\":数字,\"height\":数字}，表示摆放占用 tile；常见小物 1x1，床铺/桌椅 2x1 或 2x2，小建筑 3x3 到 6x6。" +
              "visualPrompt 用于后续生成像素风/俯视角地图素材，要贴合世界风格。",
          },
        ],
        schema: generatedItemSchema,
        options: {
          taskType: "item_generation",
          temperature: 0.6,
          maxRetries: 1,
          timeoutMs: 20_000,
        },
      });
      return normalizeGeneratedDesign(generatedItemSchema.parse(result.data));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`物品结构生成失败：${message}`);
    }
  }
}

function normalizeItemCategoryInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, ItemCategory> = {
    decor: "decoration",
    decorative: "decoration",
    ornament: "decoration",
    prop: "decoration",
    furnishings: "furniture",
    furnishing: "furniture",
    furniture_item: "furniture",
    building: "furniture",
    structure: "furniture",
    storage: "container",
    chest: "container",
    box: "container",
    weapon: "equipment",
    armor: "equipment",
    consumable: "food",
    ingredient: "food",
    工具: "tool",
    食物: "food",
    食品: "food",
    装备: "equipment",
    武器: "equipment",
    护甲: "equipment",
    任务: "quest",
    任务物品: "quest",
    家具: "furniture",
    家居: "furniture",
    床: "furniture",
    床铺: "furniture",
    建筑: "furniture",
    小建筑: "furniture",
    装饰: "decoration",
    装饰品: "decoration",
    摆件: "decoration",
    容器: "container",
    箱子: "container",
    柜子: "container",
    橱柜: "container",
    杂项: "misc",
    其他: "misc",
  };
  return aliases[normalized] ?? normalized;
}

function normalizeFootprintTilesInput(value: unknown): unknown {
  if (value === null || value === undefined) return { width: 1, height: 1 };
  if (Array.isArray(value)) {
    return {
      width: Number(value[0]) || 1,
      height: Number(value[1]) || Number(value[0]) || 1,
    };
  }
  if (typeof value === "number") return { width: value, height: value };
  if (typeof value === "string") {
    const match = value.match(/(\d+)\s*[x×*]\s*(\d+)/i);
    if (match) return { width: Number(match[1]) || 1, height: Number(match[2]) || 1 };
    const single = Number(value.match(/\d+/)?.[0] ?? 1);
    return { width: single, height: single };
  }
  if (typeof value !== "object") return { width: 1, height: 1 };

  const raw = value as Record<string, unknown>;
  const width =
    raw.width ?? raw.w ?? raw.tileWidth ?? raw.tilesWide ?? raw["宽"] ?? raw["宽度"] ?? raw["占地宽度"];
  const height =
    raw.height ?? raw.h ?? raw.tileHeight ?? raw.tilesHigh ?? raw["高"] ?? raw["高度"] ?? raw["占地高度"];
  const size = raw.size ?? raw.tileSize ?? raw["尺寸"] ?? raw["占地"];
  if ((width === undefined || height === undefined) && size !== undefined) {
    const normalized = normalizeFootprintTilesInput(size) as { width?: unknown; height?: unknown };
    return {
      width: width ?? normalized.width ?? 1,
      height: height ?? normalized.height ?? width ?? normalized.width ?? 1,
    };
  }
  return {
    width: width ?? 1,
    height: height ?? width ?? 1,
  };
}

function normalizeInteractionHintsInput(value: unknown): unknown {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[，,;；\n]/)
      : [];
  return rawItems
    .map((item) => String(item ?? "").trim())
    .filter(Boolean)
    .map((item) => item.slice(0, 24))
    .slice(0, 4);
}

function normalizeGeneratedDesign(design: GeneratedItemDesign): GeneratedItemDesign {
  const placeable =
    design.placeable ||
    design.category === "furniture" ||
    design.category === "decoration" ||
    design.category === "container";
  return {
    ...design,
    placeable,
    stackable: placeable ? false : design.stackable,
    maxStack: placeable ? 1 : design.maxStack,
    footprintTiles: {
      width: Math.max(1, Math.min(6, Math.floor(design.footprintTiles.width || 1))),
      height: Math.max(1, Math.min(6, Math.floor(design.footprintTiles.height || 1))),
    },
  };
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
  return slug || "item";
}

function iconKeyForCategory(category: ItemCategory): string {
  switch (category) {
    case "tool":
      return "tool";
    case "food":
      return "food";
    case "equipment":
      return "equipment";
    case "container":
      return "container";
    case "furniture":
      return "furniture";
    case "quest":
      return "quest";
    case "decoration":
      return "decoration";
    default:
      return "misc";
  }
}

async function writeGeneratedItemPngAsset(
  input: {
    name: string;
    description: string;
    category: ItemCategory;
    footprintTiles: { width: number; height: number };
    blocksMovement: boolean;
    visualPrompt: string;
    worldDescription: string;
  },
): Promise<{ assetKey: string; assetPath: string; assetUrl: string; assetKind: "png" }> {
  const assetKey = `item_${generateId()}`;
  const prompt = buildItemImagePrompt(input);
  const buffer = await generateItemImagePng(prompt);
  if (!isLikelyPng(buffer)) {
    throw new Error("物品图片生成失败：图像 API 没有返回 PNG 图片。");
  }
  const transparentBuffer = await removeConnectedItemBackground(buffer);
  const assetDir = getAccountAssetDir("items");
  fs.mkdirSync(assetDir, { recursive: true });
  const fileName = `${assetKey}.png`;
  const assetPath = `items/${fileName}`;
  fs.writeFileSync(path.join(assetDir, fileName), transparentBuffer);
  return {
    assetKey,
    assetPath,
    assetUrl: `/assets/account/${assetPath}`,
    assetKind: "png",
  };
}

function buildItemImagePrompt(input: {
  name: string;
  description: string;
  category: ItemCategory;
  footprintTiles: { width: number; height: number };
  blocksMovement: boolean;
  visualPrompt: string;
  worldDescription: string;
}): string {
  return [
    "Create a single top-down 2D game prop asset on a transparent background.",
    "Style: readable at small size, painterly pixel-game map prop, soft outline, no text, no UI frame, no shadows outside the object.",
    `World style context: ${input.worldDescription || "fantasy simulation world"}.`,
    `Item name: ${input.name}.`,
    `Item description: ${input.description}.`,
    `Category: ${input.category}. Footprint tiles: ${input.footprintTiles.width}x${input.footprintTiles.height}.`,
    `Gameplay: ${input.blocksMovement ? "solid blocking map prop" : "non-blocking decorative prop"}.`,
    `Visual intent: ${input.visualPrompt}.`,
    "Return only the transparent PNG asset, centered, with the full object visible.",
  ].join("\n");
}

async function generateItemImagePng(prompt: string): Promise<Buffer> {
  const apiKey = process.env.IMAGE_GEN_API_KEY || "";
  if (!apiKey) throw new Error("物品图片生成失败：IMAGE_GEN_API_KEY 未配置。");
  const model = process.env.ITEM_ASSET_IMAGE_MODEL || process.env.IMAGE_GEN_MODEL || "MaaS_Ge_2.5_flash_image_20251002";
  const baseUrl = (process.env.IMAGE_GEN_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const provider = (process.env.IMAGE_GEN_PROVIDER || "").trim().toLowerCase();
  const timeoutMs = Math.max(10_000, Number(process.env.ITEM_ASSET_IMAGE_TIMEOUT_MS || process.env.IMAGE_GEN_TIMEOUT_MS || DEFAULT_ITEM_IMAGE_TIMEOUT_MS));

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= ITEM_IMAGE_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestItemImagePng({ prompt, apiKey, model, baseUrl, provider, timeoutMs });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= ITEM_IMAGE_MAX_ATTEMPTS || !isRetryableImageError(message)) {
        throw error;
      }
      console.warn(`[ItemGenerator] Image generation attempt ${attempt} failed, retrying: ${message}`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "物品图片生成失败"));
}

async function requestItemImagePng(input: {
  prompt: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  provider: string;
  timeoutMs: number;
}): Promise<Buffer> {
  const { prompt, apiKey, model, baseUrl, provider, timeoutMs } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = isGoogleNativeProvider(provider, baseUrl)
      ? await fetch(buildGoogleNativeImageUrl(baseUrl, model, apiKey), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
          signal: controller.signal,
        })
      : await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: prompt }],
            modalities: ["image", "text"],
            image_config: { image_size: process.env.ITEM_ASSET_IMAGE_SIZE || "1K" },
          }),
          signal: controller.signal,
        });
    if (!res.ok) {
      throw new Error(`物品图片生成失败：图像 API 返回 ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    return isGoogleNativeProvider(provider, baseUrl)
      ? extractGoogleNativeImageBuffer(data)
      : extractOpenAiCompatibleImageBuffer(data);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`物品图片生成失败：图像 API 请求超过 ${timeoutMs / 1000}s。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isRetryableImageError(message: string): boolean {
  return /timeout|timed out|超时|超过| 429| 500| 502| 503| 504|ECONNRESET|ETIMEDOUT/i.test(message);
}

function isGoogleNativeProvider(provider: string, baseUrl: string): boolean {
  return provider === "google-native" || provider === "google" || (!provider && baseUrl.includes("generativelanguage.googleapis.com"));
}

function buildGoogleNativeImageUrl(baseUrl: string, model: string, apiKey: string): string {
  const normalizedBase = baseUrl.endsWith("/openai") ? baseUrl.slice(0, -"/openai".length) : baseUrl;
  const normalizedModel = model.replace(/^google\//, "").replace(/^models\//, "");
  return `${normalizedBase}/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
}

function extractOpenAiCompatibleImageBuffer(data: any): Buffer {
  const message = data?.choices?.[0]?.message;
  if (!message) throw new Error("No message in Image Gen response");
  const directUrl = message.images?.[0]?.image_url?.url;
  const direct = bufferFromDataImage(directUrl);
  if (direct) return direct;
  if (typeof message.content === "string") {
    const match = message.content.match(/data:image\/\w+;base64,([A-Za-z0-9+/=]+)/);
    if (match) return Buffer.from(match[1], "base64");
  }
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      const fromPart = bufferFromDataImage(part?.image_url?.url);
      if (fromPart) return fromPart;
    }
  }
  throw new Error("No image found in Image Gen response");
}

function extractGoogleNativeImageBuffer(data: any): Buffer {
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  for (const candidate of candidates) {
    const parts = Array.isArray(candidate.content?.parts) ? candidate.content.parts : [];
    for (const part of parts) {
      const inlineData = part.inlineData || part.inline_data;
      if (inlineData?.data) return Buffer.from(inlineData.data, "base64");
    }
  }
  throw new Error("No image found in Google native Image Gen response");
}

function bufferFromDataImage(url: unknown): Buffer | null {
  if (typeof url !== "string") return null;
  const match = url.match(/^data:image\/\w+;base64,([A-Za-z0-9+/=]+)$/);
  return match ? Buffer.from(match[1], "base64") : null;
}

function isLikelyPng(buffer: Buffer): boolean {
  return buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47;
}

export async function removeConnectedItemBackground(inputBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(inputBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);
  if (hasUsefulTransparency(pixels, width, height, channels)) {
    return trimTransparentPadding(inputBuffer);
  }

  const palette = detectEdgeBackgroundPalette(pixels, width, height, channels);

  if (palette.length > 0) {
    floodRemoveBackground(pixels, width, height, channels, palette);
  }

  const cleaned = await sharp(Buffer.from(pixels.buffer), {
    raw: { width, height, channels },
  })
    .png()
    .toBuffer();

  return trimTransparentPadding(cleaned);
}

function hasUsefulTransparency(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): boolean {
  let transparentTotal = 0;
  let transparentEdge = 0;
  let edgeTotal = 0;

  const visit = (x: number, y: number, edge: boolean) => {
    const alpha = pixels[(y * width + x) * channels + 3];
    if (alpha < 24) {
      transparentTotal++;
      if (edge) transparentEdge++;
    }
    if (edge) edgeTotal++;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      visit(x, y, x === 0 || y === 0 || x === width - 1 || y === height - 1);
    }
  }

  const totalRatio = transparentTotal / Math.max(1, width * height);
  const edgeRatio = transparentEdge / Math.max(1, edgeTotal);
  return totalRatio >= 0.02 || edgeRatio >= 0.12;
}

function detectEdgeBackgroundPalette(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Array<{ r: number; g: number; b: number }> {
  const counts = new Map<string, { r: number; g: number; b: number; count: number }>();
  let opaqueEdgeCount = 0;

  const visit = (x: number, y: number) => {
    const pi = (y * width + x) * channels;
    if (pixels[pi + 3] < 24) return;
    opaqueEdgeCount++;
    const r = pixels[pi];
    const g = pixels[pi + 1];
    const b = pixels[pi + 2];
    const key = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
    const bucket = counts.get(key);
    if (bucket) {
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.count++;
    } else {
      counts.set(key, { r, g, b, count: 1 });
    }
  };

  for (let x = 0; x < width; x++) {
    visit(x, 0);
    visit(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    visit(0, y);
    visit(width - 1, y);
  }

  if (opaqueEdgeCount === 0) return [];

  return Array.from(counts.values())
    .filter((entry) => entry.count / opaqueEdgeCount >= 0.015)
    .sort((a, b) => b.count - a.count)
    .slice(0, ITEM_BG_MAX_PALETTE_COLORS)
    .map((entry) => ({
      r: Math.round(entry.r / entry.count),
      g: Math.round(entry.g / entry.count),
      b: Math.round(entry.b / entry.count),
    }));
}

function floodRemoveBackground(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  palette: Array<{ r: number; g: number; b: number }>,
): void {
  const state = new Uint8Array(width * height);
  const queue: number[] = [];
  const idx = (x: number, y: number) => y * width + x;
  const pixelIdx = (x: number, y: number) => (y * width + x) * channels;
  const distanceAt = (x: number, y: number) => {
    const pi = pixelIdx(x, y);
    if (pixels[pi + 3] < 24) return 0;
    return minColorDistance(pixels[pi], pixels[pi + 1], pixels[pi + 2], palette);
  };
  const seed = (x: number, y: number) => {
    const i = idx(x, y);
    if (state[i] !== 0) return;
    const d = distanceAt(x, y);
    if (d < ITEM_BG_SOFT_THRESHOLD) {
      state[i] = d < ITEM_BG_HARD_THRESHOLD ? 1 : 2;
      queue.push(x, y);
    }
  };

  for (let x = 0; x < width; x++) {
    seed(x, 0);
    seed(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    seed(0, y);
    seed(width - 1, y);
  }

  let qi = 0;
  const dx4 = [-1, 1, 0, 0];
  const dy4 = [0, 0, -1, 1];
  while (qi < queue.length) {
    const cx = queue[qi++];
    const cy = queue[qi++];
    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + dx4[dir];
      const ny = cy + dy4[dir];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const ni = idx(nx, ny);
      if (state[ni] !== 0) continue;
      const d = distanceAt(nx, ny);
      if (d < ITEM_BG_HARD_THRESHOLD) {
        state[ni] = 1;
        queue.push(nx, ny);
      } else if (d < ITEM_BG_SOFT_THRESHOLD) {
        state[ni] = 2;
        queue.push(nx, ny);
      }
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = state[idx(x, y)];
      if (s === 0) continue;
      const pi = pixelIdx(x, y);
      if (s === 1) {
        pixels[pi + 3] = 0;
      } else {
        const d = distanceAt(x, y);
        const t = Math.max(0, Math.min(1, (d - ITEM_BG_HARD_THRESHOLD) / (ITEM_BG_SOFT_THRESHOLD - ITEM_BG_HARD_THRESHOLD)));
        pixels[pi + 3] = Math.min(pixels[pi + 3], Math.round(255 * t));
      }
    }
  }
}

async function trimTransparentPadding(inputBuffer: Buffer): Promise<Buffer> {
  const image = sharp(inputBuffer).ensureAlpha();
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true });
  const pixels = new Uint8Array(data);
  const { width, height, channels } = info;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = pixels[(y * width + x) * channels + 3];
      if (alpha <= 12) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) return inputBuffer;

  const padding = 4;
  const left = Math.max(0, minX - padding);
  const top = Math.max(0, minY - padding);
  const right = Math.min(width - 1, maxX + padding);
  const bottom = Math.min(height - 1, maxY + padding);
  const extractWidth = right - left + 1;
  const extractHeight = bottom - top + 1;

  if (extractWidth === width && extractHeight === height) return inputBuffer;

  return sharp(inputBuffer)
    .extract({ left, top, width: extractWidth, height: extractHeight })
    .png()
    .toBuffer();
}

function minColorDistance(
  r: number,
  g: number,
  b: number,
  palette: Array<{ r: number; g: number; b: number }>,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (const color of palette) {
    const d = Math.sqrt((r - color.r) ** 2 + (g - color.g) ** 2 + (b - color.b) ** 2);
    if (d < best) best = d;
  }
  return best;
}
