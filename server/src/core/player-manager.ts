import type { PlayerAvatarState, AvatarMode, PlayerMemory } from "../types/index.js";
import type { WorldManager } from "./world-manager.js";
import { generateId } from "../utils/id-generator.js";
import * as playerStore from "../store/player-state-store.js";
import * as userCharacterStore from "../store/user-character-store.js";
import { getDb } from "../store/db.js";

const DEFAULT_PLAYER_NAME = "旅行者";
const UNKNOWN_CONTEXT_ID = "unknown";

export class PlayerManager {
  private worldManager: WorldManager;
  private getWorldId: () => string | null;
  private getTimelineId: () => string | null;
  /** 所有玩家状态缓存：playerId → PlayerAvatarState */
  private players: Map<string, PlayerAvatarState> = new Map();

  constructor(
    worldManager: WorldManager,
    getWorldId: () => string | null = () => null,
    getTimelineId: () => string | null = () => null,
  ) {
    this.worldManager = worldManager;
    this.getWorldId = getWorldId;
    this.getTimelineId = getTimelineId;
  }

  private getPresenceContext(): userCharacterStore.PresenceContext {
    return {
      worldId: this.getWorldId() ?? UNKNOWN_CONTEXT_ID,
      timelineId: this.getTimelineId() ?? UNKNOWN_CONTEXT_ID,
      mapId: this.worldManager.getActiveMapId(),
    };
  }

  initialize(): void {
    userCharacterStore.ensureDefaultUser();
    userCharacterStore.migrateLegacyPlayerAvatars(this.getPresenceContext());
    // Server restarts do not preserve WebSocket clients. Clear stale online
    // flags before loading persisted user characters so old sessions are not
    // rendered as current remote avatars.
    userCharacterStore.resetAllUserCharactersOffline();
    playerStore.resetAllPlayersOffline();
    const all = userCharacterStore.getAllUserCharacterStates();
    this.players.clear();
    for (const p of all) {
      playerStore.initPlayerAvatar(p);
      playerStore.updatePlayerAvatar(p.id, p);
      this.players.set(p.id, p);
    }
  }

  /** 创建新玩家（WebSocket 连接时调用） */
  createPlayer(name?: string, userId: string = userCharacterStore.DEFAULT_USER_ID): PlayerAvatarState {
    const playerId = `player_${generateId()}`;
    const spawnPointId = this.worldManager.getSpreadMainAreaPointId(
      `player_spawn:${playerId}:${Date.now().toString(36)}`,
      new Set(),
    );
    const spawnPoint = spawnPointId ? this.worldManager.getMainAreaPoint(spawnPointId) : null;

    const state: PlayerAvatarState = {
      id: playerId,
      name: name || DEFAULT_PLAYER_NAME,
      mode: "avatar",
      location: "main_area",
      mainAreaPointId: spawnPointId,
      x: spawnPoint?.x ?? 0,
      y: spawnPoint?.y ?? 0,
      currentAction: null,
      currentActionTarget: null,
      actionStartTick: 0,
      actionEndTick: 0,
      isOnline: true,
      isControlledByLLM: false,
      appearance: { color: 0xffd700, sizeScale: 1.0 },
      inventory: [],
    };

    userCharacterStore.initUserCharacter(state, this.getPresenceContext(), userId);
    this.players.set(playerId, state);
    return state;
  }

  /** 创建用户拥有的可操作角色。 */
  createUserCharacter(
    name?: string,
    userId: string = userCharacterStore.DEFAULT_USER_ID,
    appearance?: Partial<PlayerAvatarState["appearance"]>,
  ): PlayerAvatarState {
    const state = this.createPlayer(name, userId);
    this.updatePlayer(state.id, {
      isOnline: false,
      isControlledByLLM: false,
      appearance: {
        ...state.appearance,
        ...appearance,
      },
    });
    return this.getPlayer(state.id, userId) ?? { ...state, isOnline: false, isControlledByLLM: false };
  }

  createStarterUserCharactersForNewAccount(userId: string): PlayerAvatarState[] {
    userCharacterStore.dedupeDefaultUserCharacters(userId);
    const existing = this.getAllPlayers(userId);
    if (existing.length > 0) return existing;

    return [
      this.createUserCharacter("默认男角色", userId, {
        color: 0x5aa8ff,
        sizeScale: 1.0,
        assetStatus: "ready",
        prompt: "默认男性用户角色",
      }),
      this.createUserCharacter("默认女角色", userId, {
        color: 0xff8fc7,
        sizeScale: 1.0,
        assetStatus: "ready",
        prompt: "默认女性用户角色",
      }),
    ];
  }

  /** 用户角色进入当前 active map 的默认出生点。 */
  enterActiveMap(playerId: string, userId?: string): PlayerAvatarState | null {
    const player = this.getPlayer(playerId, userId);
    if (!player) return null;

    const spawnPointId = this.worldManager.getSpreadMainAreaPointId(
      `user_character_enter:${playerId}:${this.worldManager.getActiveMapId()}:${Date.now().toString(36)}`,
      new Set(),
    );
    const spawnPoint = spawnPointId ? this.worldManager.getMainAreaPoint(spawnPointId) : null;
    const worldSize = this.worldManager.getWorldSize();
    const next = {
      mode: "avatar" as const,
      worldId: this.getPresenceContext().worldId,
      timelineId: this.getPresenceContext().timelineId,
      currentMapId: this.worldManager.getActiveMapId(),
      location: "main_area",
      mainAreaPointId: spawnPointId,
      x: spawnPoint?.x ?? (worldSize ? Math.floor(worldSize.width / 2) : 0),
      y: spawnPoint?.y ?? (worldSize ? Math.floor(worldSize.height / 2) : 0),
    };
    this.updatePlayer(playerId, next);
    return this.getPlayer(playerId);
  }

  deleteUserCharacter(playerId: string, userId?: string): boolean {
    const deleted = userCharacterStore.deleteUserCharacter(playerId, userId);
    if (deleted) this.players.delete(playerId);
    return deleted;
  }

  /** 获取玩家（不存在则返回 null） */
  getPlayer(playerId: string, userId?: string): PlayerAvatarState | null {
    if (this.players.has(playerId)) {
      if (userId && !userCharacterStore.userOwnsCharacter(userId, playerId)) return null;
      return this.players.get(playerId)!;
    }
    const fromDb = userCharacterStore.getUserCharacterState(playerId, userId)
      ?? playerStore.getPlayerAvatarOrNull(playerId);
    if (fromDb) {
      if (userId && !userCharacterStore.userOwnsCharacter(userId, playerId)) return null;
      this.players.set(playerId, fromDb);
      return fromDb;
    }
    return null;
  }

  getPlayerMapId(playerId: string): string {
    return userCharacterStore.getUserCharacterMapId(playerId) ?? this.worldManager.getActiveMapId();
  }

  getPlayerPresence(playerId: string): { worldId: string; timelineId: string; currentMapId: string } {
    const fallback = this.getPresenceContext();
    return userCharacterStore.getUserCharacterPresence(playerId) ?? {
      worldId: fallback.worldId,
      timelineId: fallback.timelineId,
      currentMapId: fallback.mapId,
    };
  }

  /** 获取所有在线且处于化身模式的玩家 */
  getOnlineAvatarPlayers(): PlayerAvatarState[] {
    return Array.from(this.players.values()).filter(
      (p) => p.isOnline && p.mode === "avatar",
    );
  }

  /** 获取所有在线玩家 */
  getOnlinePlayers(): PlayerAvatarState[] {
    return Array.from(this.players.values()).filter((p) => p.isOnline);
  }

  /** 获取所有用户可操作角色。 */
  getAllPlayers(userId?: string): PlayerAvatarState[] {
    if (!userId) return Array.from(this.players.values());
    return userCharacterStore.getAllUserCharacterStates(userId);
  }

  userOwnsCharacter(userId: string, playerId: string): boolean {
    return userCharacterStore.userOwnsCharacter(userId, playerId);
  }

  captureUserCharacterSnapshots(): ReturnType<typeof userCharacterStore.captureSnapshots> {
    return userCharacterStore.captureSnapshots(this.getPresenceContext());
  }

  seedUserCharacterSnapshots(snapshots: ReturnType<typeof userCharacterStore.captureSnapshots>): void {
    userCharacterStore.ensureDefaultUser();
    userCharacterStore.seedSnapshots(snapshots, this.getPresenceContext());
    this.players.clear();
    for (const state of userCharacterStore.getAllUserCharacterStates()) {
      this.players.set(state.id, state);
    }
  }

  /** 更新玩家状态 */
  updatePlayer(playerId: string, patch: Partial<PlayerAvatarState> & { worldId?: string; timelineId?: string; currentMapId?: string }): void {
    const state = this.players.get(playerId);
    if (state) {
      Object.assign(state, patch);
    }
    userCharacterStore.updateUserCharacterState(playerId, patch);
  }

  /** 更新玩家位置 */
  updatePosition(
    playerId: string,
    x: number,
    y: number,
    location: string,
    mainAreaPointId: string | null,
  ): void {
    this.updatePlayer(playerId, { x, y, location, mainAreaPointId });
  }

  /** 切换模式 */
  setMode(playerId: string, mode: AvatarMode): void {
    this.updatePlayer(playerId, { mode });
  }

  /** 设置在线状态 */
  setOnline(playerId: string, online: boolean): void {
    this.updatePlayer(playerId, { isOnline: online });
  }

  /** LLM 接管 */
  activateLLMTakeover(playerId: string): void {
    this.updatePlayer(playerId, { isControlledByLLM: true });
  }

  deactivateLLMTakeover(playerId: string): void {
    this.updatePlayer(playerId, { isControlledByLLM: false });
  }

  /** 开始动作 */
  startAction(
    playerId: string,
    action: string,
    target: string,
    startTick: number,
    endTick: number,
  ): void {
    this.updatePlayer(playerId, {
      currentAction: action,
      currentActionTarget: target,
      actionStartTick: startTick,
      actionEndTick: endTick,
    });
  }

  clearAction(playerId: string): void {
    this.updatePlayer(playerId, {
      currentAction: null,
      currentActionTarget: null,
      actionStartTick: 0,
      actionEndTick: 0,
    });
  }

  /** 移除玩家（断开连接时清理） */
  removePlayer(playerId: string): void {
    this.players.delete(playerId);
  }

  // ===== 兼容旧 API（第一个本地玩家） =====

  /** 获取第一个本地玩家（兼容旧代码） */
  getState(): PlayerAvatarState {
    const first = this.players.values().next().value;
    if (!first) throw new Error("No player initialized");
    return first;
  }

  getStateNoThrow(): PlayerAvatarState | null {
    return this.players.values().next().value ?? null;
  }

  isAvatarMode(): boolean {
    const first = this.players.values().next().value;
    return first?.mode === "avatar";
  }

  // ===== 记忆（按玩家 ID） =====

  addMemory(
    playerId: string,
    type: PlayerMemory["type"],
    content: string,
    gameDay: number,
    gameTick: number,
    importance: number = 5,
    emotionalValence: number = 0,
    emotionalIntensity: number = 0,
    relatedCharacters: string[] = [],
    relatedLocation: string = "",
    tags: string[] = [],
  ): PlayerMemory {
    const memory: PlayerMemory = {
      id: generateId(),
      playerId,
      type,
      content,
      gameDay,
      gameTick,
      importance,
      emotionalValence,
      emotionalIntensity,
      relatedCharacters,
      relatedLocation,
      tags,
    };

    getDb()
      .prepare(
        `INSERT INTO player_memories
         (id, player_id, type, content, game_day, game_tick,
          importance, emotional_valence, emotional_intensity,
          related_characters, related_location, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memory.id, memory.playerId, memory.type, memory.content,
        memory.gameDay, memory.gameTick, memory.importance,
        memory.emotionalValence, memory.emotionalIntensity,
        JSON.stringify(memory.relatedCharacters),
        memory.relatedLocation,
        JSON.stringify(memory.tags),
      );

    return memory;
  }

  getRecentMemories(playerId: string, limit: number = 10): PlayerMemory[] {
    return (
      getDb()
        .prepare(
          `SELECT * FROM player_memories WHERE player_id = ? ORDER BY game_day DESC, game_tick DESC LIMIT ?`,
        )
        .all(playerId, limit) as any[]
    ).map(rowToPlayerMemory);
  }
}

function rowToPlayerMemory(row: any): PlayerMemory {
  return {
    id: row.id,
    playerId: row.player_id,
    type: row.type,
    content: row.content,
    gameDay: row.game_day,
    gameTick: row.game_tick,
    importance: row.importance,
    emotionalValence: row.emotional_valence,
    emotionalIntensity: row.emotional_intensity,
    relatedCharacters: JSON.parse(row.related_characters || "[]"),
    relatedLocation: row.related_location,
    tags: JSON.parse(row.tags || "[]"),
  };
}
