import { getDb } from "./db.js";
import * as playerStore from "./player-state-store.js";
import { getAuthDb } from "./auth-store.js";
import type { PlayerAvatarState, UserCharacter } from "../types/index.js";

export const DEFAULT_USER_ID = "local_user";

type UserCharacterSnapshot = {
  character: UserCharacter;
  runtime: PlayerAvatarState & { worldId?: string; timelineId?: string; currentMapId?: string };
};

type DefaultCharacterRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  is_online: number;
};

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToState(row: any): PlayerAvatarState {
  return {
    id: row.id,
    name: row.name,
    mode: "avatar",
    location: row.location ?? "main_area",
    mainAreaPointId: row.main_area_point_id ?? null,
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    currentAction: row.current_action ?? null,
    currentActionTarget: row.current_action_target ?? null,
    actionStartTick: Number(row.action_start_tick ?? 0),
    actionEndTick: Number(row.action_end_tick ?? 0),
    isOnline: row.is_online === 1,
    isControlledByLLM: row.is_controlled_by_llm === 1,
    appearance: parseJson(row.appearance, { color: 0xffd700, sizeScale: 1 }),
    inventory: parseJson(row.inventory, []),
  };
}

export type PresenceContext = {
  worldId: string;
  timelineId: string;
  mapId: string;
};

function stateToSnapshot(state: PlayerAvatarState, context: PresenceContext, userId: string = DEFAULT_USER_ID): UserCharacterSnapshot {
  return {
    character: {
      id: state.id,
      userId,
      name: state.name,
      appearance: state.appearance,
      inventory: state.inventory,
    },
    runtime: { ...state, worldId: context.worldId, timelineId: context.timelineId, currentMapId: context.mapId },
  };
}

export function ensureUser(userId: string = DEFAULT_USER_ID, displayName?: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO users (id, display_name)
       VALUES (?, ?)`,
    )
    .run(userId, displayName || (userId === DEFAULT_USER_ID ? "本地用户" : userId));
}

export function ensureDefaultUser(): void {
  ensureUser(DEFAULT_USER_ID, "本地用户");
}

export type UserAccountView = {
  id: string;
  displayName: string;
  characterCount: number;
  createdAt: string;
  updatedAt: string;
};

export function getUserAccount(userId: string): UserAccountView | null {
  const row = getDb()
    .prepare(
      `SELECT u.id, u.display_name, u.created_at, u.updated_at,
              COUNT(c.id) AS character_count
       FROM users u
       LEFT JOIN user_characters c ON c.user_id = u.id
       WHERE u.id = ?
       GROUP BY u.id`,
    )
    .get(userId) as any;
  return row ? rowToUserAccount(row) : null;
}

export function listUserAccounts(): UserAccountView[] {
  const rows = getDb()
    .prepare(
      `SELECT u.id, u.display_name, u.created_at, u.updated_at,
              COUNT(c.id) AS character_count
       FROM users u
       LEFT JOIN user_characters c ON c.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at ASC, u.id ASC`,
    )
    .all() as any[];
  return rows.map(rowToUserAccount);
}

export function createUserAccount(userId: string, displayName: string): UserAccountView {
  const safeName = displayName.trim().slice(0, 32) || userId;
  ensureUser(userId, safeName);
  getDb()
    .prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(safeName, userId);
  const account = getUserAccount(userId);
  if (!account) throw new Error(`Failed to create user account: ${userId}`);
  return account;
}

export function updateUserAccount(userId: string, displayName: string): UserAccountView | null {
  const safeName = displayName.trim().slice(0, 32);
  if (!safeName) return null;
  const result = getDb()
    .prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(safeName, userId);
  if (result.changes === 0) return null;
  return getUserAccount(userId);
}

export function deleteUserAccount(userId: string): { ok: true } | { ok: false; reason: string } {
  if (userId === DEFAULT_USER_ID) {
    return { ok: false, reason: "Default local user cannot be deleted" };
  }
  const account = getUserAccount(userId);
  if (!account) return { ok: false, reason: "User not found" };
  if (account.characterCount > 0) {
    return { ok: false, reason: "User still has characters" };
  }
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
  return { ok: true };
}

export function dedupeDefaultUserCharacters(userId?: string): string[] {
  const db = getAuthDb();
  const rows = (
    userId
      ? db.prepare(
        `SELECT c.id, c.user_id, c.name, c.created_at, COALESCE(r.is_online, 0) AS is_online
         FROM account_user_characters c
         LEFT JOIN account_user_character_presence r ON r.character_id = c.id
         WHERE c.user_id = ?
           AND c.name IN ('默认男角色', '默认女角色')`,
      ).all(userId)
      : db.prepare(
        `SELECT c.id, c.user_id, c.name, c.created_at, COALESCE(r.is_online, 0) AS is_online
         FROM account_user_characters c
         LEFT JOIN account_user_character_presence r ON r.character_id = c.id
         WHERE c.name IN ('默认男角色', '默认女角色')`,
      ).all()
  ) as DefaultCharacterRow[];

  const groups = new Map<string, DefaultCharacterRow[]>();
  for (const row of rows) {
    const key = `${row.user_id}::${row.name}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  const deletedIds: string[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const preferredId = group[0]?.name === "默认男角色"
      ? "player_default_male"
      : "player_default_female";
    const sorted = [...group].sort((a, b) => {
      const onlineDelta = Number(b.is_online === 1) - Number(a.is_online === 1);
      if (onlineDelta !== 0) return onlineDelta;
      const preferredDelta = Number(b.id === preferredId) - Number(a.id === preferredId);
      if (preferredDelta !== 0) return preferredDelta;
      const createdDelta = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
      if (createdDelta !== 0) return createdDelta;
      return a.id.localeCompare(b.id);
    });
    deletedIds.push(...sorted.slice(1).map((row) => row.id));
  }

  if (deletedIds.length === 0) return [];
  const tx = db.transaction(() => {
    for (const id of deletedIds) {
      db.prepare("DELETE FROM account_user_character_presence WHERE character_id = ?").run(id);
      db.prepare("DELETE FROM account_user_characters WHERE id = ?").run(id);
      getDb().prepare("DELETE FROM player_avatar WHERE id = ?").run(id);
    }
  });
  tx();
  return deletedIds;
}

function rowToUserAccount(row: any): UserAccountView {
  return {
    id: row.id,
    displayName: row.display_name ?? row.id,
    characterCount: Number(row.character_count ?? 0),
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

export function migrateLegacyPlayerAvatars(context: PresenceContext): void {
  const legacyPlayers = playerStore.getAllPlayers();
  const accountDb = getAuthDb();
  const legacyOwnerId = resolveLegacyOwnerUserId(accountDb);
  if (!legacyOwnerId) return;
  const insertCharacter = accountDb.prepare(
    `INSERT OR IGNORE INTO account_user_characters
     (id, user_id, name, appearance, inventory)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const insertRuntime = accountDb.prepare(
    `INSERT OR IGNORE INTO account_user_character_presence
     (character_id, world_id, timeline_id, current_map_id, location, main_area_point_id, x, y,
      current_action, current_action_target, action_start_tick, action_end_tick,
      is_online, is_controlled_by_llm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

	 for (const player of legacyPlayers) {
    insertCharacter.run(
      player.id,
      legacyOwnerId,
      player.name,
      JSON.stringify(player.appearance),
      JSON.stringify(player.inventory),
    );
    insertRuntime.run(
      player.id,
      context.worldId,
      context.timelineId,
      context.mapId,
      player.location,
      player.mainAreaPointId,
      player.x,
      player.y,
      player.currentAction,
      player.currentActionTarget,
      player.actionStartTick,
      player.actionEndTick,
      player.isOnline ? 1 : 0,
      player.isControlledByLLM ? 1 : 0,
    );
	  }

  accountDb
    .prepare(
      `UPDATE account_user_character_presence
       SET world_id = CASE WHEN world_id = '' THEN ? ELSE world_id END,
           timeline_id = CASE WHEN timeline_id = '' THEN ? ELSE timeline_id END,
           current_map_id = CASE WHEN current_map_id = '' THEN ? ELSE current_map_id END,
           updated_at = datetime('now')
       WHERE world_id = '' OR timeline_id = '' OR current_map_id = ''`,
    )
    .run(context.worldId, context.timelineId, context.mapId);
}

function resolveLegacyOwnerUserId(accountDb: ReturnType<typeof getAuthDb>): string | null {
  const defaultUser = accountDb
    .prepare("SELECT id FROM auth_users WHERE id = ?")
    .get(DEFAULT_USER_ID) as { id: string } | undefined;
  if (defaultUser?.id) return defaultUser.id;

  const testUser = accountDb
    .prepare("SELECT id FROM auth_users WHERE username = '123'")
    .get() as { id: string } | undefined;
  if (testUser?.id) return testUser.id;

  const firstUser = accountDb
    .prepare("SELECT id FROM auth_users ORDER BY created_at ASC, id ASC LIMIT 1")
    .get() as { id: string } | undefined;
  return firstUser?.id ?? null;
}

export function resetAllUserCharactersOffline(): void {
  getAuthDb()
    .prepare(
      `UPDATE account_user_character_presence
       SET is_online = 0,
           is_controlled_by_llm = 0,
           updated_at = datetime('now')
       WHERE is_online != 0 OR is_controlled_by_llm != 0`,
    )
    .run();
}

export function getAllUserCharacterStates(userId?: string): PlayerAvatarState[] {
  const sql = `SELECT c.id, c.name, c.appearance, c.inventory,
                      r.location, r.main_area_point_id, r.x, r.y,
                      r.current_action, r.current_action_target,
                      r.action_start_tick, r.action_end_tick,
                      r.is_online, r.is_controlled_by_llm
               FROM account_user_characters c
               JOIN account_user_character_presence r ON r.character_id = c.id
               ${userId ? "WHERE c.user_id = ?" : ""}
               ORDER BY c.created_at ASC`;
  const rows = userId
    ? getAuthDb().prepare(sql).all(userId)
    : getAuthDb().prepare(sql).all();
  return (rows as any[]).map(rowToState);
}

export function getUserCharacterState(id: string, userId?: string): PlayerAvatarState | null {
  const row = getAuthDb()
    .prepare(
      `SELECT c.id, c.name, c.appearance, c.inventory,
              r.location, r.main_area_point_id, r.x, r.y,
              r.current_action, r.current_action_target,
              r.action_start_tick, r.action_end_tick,
              r.is_online, r.is_controlled_by_llm
       FROM account_user_characters c
       JOIN account_user_character_presence r ON r.character_id = c.id
       WHERE c.id = ?
         AND (? IS NULL OR c.user_id = ?)`,
    )
    .get(id, userId ?? null, userId ?? null) as any;
  return row ? rowToState(row) : null;
}

export function getUserCharacterOwnerId(id: string): string | null {
  const row = getAuthDb()
    .prepare("SELECT user_id FROM account_user_characters WHERE id = ?")
    .get(id) as { user_id?: string } | undefined;
  return row?.user_id ?? null;
}

export function userOwnsCharacter(userId: string, characterId: string): boolean {
  return getUserCharacterOwnerId(characterId) === userId;
}

export function getUserCharacterMapId(id: string): string | null {
  const row = getAuthDb()
    .prepare("SELECT current_map_id FROM account_user_character_presence WHERE character_id = ?")
    .get(id) as { current_map_id?: string } | undefined;
  return row?.current_map_id ?? null;
}

export function getUserCharacterPresence(id: string): { worldId: string; timelineId: string; currentMapId: string } | null {
  const row = getAuthDb()
    .prepare(
      `SELECT world_id, timeline_id, current_map_id
       FROM account_user_character_presence
       WHERE character_id = ?`,
    )
    .get(id) as { world_id?: string; timeline_id?: string; current_map_id?: string } | undefined;
  if (!row) return null;
  return {
    worldId: row.world_id ?? "",
    timelineId: row.timeline_id ?? "",
    currentMapId: row.current_map_id ?? "map_origin",
  };
}

export function initUserCharacter(state: PlayerAvatarState, context: PresenceContext, userId: string = DEFAULT_USER_ID): void {
  ensureUser(userId);
  const accountDb = getAuthDb();
  accountDb
    .prepare(
      `INSERT OR IGNORE INTO account_user_characters
       (id, user_id, name, appearance, inventory)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      state.id,
      userId,
      state.name,
      JSON.stringify(state.appearance),
      JSON.stringify(state.inventory),
    );
  accountDb
    .prepare(
      `INSERT INTO account_user_character_presence
       (character_id, world_id, timeline_id, current_map_id, location, main_area_point_id, x, y,
        current_action, current_action_target, action_start_tick, action_end_tick,
        is_online, is_controlled_by_llm)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO UPDATE SET
         world_id = excluded.world_id,
         timeline_id = excluded.timeline_id,
         current_map_id = excluded.current_map_id,
         updated_at = datetime('now')`,
    )
    .run(
      state.id,
      context.worldId,
      context.timelineId,
      context.mapId,
      state.location,
      state.mainAreaPointId,
      state.x,
      state.y,
      state.currentAction,
      state.currentActionTarget,
      state.actionStartTick,
      state.actionEndTick,
      state.isOnline ? 1 : 0,
      state.isControlledByLLM ? 1 : 0,
    );
  playerStore.initPlayerAvatar(state);
}

export function updateUserCharacterState(id: string, patch: Partial<PlayerAvatarState> & { worldId?: string; timelineId?: string; currentMapId?: string }): void {
  const characterSets: string[] = [];
  const characterParams: unknown[] = [];
  const runtimeSets: string[] = [];
  const runtimeParams: unknown[] = [];

  if (patch.name !== undefined) {
    characterSets.push("name = ?");
    characterParams.push(patch.name);
  }
  if (patch.appearance !== undefined) {
    characterSets.push("appearance = ?");
    characterParams.push(JSON.stringify(patch.appearance));
  }
  if (patch.inventory !== undefined) {
    characterSets.push("inventory = ?");
    characterParams.push(JSON.stringify(patch.inventory));
  }
  if (patch.currentMapId !== undefined) {
    runtimeSets.push("current_map_id = ?");
    runtimeParams.push(patch.currentMapId);
  }
  if (patch.worldId !== undefined) {
    runtimeSets.push("world_id = ?");
    runtimeParams.push(patch.worldId);
  }
  if (patch.timelineId !== undefined) {
    runtimeSets.push("timeline_id = ?");
    runtimeParams.push(patch.timelineId);
  }
  if (patch.location !== undefined) {
    runtimeSets.push("location = ?");
    runtimeParams.push(patch.location);
  }
  if (patch.mainAreaPointId !== undefined) {
    runtimeSets.push("main_area_point_id = ?");
    runtimeParams.push(patch.mainAreaPointId);
  }
  if (patch.x !== undefined) {
    runtimeSets.push("x = ?");
    runtimeParams.push(patch.x);
  }
  if (patch.y !== undefined) {
    runtimeSets.push("y = ?");
    runtimeParams.push(patch.y);
  }
  if (patch.currentAction !== undefined) {
    runtimeSets.push("current_action = ?");
    runtimeParams.push(patch.currentAction);
  }
  if (patch.currentActionTarget !== undefined) {
    runtimeSets.push("current_action_target = ?");
    runtimeParams.push(patch.currentActionTarget);
  }
  if (patch.actionStartTick !== undefined) {
    runtimeSets.push("action_start_tick = ?");
    runtimeParams.push(patch.actionStartTick);
  }
  if (patch.actionEndTick !== undefined) {
    runtimeSets.push("action_end_tick = ?");
    runtimeParams.push(patch.actionEndTick);
  }
  if (patch.isOnline !== undefined) {
    runtimeSets.push("is_online = ?");
    runtimeParams.push(patch.isOnline ? 1 : 0);
  }
  if (patch.isControlledByLLM !== undefined) {
    runtimeSets.push("is_controlled_by_llm = ?");
    runtimeParams.push(patch.isControlledByLLM ? 1 : 0);
  }

  if (characterSets.length > 0) {
    characterSets.push("updated_at = datetime('now')");
    characterParams.push(id);
    getAuthDb().prepare(`UPDATE account_user_characters SET ${characterSets.join(", ")} WHERE id = ?`).run(...characterParams);
  }
  if (runtimeSets.length > 0) {
    runtimeSets.push("updated_at = datetime('now')");
    runtimeParams.push(id);
    getAuthDb().prepare(`UPDATE account_user_character_presence SET ${runtimeSets.join(", ")} WHERE character_id = ?`).run(...runtimeParams);
  }

  playerStore.updatePlayerAvatar(id, patch);
}

export function deleteUserCharacter(id: string, userId?: string): boolean {
  const ownerId = getUserCharacterOwnerId(id);
  if (!ownerId || (userId && ownerId !== userId)) return false;
  const accountDb = getAuthDb();
  const tx = accountDb.transaction(() => {
    accountDb.prepare("DELETE FROM account_user_character_presence WHERE character_id = ?").run(id);
    accountDb.prepare("DELETE FROM account_user_characters WHERE id = ?").run(id);
  });
  tx();
  getDb().prepare("DELETE FROM player_avatar WHERE id = ?").run(id);
  return true;
}

export function canDeleteUserCharacter(id: string, userId?: string): { ok: true } | { ok: false; reason: string } {
  const state = getUserCharacterState(id, userId);
  if (!state) return { ok: false, reason: "User character not found" };
  if (state.isOnline) return { ok: false, reason: "Character is currently online" };

  return { ok: true };
}

export function captureSnapshots(context: PresenceContext): UserCharacterSnapshot[] {
  const rows = getAuthDb()
    .prepare(
      `SELECT c.id, c.user_id, c.name, c.appearance, c.inventory,
              r.world_id, r.timeline_id, r.current_map_id,
              r.location, r.main_area_point_id, r.x, r.y,
              r.current_action, r.current_action_target,
              r.action_start_tick, r.action_end_tick,
              r.is_online, r.is_controlled_by_llm
       FROM account_user_characters c
       JOIN account_user_character_presence r ON r.character_id = c.id
       ORDER BY c.created_at ASC`,
    )
    .all() as any[];

  return rows.map((row) => {
    const state = rowToState(row);
    return stateToSnapshot(state, {
        worldId: row.world_id || context.worldId,
        timelineId: row.timeline_id || context.timelineId,
        mapId: row.current_map_id || context.mapId,
      },
      row.user_id || DEFAULT_USER_ID,
    );
  });
}

export function seedSnapshots(snapshots: UserCharacterSnapshot[], context: PresenceContext): void {
  for (const snapshot of snapshots) {
    initUserCharacter(
      { ...snapshot.runtime, mode: "avatar", isOnline: false, isControlledByLLM: false },
      {
        worldId: snapshot.runtime.worldId ?? context.worldId,
        timelineId: context.timelineId,
        mapId: snapshot.runtime.currentMapId ?? context.mapId,
      },
      snapshot.character.userId || DEFAULT_USER_ID,
    );
    updateUserCharacterState(snapshot.character.id, {
      worldId: snapshot.runtime.worldId ?? context.worldId,
      timelineId: context.timelineId,
      currentMapId: snapshot.runtime.currentMapId ?? context.mapId,
      name: snapshot.character.name,
      appearance: snapshot.character.appearance,
      inventory: snapshot.character.inventory,
      isOnline: false,
      isControlledByLLM: false,
    });
  }
}
