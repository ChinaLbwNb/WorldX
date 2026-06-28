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
import playerRoutes from "./api/routes/player.js";
import authRoutes from "./api/routes/auth.js";
import userRoutes from "./api/routes/users.js";
import userCharacterRoutes from "./api/routes/user-characters.js";
import buildRoutes from "./api/routes/build.js";
import itemRoutes from "./api/routes/items.js";
import { canUserAccessWorld, findWorldById, resolveInitialWorldDir } from "./utils/world-directories.js";
import { getAuthenticatedUser } from "./api/request-user.js";
import { getAccountAssetsRoot } from "./utils/account-assets.js";
import * as accountAssets from "./store/account-asset-store.js";

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
    if (!user || !accountAssets.userCanAccessAccountAsset(user.id, relativePath)) {
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
    if (!canUserAccessWorld(world, user?.id)) {
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
      worldMaps?: Array<{ id?: string; mapDir?: string }>;
    };
    const mapNode = Array.isArray(parsed.worldMaps)
      ? parsed.worldMaps.find((map) => map.id === mapId)
      : undefined;
    mapDirName = mapNode?.mapDir || mapId;
  } catch {
    mapDirName = mapId;
  }
  return path.join(worldDir, "maps", mapDirName);
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

  // 房间邀请码门禁：配置 ROOM_INVITE_CODE 后，所有 /api 请求（health 除外）
  // 必须携带匹配的 x-room-code 头或 ?code= 查询参数，否则 403。
  const requireInviteCode: express.RequestHandler = (req, res, next) => {
    const inviteCode = (process.env.ROOM_INVITE_CODE ?? "").trim();
    if (!inviteCode) {
      next();
      return;
    }
    const provided =
      (typeof req.headers["x-room-code"] === "string"
        ? (req.headers["x-room-code"] as string)
        : ""
      ).trim() || (typeof req.query.code === "string" ? req.query.code.trim() : "");
    if (provided !== inviteCode) {
      res.status(403).json({ error: "Invalid room invite code." });
      return;
    }
    next();
  };

  app.get("/api/health", (req, res) => {
    const user = getAuthenticatedUser(req);
    if (!appContext.hasWorld) {
      res.json({ status: "ok", project: "world-x", worldName: null, sceneConfig: null });
      return;
    }
    if (!user) {
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

  // 邀请码门禁：作用于 health 之后的所有 /api 路由
  app.use("/api", requireInviteCode);

  app.use("/api/auth", authRoutes);

  const requireAuth: express.RequestHandler = (req, res, next) => {
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

  // All game APIs require a logged-in account. The client app shell and
  // /api/auth stay public so users can reach the login/register screen.
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
  app.use("/api/characters", requireWorld, characterRoutes);
  app.use("/api/events", requireWorld, eventsRoutes);
  app.use("/api/content", requireWorld, createPublicContentRouter());
  app.use("/api/simulation", requireWorld, simulationRoutes);
  app.use("/api/god", requireWorld, godRoutes);
  app.use("/api/sandbox/chat", requireWorld, sandboxChatRoutes);
  app.use("/api/timelines", timelineRoutes);
  app.use("/api/users", requireWorld, userRoutes);
  app.use("/api/user-characters", requireWorld, userCharacterRoutes);
  app.use("/api/player", requireWorld, playerRoutes);
  app.use("/api/build", requireWorld, buildRoutes);
  app.use("/api/items", requireWorld, itemRoutes);

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
