import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("../server/node_modules/better-sqlite3");

const root = path.resolve(process.cwd());
const keepUser = {
  id: "user_xKx7wtpcYXLd",
  username: "123",
  displayName: "小杨12138",
};
const keepWorlds = [
  { id: "world_2026-04-19T08-31-24", dir: path.join(root, "library/worlds/world_2026-04-19T08-31-24") },
  { id: "world_2026-04-19T17-12-41", dir: path.join(root, "library/worlds/world_2026-04-19T17-12-41") },
];

function assertInsideWorkspace(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(root + path.sep)) {
    throw new Error(`Refusing to touch outside workspace: ${resolved}`);
  }
  return resolved;
}

function rmSafe(target) {
  fs.rmSync(assertInsideWorkspace(target), { recursive: true, force: true });
}

function tableExists(db, name) {
  return db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?").get(name).c > 0;
}

function deleteAllIfExists(db, table) {
  if (tableExists(db, table)) db.prepare(`DELETE FROM ${table}`).run();
}

function deletePlayerEvents(db) {
  if (!tableExists(db, "events")) return;
  const columns = db.prepare("PRAGMA table_info(events)").all().map((column) => column.name);
  const clauses = [];
  if (columns.includes("actor_id")) clauses.push("actor_id LIKE 'player_%'");
  if (columns.includes("target_id")) clauses.push("target_id LIKE 'player_%'");
  if (clauses.length > 0) db.prepare(`DELETE FROM events WHERE ${clauses.join(" OR ")}`).run();
}

function checkpoint(db) {
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // Some DBs may not be in WAL mode.
  }
}

function resetAuth(summary) {
  const authPath = path.join(root, "output/auth.db");
  if (!fs.existsSync(authPath)) return;
  const db = new Database(authPath);
  const users = db.prepare("SELECT id, username FROM auth_users").all();
  const tx = db.transaction(() => {
    if (tableExists(db, "auth_sessions")) db.prepare("DELETE FROM auth_sessions").run();
    for (const user of users) {
      if (user.username !== keepUser.username) {
        summary.authDeletedUsers.push(user.username);
        db.prepare("DELETE FROM auth_users WHERE id = ?").run(user.id);
      } else {
        db.prepare("UPDATE auth_users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
          .run(keepUser.displayName, keepUser.id);
      }
    }
  });
  tx();
  checkpoint(db);
  db.close();
}

function resetWorldConfig(world, summary) {
  const configPath = path.join(world.dir, "config/world.json");
  if (!fs.existsSync(configPath)) return null;
  const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const originMap = (data.worldMaps || []).find((map) => map.id === "map_origin") || {
    id: "map_origin",
    name: data.worldName || world.id,
    gridX: 0,
    gridY: 0,
    status: "available",
    mapDir: "map_origin",
    previewImage: "background-preview.png",
    defaultSpawnPointId: "map_origin_spawn",
    createdAt: new Date().toISOString(),
  };

  data.activeMapId = "map_origin";
  data.worldMaps = [{
    ...originMap,
    id: "map_origin",
    gridX: 0,
    gridY: 0,
    status: "available",
    mapDir: "map_origin",
  }];
  data.mapLinks = [];
  data.mapSpawnPoints = [];

  fs.writeFileSync(configPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  summary.resetWorldConfigs.push(world.id);
  return data;
}

function defaultRoleState(kind, world, timelineId, point, offsetX) {
  const male = kind === "male";
  return {
    id: male ? "player_default_male" : "player_default_female",
    name: male ? "默认男角色" : "默认女角色",
    appearance: {
      color: male ? 0x5aa8ff : 0xff8fc7,
      sizeScale: 1,
      assetStatus: "ready",
      prompt: male ? "默认男性用户角色" : "默认女性用户角色",
    },
    worldId: world.id,
    timelineId,
    mapId: "map_origin",
    location: "main_area",
    mainAreaPointId: point?.id ?? null,
    x: Number(point?.x ?? 0) + offsetX,
    y: Number(point?.y ?? 0),
  };
}

function insertDefaultRole(db, role) {
  db.prepare(`
    INSERT INTO users (id, display_name)
    VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, updated_at=datetime('now')
  `).run(keepUser.id, keepUser.displayName);

  db.prepare(`
    INSERT INTO user_characters (id, user_id, name, appearance, inventory)
    VALUES (?, ?, ?, ?, ?)
  `).run(role.id, keepUser.id, role.name, JSON.stringify(role.appearance), "[]");

  db.prepare(`
    INSERT INTO user_character_runtime
      (character_id, world_id, timeline_id, current_map_id, location, main_area_point_id, x, y,
       current_action, current_action_target, action_start_tick, action_end_tick, is_online, is_controlled_by_llm)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0)
  `).run(role.id, role.worldId, role.timelineId, role.mapId, role.location, role.mainAreaPointId, role.x, role.y);

  db.prepare(`
    INSERT INTO player_avatar
      (id, name, mode, location, main_area_point_id, x, y, current_action, current_action_target,
       action_start_tick, action_end_tick, is_online, is_controlled_by_llm, appearance, inventory)
    VALUES (?, ?, 'avatar', ?, ?, ?, ?, NULL, NULL, 0, 0, 0, 0, ?, ?)
  `).run(role.id, role.name, role.location, role.mainAreaPointId, role.x, role.y, JSON.stringify(role.appearance), "[]");
}

function cleanTimelineDb(world, timelineDir, worldConfig, summary) {
  const timelineId = path.basename(timelineDir);
  const dbPath = path.join(timelineDir, "state.db");
  if (!fs.existsSync(dbPath)) return;

  const points = Array.isArray(worldConfig.mainAreaPoints) ? worldConfig.mainAreaPoints : [];
  const db = new Database(dbPath);
  const tx = db.transaction(() => {
    for (const table of [
      "item_transfers",
      "map_item_placements",
      "inventory_entries",
      "item_definitions",
      "user_character_runtime",
      "user_characters",
      "player_avatar",
      "users",
    ]) {
      deleteAllIfExists(db, table);
    }
    deletePlayerEvents(db);
    insertDefaultRole(db, defaultRoleState("male", world, timelineId, points[0], 0));
    insertDefaultRole(db, defaultRoleState("female", world, timelineId, points[1] || points[0], 24));
  });
  tx();
  checkpoint(db);
  db.close();

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${dbPath}${suffix}`;
    if (fs.existsSync(sidecar)) rmSafe(sidecar);
  }
  summary.cleanedWorldDbs.push(path.relative(root, dbPath));
}

function cleanWorld(world, summary) {
  const worldConfig = resetWorldConfig(world, summary);
  if (!worldConfig) return;

  const mapsDir = path.join(world.dir, "maps");
  if (fs.existsSync(mapsDir)) {
    for (const entry of fs.readdirSync(mapsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "map_origin") {
        rmSafe(path.join(mapsDir, entry.name));
        summary.removedMapDirs.push(`${world.id}/maps/${entry.name}`);
      }
    }
  }

  for (const assetDirName of ["user-characters", "items"]) {
    const assetDir = path.join(world.dir, assetDirName);
    if (!fs.existsSync(assetDir)) continue;
    for (const entry of fs.readdirSync(assetDir, { withFileTypes: true })) {
      rmSafe(path.join(assetDir, entry.name));
      summary.removedAssetDirs.push(`${world.id}/${assetDirName}/${entry.name}`);
    }
  }

  const timelinesDir = path.join(world.dir, "timelines");
  const timelineDirs = fs.existsSync(timelinesDir)
    ? fs.readdirSync(timelinesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(timelinesDir, entry.name))
      .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
    : [];

  for (const timelineDir of timelineDirs) {
    const snapshotsDir = path.join(timelineDir, "snapshots");
    if (fs.existsSync(snapshotsDir)) rmSafe(snapshotsDir);
  }

  const keepTimelineDir = timelineDirs[0];
  for (const timelineDir of timelineDirs) {
    if (timelineDir !== keepTimelineDir) {
      rmSafe(timelineDir);
      summary.removedTimelineDirs.push(`${world.id}/timelines/${path.basename(timelineDir)}`);
    }
  }

  if (keepTimelineDir) cleanTimelineDb(world, keepTimelineDir, worldConfig, summary);
}

function removeGeneratedWorlds(summary) {
  const outputWorlds = path.join(root, "output/worlds");
  if (!fs.existsSync(outputWorlds)) return;
  for (const entry of fs.readdirSync(outputWorlds, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    rmSafe(path.join(outputWorlds, entry.name));
    summary.removedGeneratedWorlds.push(entry.name);
  }
}

function clearOutputCharacterArtifacts(summary) {
  const outputCharacters = path.join(root, "output/characters");
  if (!fs.existsSync(outputCharacters)) return;
  for (const entry of fs.readdirSync(outputCharacters, { withFileTypes: true })) {
    rmSafe(path.join(outputCharacters, entry.name));
    summary.removedAssetDirs.push(`output/characters/${entry.name}`);
  }
}

const summary = {
  authDeletedUsers: [],
  removedGeneratedWorlds: [],
  removedMapDirs: [],
  removedTimelineDirs: [],
  cleanedWorldDbs: [],
  removedAssetDirs: [],
  resetWorldConfigs: [],
};

resetAuth(summary);
for (const world of keepWorlds) cleanWorld(world, summary);
removeGeneratedWorlds(summary);
clearOutputCharacterArtifacts(summary);

console.log(JSON.stringify(summary, null, 2));
