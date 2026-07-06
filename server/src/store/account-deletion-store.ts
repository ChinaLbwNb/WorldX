import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { getAuthDb } from "./auth-store.js";
import { GENERATED_WORLDS_DIR, findWorldById } from "../utils/world-directories.js";
import { getAccountAssetsRoot } from "../utils/account-assets.js";

export type AccountDeletionResult = {
  deletedUserId: string;
  deletedCharacters: number;
  deletedItemInstances: number;
  deletedWorldAssets: number;
  deletedWorldDirectories: string[];
  preservedActiveWorlds: string[];
  deletedTimelineAssets: number;
  removedAssetDirs: string[];
  cleanedTimelineDbs: number;
};

export function deleteAccountCascade(input: {
  userId: string;
  activeWorldDir?: string;
}): AccountDeletionResult {
  const db = getAuthDb();
  const user = db.prepare("SELECT id FROM auth_users WHERE id = ?").get(input.userId);
  if (!user) throw new Error("User not found");

  const characterIds = (db.prepare("SELECT id FROM account_user_characters WHERE user_id = ?").all(input.userId) as Array<{ id: string }>).map((row) => row.id);
  const itemInstanceIds = (db.prepare("SELECT id FROM account_item_instances WHERE user_id = ?").all(input.userId) as Array<{ id: string }>).map((row) => row.id);
  const worldIds = (db.prepare("SELECT world_id FROM account_world_assets WHERE user_id = ? AND source = 'user'").all(input.userId) as Array<{ world_id: string }>).map((row) => row.world_id);
  const deletedTimelineAssets = Number((db.prepare("SELECT COUNT(*) AS count FROM account_timeline_assets WHERE user_id = ?").get(input.userId) as any)?.count ?? 0);
  const activeWorldDir = input.activeWorldDir ? path.resolve(input.activeWorldDir) : "";

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_tutorial_task_reward_claims WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_tutorial_task_progress WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_resources WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_timeline_assets WHERE user_id = ?").run(input.userId);
    db.prepare(
      `DELETE FROM account_item_transfers
       WHERE user_id = ?
          OR from_owner_id = ?
          OR to_owner_id = ?
          OR (${itemInstanceIds.length > 0 ? `item_instance_id IN (${placeholders(itemInstanceIds.length)})` : "0"})`,
    ).run(input.userId, input.userId, input.userId, ...itemInstanceIds);
    db.prepare("DELETE FROM account_inventory_entries WHERE user_id = ? OR owner_id = ?").run(input.userId, input.userId);
    db.prepare("DELETE FROM account_item_instances WHERE user_id = ?").run(input.userId);
    db.prepare(
      `DELETE FROM account_item_definitions
       WHERE user_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM account_item_instances i
           WHERE i.definition_id = account_item_definitions.id
         )`,
    ).run(input.userId);
    if (characterIds.length > 0) {
      db.prepare(`DELETE FROM account_user_character_presence WHERE character_id IN (${placeholders(characterIds.length)})`).run(...characterIds);
    }
    db.prepare("DELETE FROM account_user_characters WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_world_assets WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM account_world_members WHERE user_id = ? OR invited_by_user_id = ?").run(input.userId, input.userId);
    db.prepare("DELETE FROM auth_users WHERE id = ?").run(input.userId);
  });
  tx();

  const removedAssetDirs = removeAccountAssetDirs(input.userId, characterIds, itemInstanceIds);
  const cleanedTimelineDbs = cleanTimelineRuntimeReferences(input.userId, characterIds, itemInstanceIds);
  const { deletedWorldDirectories, preservedActiveWorlds } = removeOwnedWorldDirectories(worldIds, activeWorldDir);

  return {
    deletedUserId: input.userId,
    deletedCharacters: characterIds.length,
    deletedItemInstances: itemInstanceIds.length,
    deletedWorldAssets: worldIds.length,
    deletedWorldDirectories,
    preservedActiveWorlds,
    deletedTimelineAssets,
    removedAssetDirs,
    cleanedTimelineDbs,
  };
}

function cleanTimelineRuntimeReferences(userId: string, characterIds: string[], itemInstanceIds: string[]): number {
  let cleaned = 0;
  if (!fs.existsSync(GENERATED_WORLDS_DIR)) return cleaned;
  for (const worldEntry of fs.readdirSync(GENERATED_WORLDS_DIR, { withFileTypes: true })) {
    if (!worldEntry.isDirectory()) continue;
    const timelinesDir = path.join(GENERATED_WORLDS_DIR, worldEntry.name, "timelines");
    if (!fs.existsSync(timelinesDir)) continue;
    for (const timelineEntry of fs.readdirSync(timelinesDir, { withFileTypes: true })) {
      if (!timelineEntry.isDirectory()) continue;
      const dbPath = path.join(timelinesDir, timelineEntry.name, "state.db");
      if (!fs.existsSync(dbPath)) continue;
      const db = new Database(dbPath);
      try {
        const hasMapItemPlacements = tableExists(db, "map_item_placements");
        const hasPlayerAvatar = tableExists(db, "player_avatar");
        const tx = db.transaction(() => {
          if (hasMapItemPlacements) {
            db.prepare(
              `UPDATE map_item_placements
               SET state = 'removed', updated_at = datetime('now')
               WHERE placed_by_owner_type = 'account' AND placed_by_owner_id = ?`,
            ).run(userId);
            if (itemInstanceIds.length > 0) {
              db.prepare(`UPDATE map_item_placements SET state = 'removed', updated_at = datetime('now') WHERE item_instance_id IN (${placeholders(itemInstanceIds.length)})`).run(...itemInstanceIds);
            }
          }
          if (hasPlayerAvatar && characterIds.length > 0) {
            db.prepare(`DELETE FROM player_avatar WHERE id IN (${placeholders(characterIds.length)})`).run(...characterIds);
          }
        });
        tx();
        cleaned += 1;
      } finally {
        db.close();
      }
    }
  }
  return cleaned;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row);
}

function removeAccountAssetDirs(userId: string, characterIds: string[], itemInstanceIds: string[]): string[] {
  const removed: string[] = [];
  const root = getAccountAssetsRoot();
  for (const characterId of characterIds) {
    const rel = `user-characters/${characterId}`;
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      removed.push(rel);
    }
  }
  const itemRoot = path.join(root, "items");
  if (fs.existsSync(itemRoot)) {
    for (const entry of fs.readdirSync(itemRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = path.join(itemRoot, entry.name);
      const rel = `items/${entry.name}`;
      if (entry.name.includes(userId) || itemInstanceIds.some((id) => entry.name.includes(id))) {
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(rel);
      }
    }
  }
  return removed;
}

function removeOwnedWorldDirectories(worldIds: string[], activeWorldDir: string): {
  deletedWorldDirectories: string[];
  preservedActiveWorlds: string[];
} {
  const deletedWorldDirectories: string[] = [];
  const preservedActiveWorlds: string[] = [];
  const root = path.resolve(GENERATED_WORLDS_DIR);
  for (const worldId of worldIds) {
    const world = findWorldById(worldId);
    if (!world || world.source !== "user") continue;
    const resolved = path.resolve(world.dir);
    if (!resolved.startsWith(`${root}${path.sep}`)) continue;
    if (activeWorldDir && resolved === activeWorldDir) {
      preservedActiveWorlds.push(worldId);
      continue;
    }
    fs.rmSync(resolved, { recursive: true, force: true });
    deletedWorldDirectories.push(worldId);
  }
  return { deletedWorldDirectories, preservedActiveWorlds };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}
