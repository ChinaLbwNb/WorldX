import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { appContext } from "./services/app-context.js";
import { setupWebSocket } from "./api/websocket.js";

import worldRoutes from "./api/routes/world.js";
import worldsCreateRoutes from "./api/routes/worlds-create.js";
import characterRoutes from "./api/routes/characters.js";
import eventsRoutes from "./api/routes/events.js";
import { createPublicContentRouter } from "./api/routes/content.js";
import simulationRoutes from "./api/routes/simulation.js";
import godRoutes from "./api/routes/god.js";
import sandboxChatRoutes from "./api/routes/sandbox-chat.js";
import timelineRoutes from "./api/routes/timeline.js";
import authRoutes from "./api/routes/auth.js";
import userRoutes from "./api/routes/users.js";
import userCharacterRoutes from "./api/routes/user-characters.js";
import userCharacterRuntimeRoutes from "./api/routes/user-character-runtime.js";
import buildRoutes from "./api/routes/build.js";
import itemRoutes from "./api/routes/items.js";
import actorInteractionRoutes from "./api/routes/actor-interactions.js";
import taskRoutes from "./api/routes/tasks.js";
import { canUserAccessWorld, findWorldById, listLibraryWorlds, resolveInitialWorldDir } from "./utils/world-directories.js";
import { getAuthenticatedUser } from "./api/request-user.js";
import { getAccountAssetsRoot } from "./utils/account-assets.js";
import * as accountAssets from "./store/account-asset-store.js";
import { getAuthDb } from "./store/auth-store.js";
import { openDatabaseAt } from "./store/db.js";
import * as userCharacterStore from "./store/user-character-store.js";
import { isMultiplayerMode } from "./utils/app-mode.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function createWorldAssetHandler(assetDirName: "characters"): express.RequestHandler {
  return (req, res, next) => {
    const worldDir = appContext.getWorldDir();
    if (!worldDir) {
      res.status(404).end();
      return;
    }
    if (!canAccessWorldDirAsset(req, res, worldDir)) return;

    const relativePath = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (!relativePath) {
      res.status(404).end();
      return;
    }

    res.sendFile(relativePath, {
      root: path.join(worldDir, assetDirName),
      dotfiles: "deny",
    }, (error) => {
      if (!error) return;
      const assetError = error as NodeJS.ErrnoException & { status?: number };
      if (res.headersSent) {
        next(assetError);
        return;
      }
      if (assetError.status === 404) {
        res.status(404).end();
        return;
      }
      next(assetError);
    });
  };
}

function createAccountAssetHandler(): express.RequestHandler {
  return (req, res, next) => {
    const relativePath = decodeURIComponent(req.path).replace(/^\/+/, "");
    if (!relativePath || relativePath.includes("../")) {
      res.status(404).end();
      return;
    }
    const user = getAuthenticatedUser(req);
    const canRead = user
      ? accountAssets.userCanAccessAccountAsset(user.id, relativePath)
        || canAccessSharedAccountAsset(user.id, relativePath)
      : false;
    if (!user || !canRead) {
      res.status(user ? 403 : 401).end();
      return;
    }

    res.sendFile(relativePath, {
      root: getAccountAssetsRoot(),
      dotfiles: "deny",
    }, (error) => {
      if (!error) return;
      const assetError = error as NodeJS.ErrnoException & { status?: number };
      if (res.headersSent) {
        next(assetError);
        return;
      }
      if (assetError.status === 404) {
        res.status(404).end();
        return;
      }
      next(assetError);
    });
  };
}

type AssetPresence = { worldId: string; timelineId: string; currentMapId: string };

function canAccessSharedAccountAsset(userId: string, assetPath: string): boolean {
  const normalized = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.startsWith("user-characters/")) {
    return canAccessSharedUserCharacterAsset(userId, normalized);
  }
  if (normalized.startsWith("items/")) {
    return canAccessSharedPlacedItemAsset(userId, normalized);
  }
  return false;
}

function canAccessSharedUserCharacterAsset(userId: string, assetPath: string): boolean {
  const [, characterId] = assetPath.split("/");
  if (!characterId) return false;
  const presence = userCharacterStore.getUserCharacterPresence(characterId);
  if (!presence) return false;
  return userHasCharacterInPresence(userId, presence);
}

function canAccessSharedPlacedItemAsset(userId: string, assetPath: string): boolean {
  const presences = listUserCharacterPresences(userId);
  if (presences.length === 0) return false;
  const likeNeedle = `%${assetPath.replace(/[%_]/g, "\\$&")}%`;
  for (const presence of presences) {
    const world = findWorldById(presence.worldId);
    if (!world || !canUserAccessWorld(world, userId)) continue;
    const dbPath = appContext.timelineManager.getTimelineDbPath(world.dir, presence.timelineId);
    if (!fs.existsSync(dbPath)) continue;
    const db = openDatabaseAt(dbPath);
    try {
      const row = db.prepare(
        `SELECT 1 FROM map_item_placements
         WHERE world_id = ?
           AND timeline_id = ?
           AND map_id = ?
           AND state = 'placed'
           AND metadata LIKE ? ESCAPE '\\'
         LIMIT 1`,
      ).get(presence.worldId, presence.timelineId, presence.currentMapId, likeNeedle);
      if (row) return true;
    } finally {
      db.close();
    }
  }
  return false;
}

function userHasCharacterInPresence(userId: string, presence: AssetPresence): boolean {
  return listUserCharacterPresences(userId).some((candidate) => (
    candidate.worldId === presence.worldId
    && candidate.timelineId === presence.timelineId
    && candidate.currentMapId === presence.currentMapId
  ));
}

function listUserCharacterPresences(userId: string): AssetPresence[] {
  const rows = getAuthDb()
    .prepare(
      `SELECT r.world_id, r.timeline_id, r.current_map_id
       FROM account_user_characters c
       JOIN account_user_character_presence r ON r.character_id = c.id
       WHERE c.user_id = ?`,
    )
    .all(userId) as Array<{ world_id?: string; timeline_id?: string; current_map_id?: string }>;
  return rows
    .map((row) => ({
      worldId: row.world_id ?? "",
      timelineId: row.timeline_id ?? "",
      currentMapId: row.current_map_id ?? "map_origin",
    }))
    .filter((presence) => presence.worldId && presence.timelineId && presence.currentMapId);
}

function createWorldMapAssetHandler(): express.RequestHandler {
  return (req, res, next) => {
    const worldDir = appContext.getWorldDir();
    if (!worldDir) {
      res.status(404).end();
      return;
    }
    if (!canAccessWorldDirAsset(req, res, worldDir)) return;

    const relativePath = decodeURIComponent(req.path).replace(/^\/+/, "");
    const [mapId, ...rest] = relativePath.split("/");
    if (!mapId || rest.length === 0 || !/^[A-Za-z0-9_-]+$/.test(mapId)) {
      res.status(404).end();
      return;
    }

    const mapDir = appContext.worldManager.getMapDir(mapId);
    if (!mapDir) {
      res.status(404).end();
      return;
    }

    const filePath = rest.join("/");
    if (filePath === "background-tiles/manifest.json" && !fs.existsSync(path.join(mapDir, filePath))) {
      res.json({ width: 0, height: 0, tileSize: 0, tiles: [] });
      return;
    }

    res.sendFile(filePath, {
      root: mapDir,
      dotfiles: "deny",
    }, (error) => {
      if (!error) return;
      const assetError = error as NodeJS.ErrnoException & { status?: number };
      if (res.headersSent) {
        next(assetError);
        return;
      }
      if (assetError.status === 404) {
        res.status(404).end();
        return;
      }
      next(assetError);
    });
  };
}

function canAccessWorldDirAsset(
  req: express.Request,
  res: express.Response,
  worldDir: string,
): boolean {
  const worldId = path.basename(worldDir);
  const world = findWorldById(worldId);
  if (!world) {
    res.status(404).end();
    return false;
  }
  const user = getAuthenticatedUser(req);
  if (!isMultiplayerMode) {
    return true;
  }
  if (!canUserAccessWorld(world, user?.id)) {
    res.status(user ? 403 : 401).end();
    return false;
  }
  return true;
}

function createWorldScopedAssetHandler(): express.RequestHandler {
  return (req, res, next) => {
    const relativePath = decodeURIComponent(req.path).replace(/^\/+/, "");
    const [worldId, assetKind, ...rest] = relativePath.split("/");
    const world = worldId ? findWorldById(worldId) : undefined;
    if (!world || !assetKind || rest.length === 0) {
      res.status(404).end();
      return;
    }
    const user = getAuthenticatedUser(req);
    if (isMultiplayerMode && !canUserAccessWorld(world, user?.id)) {
      res.status(user ? 403 : 401).end();
      return;
    }

    let root: string | null = null;
    let filePath: string | null = null;
    if (assetKind === "maps") {
      const [mapId, ...mapRest] = rest;
      if (!mapId || mapRest.length === 0 || !/^[A-Za-z0-9_-]+$/.test(mapId)) {
        res.status(404).end();
        return;
      }
      root = resolveWorldMapDir(world.dir, mapId);
      filePath = mapRest.join("/");
    } else if (assetKind === "characters") {
      root = path.join(world.dir, "characters");
      filePath = rest.join("/");
    }

    if (!root || !filePath) {
      res.status(404).end();
      return;
    }

    if (filePath === "background-tiles/manifest.json" && !fs.existsSync(path.join(root, filePath))) {
      res.json({ width: 0, height: 0, tileSize: 0, tiles: [] });
      return;
    }

    res.sendFile(filePath, {
      root,
      dotfiles: "deny",
    }, (error) => {
      if (!error) return;
      const assetError = error as NodeJS.ErrnoException & { status?: number };
      if (res.headersSent) {
        next(assetError);
        return;
      }
      if (assetError.status === 404) {
        res.status(404).end();
        return;
      }
      next(assetError);
    });
  };
}

function resolveWorldMapDir(worldDir: string, mapId: string): string {
  const configPath = fs.existsSync(path.join(worldDir, "config", "world.json"))
    ? path.join(worldDir, "config", "world.json")
    : path.join(worldDir, "world.json");
  let mapDirName = mapId;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as {
      mapNodes?: Array<{ id?: string; mapDir?: string }>;
    };
    const nodes = Array.isArray(parsed.mapNodes) ? parsed.mapNodes : [];
    const mapNode = Array.isArray(nodes)
      ? nodes.find((map) => map.id === mapId)
      : undefined;
    mapDirName = mapNode?.mapDir || mapId;
  } catch {
    mapDirName = mapId;
  }
  const mapDir = path.join(worldDir, "maps", mapDirName);
  if (fs.existsSync(mapDir)) return mapDir;
  if (mapId === "map_origin") {
    const legacyMapDir = path.join(worldDir, "map");
    if (fs.existsSync(legacyMapDir)) return legacyMapDir;
  }
  return mapDir;
}

async function main() {
  const app = express();
  app.use(cors());
  app.use(express.json());

  const worldDir = resolveInitialWorldDir();
  if (worldDir) {
    console.log(`[WorldX] World dir: ${worldDir}`);
  } else {
    console.log("[WorldX] No generated world found — server starting in empty mode. Navigate to /create to generate your first world.");
  }

  await appContext.initialize(worldDir);
  console.log("[WorldX] All systems initialized");

  app.get("/api/health", (req, res) => {
    const user = getAuthenticatedUser(req);
    if (!appContext.hasWorld) {
      res.json({ status: "ok", project: "world-x", worldName: null, sceneConfig: null });
      return;
    }
    if (isMultiplayerMode && !user) {
      res.json({ status: "ok", project: "world-x", worldName: null, sceneConfig: null });
      return;
    }
    const wm = appContext.worldManager;
    res.json({
      status: "ok",
      project: "world-x",
      worldName: wm.getWorldName(),
      sceneConfig: wm.getSceneConfig(),
    });
  });

  app.use("/api/auth", authRoutes);

  app.get("/api/public/world-backgrounds", (_req, res) => {
    const backgrounds = listLibraryWorlds()
      .map((world) => {
        const bgPath = path.join(world.dir, "maps", "map_origin", "06-background.png");
        if (!fs.existsSync(bgPath)) return null;
        return {
          id: world.id,
          worldName: world.worldName,
          imageUrl: `/assets/worlds/${encodeURIComponent(world.id)}/maps/map_origin/06-background.png`,
        };
      })
      .filter((item): item is { id: string; worldName: string; imageUrl: string } => Boolean(item))
      .slice(0, 8);
    res.json({ backgrounds });
  });

  const requireAuth: express.RequestHandler = (req, res, next) => {
    if (!isMultiplayerMode) {
      next();
      return;
    }
    const user = getAuthenticatedUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const token = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (token) {
      res.cookie("worldx_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
      });
    }
    next();
  };

  // 多人模式需要账号；常规模式保持原 WorldX 的免登录基础流程。
  app.use("/api", requireAuth);

  // World creation & management routes work even without an active world.
  app.use("/api/worlds", worldsCreateRoutes);

  // Guard: all other API routes require an active world to be loaded.
  const requireWorld: express.RequestHandler = (_req, res, next) => {
    if (!appContext.hasWorld) {
      res.status(503).json({ error: "No world loaded. Create one first." });
      return;
    }
    next();
  };

  app.use("/api/world", worldRoutes);
  app.use("/api/tasks", taskRoutes);
  app.use("/api/characters", requireWorld, characterRoutes);
  app.use("/api/events", requireWorld, eventsRoutes);
  app.use("/api/content", requireWorld, createPublicContentRouter());
  app.use("/api/simulation", requireWorld, simulationRoutes);
  app.use("/api/god", requireWorld, godRoutes);
  app.use("/api/sandbox/chat", requireWorld, sandboxChatRoutes);
  app.use("/api/timelines", timelineRoutes);
  app.use("/api/users", requireWorld, userRoutes);
  app.use("/api/user-characters", requireWorld, userCharacterRoutes);
  app.use("/api/user-character-runtime", requireWorld, userCharacterRuntimeRoutes);
  app.use("/api/build", requireWorld, buildRoutes);
  app.use("/api/items", requireWorld, itemRoutes);
  app.use("/api/actor-interactions", requireWorld, actorInteractionRoutes);
  app.use("/api", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
  });

  app.use("/assets/worlds", createWorldScopedAssetHandler());
  app.use("/assets/maps", createWorldMapAssetHandler());
  app.use("/assets/characters", createWorldAssetHandler("characters"));
  app.use("/assets/account", createAccountAssetHandler());

  const clientDistPath = path.resolve("../client/dist");
  const clientIndexPath = path.join(clientDistPath, "index.html");
  if (fs.existsSync(clientDistPath) && fs.existsSync(clientIndexPath)) {
    app.use("/", express.static(clientDistPath));
    app.get("*", (_req, res) => {
      res.sendFile(clientIndexPath);
    });
  }

  const server = createServer(app);
  server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 600_000);
  server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 610_000);
  server.keepAliveTimeout = Number(process.env.HTTP_KEEP_ALIVE_TIMEOUT_MS || 65_000);
  setupWebSocket(server, appContext);

  const PORT = process.env.PORT || 3100;
  server.listen(PORT, () => {
    console.log(`[WorldX] Server running on http://localhost:${PORT}`);
    console.log(`[WorldX] WebSocket available on ws://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("[WorldX] Fatal error during startup:", err);
  process.exit(1);
});
