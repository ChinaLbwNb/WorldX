import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as accountAssets from "../store/account-asset-store.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const GENERATED_WORLDS_DIR = path.resolve(__dirname, "../../../output/worlds");
export const LIBRARY_WORLDS_DIR = path.resolve(__dirname, "../../../library/worlds");

export type WorldSource = "user" | "library";
export type WorldVisibility = "private" | "unlisted" | "public";

export interface GeneratedWorldSummary {
  id: string;
  worldName: string;
  dir: string;
  source: WorldSource;
  ownerUserId: string;
  visibility: WorldVisibility;
}

export interface WorldAccessMetadata {
  ownerUserId: string;
  visibility: WorldVisibility;
  createdAt: string;
  updatedAt: string;
}

const WORLD_META_FILENAME = "worldx.meta.json";
const DEFAULT_WORLD_OWNER_ID = "local_user";

export function resolveInitialWorldDir(): string | undefined {
  const fromEnv = process.env.WORLD_DIR;
  if (fromEnv && isDirectory(fromEnv)) {
    return path.resolve(fromEnv);
  }

  const allWorlds = listAllWorlds();
  return allWorlds[0]?.dir;
}

export function listGeneratedWorlds(userId?: string): GeneratedWorldSummary[] {
  return scanWorldsDir(GENERATED_WORLDS_DIR, "user")
    .filter((world) => canUserAccessWorld(world, userId));
}

export function listLibraryWorlds(_userId?: string): GeneratedWorldSummary[] {
  return scanWorldsDir(LIBRARY_WORLDS_DIR, "library");
}

export function listAllWorlds(): GeneratedWorldSummary[] {
  const userWorlds = scanWorldsDir(GENERATED_WORLDS_DIR, "user");
  const libWorlds = listLibraryWorlds();
  return [...userWorlds, ...libWorlds];
}

export function findWorldById(worldId: string): GeneratedWorldSummary | undefined {
  return listAllWorlds().find((w) => w.id === worldId);
}

export function canUserAccessWorld(world: GeneratedWorldSummary, userId?: string): boolean {
  if (world.source === "library") return true;
  if (!userId) return false;
  if (world.ownerUserId === userId || accountAssets.userOwnsWorld(userId, world.id)) return true;
  return world.visibility === "public" || world.visibility === "unlisted";
}

export function canUserManageWorld(world: GeneratedWorldSummary, userId?: string): boolean {
  if (world.source === "library") return false;
  return Boolean(userId && (world.ownerUserId === userId || accountAssets.userOwnsWorld(userId, world.id)));
}

export function readWorldAccessMetadata(worldDir: string, source: WorldSource = "user"): WorldAccessMetadata {
  const metaPath = path.join(worldDir, WORLD_META_FILENAME);
  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as Partial<WorldAccessMetadata>;
      return {
        ownerUserId: typeof parsed.ownerUserId === "string" && parsed.ownerUserId.trim()
          ? parsed.ownerUserId.trim()
          : DEFAULT_WORLD_OWNER_ID,
        visibility: parsed.visibility === "public" || parsed.visibility === "unlisted" || parsed.visibility === "private"
          ? parsed.visibility
          : "private",
        createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch (error) {
      console.warn(`[WorldX] Failed to read world access metadata from ${metaPath}:`, error);
    }
  }
  const timestamp = new Date().toISOString();
  return {
    ownerUserId: source === "library" ? "system" : DEFAULT_WORLD_OWNER_ID,
    visibility: source === "library" ? "public" : "private",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function writeWorldAccessMetadata(
  worldDir: string,
  input: { ownerUserId: string; visibility?: WorldVisibility },
): WorldAccessMetadata {
  const existing = readWorldAccessMetadata(worldDir);
  const timestamp = new Date().toISOString();
  const metadata: WorldAccessMetadata = {
    ownerUserId: input.ownerUserId,
    visibility: input.visibility ?? existing.visibility ?? "private",
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp,
  };
  fs.writeFileSync(
    path.join(worldDir, WORLD_META_FILENAME),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf-8",
  );
  return metadata;
}

function scanWorldsDir(baseDir: string, source: WorldSource): GeneratedWorldSummary[] {
  if (!isDirectory(baseDir)) {
    return [];
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(baseDir, entry.name);
      const metadata = readWorldAccessMetadata(dir, source);
      if (source === "user" && metadata.ownerUserId && metadata.ownerUserId !== "local_user") {
        accountAssets.ensureWorldAsset({
          userId: metadata.ownerUserId,
          worldId: entry.name,
          source,
          visibility: metadata.visibility,
          createdAt: metadata.createdAt,
        });
      }
      return {
        id: entry.name,
        worldName: readWorldName(dir),
        dir,
        source,
        ownerUserId: metadata.ownerUserId,
        visibility: metadata.visibility,
      };
    })
    .filter((entry): entry is GeneratedWorldSummary & { worldName: string } =>
      entry.worldName !== null && hasWorldConfig(entry.dir),
    )
    .sort((a, b) => b.id.localeCompare(a.id));
}

function readWorldName(worldDir: string): string | null {
  const candidates = [
    path.join(worldDir, "world.json"),
    path.join(worldDir, "config", "world.json"),
  ];

  for (const filePath of candidates) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as { worldName?: unknown };
      if (typeof parsed.worldName === "string" && parsed.worldName.trim()) {
        return parsed.worldName.trim();
      }
    } catch (error) {
      console.warn(`[WorldX] Failed to read world metadata from ${filePath}:`, error);
    }
  }

  return null;
}

function hasWorldConfig(worldDir: string): boolean {
  return (
    fs.existsSync(path.join(worldDir, "world.json")) ||
    fs.existsSync(path.join(worldDir, "config", "world.json"))
  );
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}
