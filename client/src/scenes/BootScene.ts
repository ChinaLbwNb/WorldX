import Phaser from "phaser";
import { SPRITE_FRAME_WIDTH, SPRITE_FRAME_HEIGHT } from "../config/game-config";

const MAP_TMJ_PATH = "/assets/map/06-final.tmj";
const MAP_BACKGROUND_PATH = "/assets/map/06-background.png";

export class BootScene extends Phaser.Scene {
  private characterIds: string[] = [];

  constructor() {
    super("BootScene");
  }

  async init() {
    // Fetch character manifest BEFORE preload so that all spritesheet assets
    // can be queued synchronously inside preload(). This avoids Phaser loader
    // timing issues caused by await inside preload().
    try {
      const res = await fetch("/api/characters");
      const characters: { id: string }[] = await res.json();
      this.characterIds = characters.map((c) => c.id);
      console.log(`[BootScene] Found ${this.characterIds.length} characters`);
    } catch (e) {
      console.warn("[BootScene] Failed to fetch character manifest:", e);
      this.characterIds = [];
    }
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
    const barFill = this.add.rectangle(barX, barY, 1, 6, 0x74b9ff).setOrigin(0, 0);

    const statusText = this.add.text(w / 2, barY + 24, "Loading...", {
      fontSize: "12px",
      color: "#888",
      fontFamily: "Arial",
    }).setOrigin(0.5);

    this.load.on("progress", (value: number) => {
      try {
        barFill.width = Math.max(1, barW * value);
        statusText.setText(`Loading... ${Math.round(value * 100)}%`);
      } catch (_) { /* protect the loader pipeline */ }
    });

    this.load.on("loaderror", (file: { key?: string; type?: string }) => {
      console.warn(`[BootScene] Failed to load asset: ${file.type} ${file.key}`);
    });

    this.load.json("world-map", MAP_TMJ_PATH);
    this.load.image("world-base", MAP_BACKGROUND_PATH);

    // Queue all character spritesheets synchronously (characterIds were
    // already fetched in init()).
    for (const charId of this.characterIds) {
      this.load.spritesheet(charId, `/assets/characters/${charId}/spritesheet.png`, {
        frameWidth: SPRITE_FRAME_WIDTH,
        frameHeight: SPRITE_FRAME_HEIGHT,
      });
    }
  }

  create() {
    for (const key of this.textures.getTextureKeys()) {
      if (key === "world-base" || this.characterIds.includes(key)) {
        this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR);
      }
    }
    console.log("[BootScene] Loading complete, starting WorldScene");
    console.log(`[BootScene] Loaded ${this.characterIds.length} character spritesheets`);
    this.scene.start("WorldScene");
  }
}
