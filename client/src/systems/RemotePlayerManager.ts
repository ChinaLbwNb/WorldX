import Phaser from "phaser";
import { CharacterSprite } from "../objects/CharacterSprite";
import { createCharacterDisplayMetrics, SPRITE_FRAME_HEIGHT, SPRITE_FRAME_WIDTH } from "../config/game-config";
import { withAssetAuth } from "../utils/asset-url";

const REMOTE_PLAYER_COLORS = [0x74b9ff, 0x00b894, 0xe17055, 0xfd79a8, 0xfdcb6e, 0x6c5ce7];

interface RemotePlayerData {
  id: string;
  name: string;
  x: number;
  y: number;
  borrowedSpriteId: string | null;
  appearance?: {
    color?: number;
    spriteKey?: string;
    spriteUrl?: string;
  };
}

export class RemotePlayerManager {
  private scene: Phaser.Scene;
  private entityLayer: Phaser.GameObjects.Container;
  sprites: Map<string, { sprite: CharacterSprite; colorIndex: number }> = new Map();
  private displayMetrics: ReturnType<typeof createCharacterDisplayMetrics>;
  private nextColorIndex = 0;
  private borrowedSpriteIds: string[] = [];
  private playerVersions = new Map<string, number>();

  constructor(
    scene: Phaser.Scene,
    entityLayer: Phaser.GameObjects.Container,
    mapPixelWidth: number,
    mapPixelHeight: number,
  ) {
    this.scene = scene;
    this.entityLayer = entityLayer;
    this.displayMetrics = createCharacterDisplayMetrics(mapPixelWidth, mapPixelHeight);
  }

  setBorrowedSpriteIds(ids: string[]): void {
    this.borrowedSpriteIds = ids;
  }

  addPlayer(data: RemotePlayerData): void {
    void this.addPlayerAsync(data);
  }

  private async addPlayerAsync(data: RemotePlayerData): Promise<void> {
    const version = (this.playerVersions.get(data.id) ?? 0) + 1;
    this.playerVersions.set(data.id, version);
      // 已存在（如改名后重新广播 user_character_joined）：更新名字与位置，不重复创建精灵
    const existing = this.sprites.get(data.id);
    if (existing) {
      existing.sprite.setDisplayName(data.name);
      existing.sprite.setPosition(data.x, data.y);
      return;
    }

    const colorIndex = this.nextColorIndex;
    this.nextColorIndex = (this.nextColorIndex + 1) % REMOTE_PLAYER_COLORS.length;
    const color = data.appearance?.color ?? REMOTE_PLAYER_COLORS[colorIndex];

    // 借用 NPC 精灵图：优先用传入的，其次用列表中循环的，最后扫描纹理
    const ownSpriteId = await this.ensureUserCharacterTexture(data);
    if (this.playerVersions.get(data.id) !== version || this.sprites.has(data.id)) {
      return;
    }
    const spriteId =
      ownSpriteId
      ?? data.borrowedSpriteId
      ?? this.borrowedSpriteIds[colorIndex % Math.max(1, this.borrowedSpriteIds.length)]
      ?? this.findAnySpriteTexture()
      ?? data.id;

    const sprite = new CharacterSprite(this.scene, data.x, data.y, {
      characterId: spriteId,
      name: data.name,
      color,
      displayMetrics: this.displayMetrics,
    });

    sprite.setDepth(15);
    sprite.currentLocationId = "main_area";
    this.entityLayer.add(sprite);
    this.sprites.set(data.id, { sprite, colorIndex });
  }

  private async ensureUserCharacterTexture(data: RemotePlayerData): Promise<string | null> {
    const spriteUrl = data.appearance?.spriteUrl;
    const spriteKey = data.appearance?.spriteKey || (data.id ? `user_character_${data.id}` : "");
    if (!spriteUrl || !spriteKey) return null;
    if (this.scene.textures.exists(spriteKey)) return spriteKey;
    return new Promise((resolve) => {
      this.scene.load.spritesheet(spriteKey, withAssetAuth(spriteUrl), {
        frameWidth: SPRITE_FRAME_WIDTH,
        frameHeight: SPRITE_FRAME_HEIGHT,
      });
      this.scene.load.once(Phaser.Loader.Events.COMPLETE, () => {
        if (this.scene.textures.exists(spriteKey)) {
          this.scene.textures.get(spriteKey).setFilter(Phaser.Textures.FilterMode.LINEAR);
          resolve(spriteKey);
          return;
        }
        resolve(null);
      });
      this.scene.load.once("loaderror", () => resolve(null));
      this.scene.load.start();
    });
  }

  removePlayer(playerId: string): void {
    this.playerVersions.set(playerId, (this.playerVersions.get(playerId) ?? 0) + 1);
    const entry = this.sprites.get(playerId);
    if (entry) {
      entry.sprite.destroy();
      this.sprites.delete(playerId);
    }
  }

  retainOnly(playerIds: Set<string>): void {
    for (const playerId of Array.from(this.sprites.keys())) {
      if (playerIds.has(playerId)) continue;
      this.removePlayer(playerId);
    }
  }

  updatePosition(playerId: string, x: number, y: number): void {
    const entry = this.sprites.get(playerId);
    if (!entry) return;

    const dx = x - entry.sprite.x;
    const dy = y - entry.sprite.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 2) {
      this.scene.tweens.add({
        targets: entry.sprite,
        x,
        y,
        duration: 150,
        ease: "Linear",
      });
      entry.sprite.setWalkDirection(dx, dy);
    } else {
      entry.sprite.setWalkDirection(0, 0);
    }
  }

  syncZoom(zoom: number): void {
    for (const { sprite } of this.sprites.values()) {
      sprite.syncOverlayZoom(zoom);
    }
  }

  /** 在已加载的纹理中查找任意精灵图 */
  private findAnySpriteTexture(): string | null {
    for (const key of this.scene.textures.getTextureKeys()) {
      if (key.startsWith("char_")) return key;
    }
    return null;
  }

  clear(): void {
    for (const { sprite } of this.sprites.values()) {
      sprite.destroy();
    }
    this.sprites.clear();
    this.nextColorIndex = 0;
    this.playerVersions.clear();
  }

  destroy(): void {
    this.clear();
  }
}
