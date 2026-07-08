import { getDb } from "./db.js";
import type { PlayerAvatarState, AvatarMode } from "../types/index.js";

function rowToState(row: any): PlayerAvatarState {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode as AvatarMode,
    location: row.location,
    mainAreaPointId: row.main_area_point_id ?? null,
    x: row.x,
    y: row.y,
    currentAction: row.current_action ?? null,
    currentActionTarget: row.current_action_target ?? null,
    actionStartTick: row.action_start_tick,
    actionEndTick: row.action_end_tick,
    isOnline: row.is_online === 1,
    isControlledByLLM: row.is_controlled_by_llm === 1,
    appearance: JSON.parse(row.appearance || "{}"),
    inventory: JSON.parse(row.inventory || "[]"),
  };
}

export function initPlayerAvatar(state: PlayerAvatarState): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO player_avatar
       (id, name, mode, location, main_area_point_id, x, y,
        current_action, current_action_target, action_start_tick, action_end_tick,
        is_online, is_controlled_by_llm, appearance, inventory)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      state.id,
      state.name,
      state.mode,
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
      JSON.stringify(state.appearance),
      JSON.stringify(state.inventory),
    );
}

export function getPlayerAvatar(id: string = "player_1"): PlayerAvatarState {
  const row = getDb()
    .prepare("SELECT * FROM player_avatar WHERE id = ?")
    .get(id) as any;
  if (!row) throw new Error(`Player avatar not found: ${id}`);
  return rowToState(row);
}

export function getPlayerAvatarOrNull(id: string = "player_1"): PlayerAvatarState | null {
  const row = getDb()
    .prepare("SELECT * FROM player_avatar WHERE id = ?")
    .get(id) as any;
  return row ? rowToState(row) : null;
}

export function updatePlayerAvatar(
  id: string,
  patch: Partial<PlayerAvatarState>,
): void {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push("name = ?");
    params.push(patch.name);
  }
  if (patch.mode !== undefined) {
    sets.push("mode = ?");
    params.push(patch.mode);
  }
  if (patch.location !== undefined) {
    sets.push("location = ?");
    params.push(patch.location);
  }
  if (patch.mainAreaPointId !== undefined) {
    sets.push("main_area_point_id = ?");
    params.push(patch.mainAreaPointId);
  }
  if (patch.x !== undefined) {
    sets.push("x = ?");
    params.push(patch.x);
  }
  if (patch.y !== undefined) {
    sets.push("y = ?");
    params.push(patch.y);
  }
  if (patch.currentAction !== undefined) {
    sets.push("current_action = ?");
    params.push(patch.currentAction);
  }
  if (patch.currentActionTarget !== undefined) {
    sets.push("current_action_target = ?");
    params.push(patch.currentActionTarget);
  }
  if (patch.actionStartTick !== undefined) {
    sets.push("action_start_tick = ?");
    params.push(patch.actionStartTick);
  }
  if (patch.actionEndTick !== undefined) {
    sets.push("action_end_tick = ?");
    params.push(patch.actionEndTick);
  }
  if (patch.isOnline !== undefined) {
    sets.push("is_online = ?");
    params.push(patch.isOnline ? 1 : 0);
  }
  if (patch.isControlledByLLM !== undefined) {
    sets.push("is_controlled_by_llm = ?");
    params.push(patch.isControlledByLLM ? 1 : 0);
  }
  if (patch.appearance !== undefined) {
    sets.push("appearance = ?");
    params.push(JSON.stringify(patch.appearance));
  }
  if (patch.inventory !== undefined) {
    sets.push("inventory = ?");
    params.push(JSON.stringify(patch.inventory));
  }

  if (sets.length === 0) return;

  sets.push("updated_at = datetime('now')");
  params.push(id);

  getDb()
    .prepare(`UPDATE player_avatar SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
}

export function setPlayerMode(id: string, mode: AvatarMode): void {
  getDb()
    .prepare("UPDATE player_avatar SET mode = ?, updated_at = datetime('now') WHERE id = ?")
    .run(mode, id);
}

export function setPlayerOnline(id: string, online: boolean): void {
  getDb()
    .prepare("UPDATE player_avatar SET is_online = ?, updated_at = datetime('now') WHERE id = ?")
    .run(online ? 1 : 0, id);
}

export function setPlayerLLMControlled(id: string, controlled: boolean): void {
  getDb()
    .prepare("UPDATE player_avatar SET is_controlled_by_llm = ?, updated_at = datetime('now') WHERE id = ?")
    .run(controlled ? 1 : 0, id);
}

export function resetAllPlayersOffline(): void {
  getDb()
    .prepare(
      `UPDATE player_avatar
       SET is_online = 0,
           is_controlled_by_llm = 0,
           updated_at = datetime('now')
       WHERE is_online != 0 OR is_controlled_by_llm != 0`,
    )
    .run();
}

export function getAllPlayers(): PlayerAvatarState[] {
  return (getDb().prepare("SELECT * FROM player_avatar").all() as any[]).map(rowToState);
}
