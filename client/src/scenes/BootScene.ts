import Phaser from "phaser";
import { isMultiplayerMode } from "../config/app-mode";
import { SPRITE_FRAME_WIDTH, SPRITE_FRAME_HEIGHT } from "../config/game-config";
import { withAssetAuth } from "../utils/asset-url";

const FALLBACK_MAP_ASSET_PREFIX = "/assets/maps/map_origin";
const FALLBACK_CHARACTER_ASSET_PREFIX = "/assets/characters";
const LS_USER_ID = "worldx_user_id";
const LS_AUTH_TOKEN = "worldx_auth_token";
const LS_USER_CHARACTER_ID = "worldx_user_character_id";

interface BackgroundTileInfo {
  key: string;
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface BackgroundTilesManifest {
  width: number;
  height: number;
  tileSize: number;
  tiles: BackgroundTileInfo[];
}

export class BootScene extends Phaser.Scene {
  private characterIds: string[] = [];
  private mapAssetPrefix = FALLBACK_MAP_ASSET_PREFIX;
  private characterAssetPrefix = FALLBACK_CHARACTER_ASSET_PREFIX;
  private barFill: Phaser.GameObjects.Rectangle | null = null;
  private statusText: Phaser.GameObjects.Text | null = null;

  constructor() {
    super("BootScene");
  }

  preload() {
    const w = this.cameras.main.width;
    const h = this.cameras.main.height;

    this.add.text(w / 2, h / 2 - 20, "WorldX", {
      fontSize: "24px",
      color: "#e0e0e0",
      fontFamily: "Arial",
    }).setOrigin(0.5);

    const barW = 320;
    const barY = h / 2 + 20;
    const barX = (w - barW) / 2;

    this.add.rectangle(barX + barW / 2, barY + 3, barW, 6, 0x333333);
    this.barFill = this.add.rectangle(barX, barY, 1, 6, 0x74b9ff).setOrigin(0, 0);

    this.statusText = this.add.text(w / 2, barY + 24, "Loading...", {
      fontSize: "12px",
      color: "#888",
      fontFamily: "Arial",
    }).setOrigin(0.5);
  }

  create() {
    void this.loadRuntimeAssets();
  }

  private async loadRuntimeAssets() {
    const barW = 320;
    this.setStatus("Loading world state...");
    await this.resolveRuntimeState();
    this.registry.set("mapAssetPrefix", this.mapAssetPrefix);
    this.registry.set("characterAssetPrefix", this.characterAssetPrefix);
    this.registry.set("mapBackgroundUrl", withAssetAuth(`${this.mapAssetPrefix}/06-background.png`));
    this.clearPreviousMapAssets();

    this.load.off("progress");
    this.load.off("loaderror");
    this.load.off(Phaser.Loader.Events.COMPLETE);
    this.load.on("progress", (value: number) => {
      try {
        if (this.barFill) this.barFill.width = Math.max(1, barW * value);
        this.setStatus(`Loading... ${Math.round(value * 100)}%`);
      } catch (_) { /* protect the loader pipeline */ }
    });

    this.load.on("loaderror", (file: { key?: string; type?: string }) => {
      console.warn(`[BootScene] Failed to load asset: ${file.type} ${file.key}`);
    });

    this.load.json("world-map", withAssetAuth(`${this.mapAssetPrefix}/06-final.tmj`));
    const manifest = await this.fetchBackgroundTilesManifest();
    if (manifest?.tiles?.length) {
      this.cache.json.add("world-background-tiles", manifest);
      console.log(`[BootScene] Queueing ${manifest.tiles.length} background tile(s)`);
      for (const tile of manifest.tiles) {
        this.load.image(tile.key, withAssetAuth(`${this.mapAssetPrefix}/${tile.path}`));
      }
    } else {
      this.cache.json.remove("world-background-tiles");
    }

    for (const charId of this.characterIds) {
      this.load.spritesheet(charId, withAssetAuth(`${this.characterAssetPrefix}/${encodeURIComponent(charId)}/spritesheet.png`), {
        frameWidth: SPRITE_FRAME_WIDTH,
        frameHeight: SPRITE_FRAME_HEIGHT,
      });
    }

    this.load.once(Phaser.Loader.Events.COMPLETE, () => {
      for (const key of this.textures.getTextureKeys()) {
      if (key === "world-base" || key.startsWith("world-base-tile-") || this.characterIds.includes(key)) {
        this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
      }
      console.log("[BootScene] Loading complete, starting WorldScene");
      console.log(`[BootScene] Loaded ${this.characterIds.length} character spritesheets`);
      this.scene.start("WorldScene");
    });

    this.load.start();
  }

  private async resolveRuntimeState() {
    const selectedCharacterId = this.getSelectedUserCharacterId();
    try {
      const query = isMultiplayerMode && selectedCharacterId
        ? `?userCharacterId=${encodeURIComponent(selectedCharacterId)}`
        : "";
      const res = await fetch(`/api/characters${query}`, {
        cache: "no-store",
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const characters: { id: string }[] = await res.json();
      this.characterIds = characters.map((c) => c.id);
      console.log(`[BootScene] Found ${this.characterIds.length} characters`);
    } catch (e) {
      console.warn("[BootScene] Failed to fetch character manifest:", e);
      this.characterIds = [];
    }
    try {
      const query = isMultiplayerMode && selectedCharacterId
        ? `?userCharacterId=${encodeURIComponent(selectedCharacterId)}`
        : "";
      const res = await fetch(`/api/world/maps${query}`, {
        cache: "no-store",
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const state: { currentWorldId?: string; activeMapId?: string } = await res.json();
      if (state.currentWorldId && state.activeMapId) {
        const worldId = encodeURIComponent(state.currentWorldId);
        const mapId = encodeURIComponent(state.activeMapId);
        this.mapAssetPrefix = `/assets/worlds/${worldId}/maps/${mapId}`;
        this.characterAssetPrefix = `/assets/worlds/${worldId}/characters`;
      } else if (state.activeMapId) {
        this.mapAssetPrefix = `/assets/maps/${encodeURIComponent(state.activeMapId)}`;
        this.characterAssetPrefix = FALLBACK_CHARACTER_ASSET_PREFIX;
      }
      console.log(`[BootScene] Active map asset prefix: ${this.mapAssetPrefix}`);
    } catch (e) {
      console.warn("[BootScene] Failed to fetch active map state:", e);
      this.mapAssetPrefix = FALLBACK_MAP_ASSET_PREFIX;
    }
  }

  private async fetchBackgroundTilesManifest(): Promise<BackgroundTilesManifest | null> {
    try {
      const res = await fetch(withAssetAuth(`${this.mapAssetPrefix}/background-tiles/manifest.json`), {
        cache: "no-store",
        headers: this.getAuthHeaders(),
      });
      if (!res.ok) return null;
      const manifest = await res.json() as BackgroundTilesManifest;
      return manifest?.tiles?.length ? manifest : null;
    } catch (e) {
      console.warn("[BootScene] Failed to fetch background tiles manifest:", e);
      return null;
    }
  }

  private getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    try {
      const userId = localStorage.getItem(LS_USER_ID) ?? "";
      const token = localStorage.getItem(LS_AUTH_TOKEN) ?? "";
      if (userId) headers["x-user-id"] = userId;
      if (token) headers.Authorization = `Bearer ${token}`;
    } catch {
      // BootScene can still load public assets in legacy/dev contexts.
    }
    return headers;
  }

  private getSelectedUserCharacterId(): string {
    try {
      return localStorage.getItem(LS_USER_CHARACTER_ID) || "";
    } catch {
      return "";
    }
  }

  private clearPreviousMapAssets() {
    this.cache.json.remove("world-map");
    this.cache.json.remove("world-background-tiles");
    if (this.textures.exists("world-base")) {
      this.textures.remove("world-base");
    }
    for (const key of this.textures.getTextureKeys()) {
      if (key.startsWith("world-base-tile-")) {
        this.textures.remove(key);
      }
      if (key.startsWith("world-base-canvas-tile-")) {
        this.textures.remove(key);
      }
    }
  }

  private setStatus(text: string) {
    this.statusText?.setText(text);
  }
}
