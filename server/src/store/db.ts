import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

let db: Database.Database | null = null;
let currentDbPath: string | null = null;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  game_day INTEGER NOT NULL,
  game_tick INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  location TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  inner_monologue TEXT,
  dram_score REAL,
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(game_day, game_tick);
CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  game_day INTEGER NOT NULL,
  game_tick INTEGER NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  emotional_valence REAL DEFAULT 0,
  emotional_intensity REAL DEFAULT 0,
  related_characters TEXT DEFAULT '[]',
  related_location TEXT DEFAULT '',
  related_objects TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  decay_factor REAL DEFAULT 1.0,
  access_count INTEGER DEFAULT 0,
  is_long_term INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mem_char ON memories(character_id);
CREATE INDEX IF NOT EXISTS idx_mem_importance ON memories(character_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_mem_time ON memories(character_id, game_day DESC, game_tick DESC);

CREATE TABLE IF NOT EXISTS character_states (
  character_id TEXT PRIMARY KEY,
  location TEXT NOT NULL,
  main_area_point_id TEXT,
  current_action TEXT,
  current_action_target TEXT,
  action_start_tick INTEGER DEFAULT 0,
  action_end_tick INTEGER DEFAULT 0,
  emotion_valence REAL DEFAULT 0,
  emotion_arousal REAL DEFAULT 3,
  curiosity REAL DEFAULT 100,
  daily_plan TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS world_object_states (
  object_id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL,
  state TEXT DEFAULT 'normal',
  state_description TEXT DEFAULT '',
  current_users TEXT DEFAULT '[]',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS world_global_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS diary_entries (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  game_day INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  game_day INTEGER NOT NULL,
  game_tick INTEGER NOT NULL,
  description TEXT,
  file_path TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS llm_call_logs (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  character_id TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  success INTEGER DEFAULT 1,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS content_candidates (
  id TEXT PRIMARY KEY,
  event_id TEXT,
  type TEXT NOT NULL,
  dram_score REAL DEFAULT 0,
  content TEXT NOT NULL,
  character_id TEXT,
  context TEXT,
  tags TEXT DEFAULT '[]',
  reviewed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '本地用户',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_characters (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  appearance TEXT DEFAULT '{}',
  inventory TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_user_characters_user ON user_characters(user_id);

CREATE TABLE IF NOT EXISTS user_character_runtime (
  character_id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL DEFAULT '',
  timeline_id TEXT NOT NULL DEFAULT '',
  current_map_id TEXT NOT NULL DEFAULT 'map_origin',
  location TEXT NOT NULL DEFAULT 'main_area',
  main_area_point_id TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  current_action TEXT,
  current_action_target TEXT,
  action_start_tick INTEGER DEFAULT 0,
  action_end_tick INTEGER DEFAULT 0,
  is_online INTEGER NOT NULL DEFAULT 0,
  is_controlled_by_llm INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (character_id) REFERENCES user_characters(id)
);
CREATE INDEX IF NOT EXISTS idx_user_character_runtime_map ON user_character_runtime(current_map_id);

CREATE TABLE IF NOT EXISTS item_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT NOT NULL DEFAULT 'misc',
  icon_key TEXT,
  stackable INTEGER NOT NULL DEFAULT 1,
  max_stack INTEGER NOT NULL DEFAULT 99,
  placeable INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_item_definitions_category ON item_definitions(category);

CREATE TABLE IF NOT EXISTS item_instances (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (definition_id) REFERENCES item_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_item_instances_definition ON item_instances(definition_id);
CREATE INDEX IF NOT EXISTS idx_item_instances_scope ON item_instances(world_id, timeline_id);

CREATE TABLE IF NOT EXISTS inventory_entries (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  item_instance_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  slot TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (item_instance_id) REFERENCES item_instances(id)
);
CREATE INDEX IF NOT EXISTS idx_inventory_owner ON inventory_entries(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_inventory_item ON inventory_entries(item_instance_id);

CREATE TABLE IF NOT EXISTS map_item_placements (
  id TEXT PRIMARY KEY,
  item_instance_id TEXT NOT NULL,
  world_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  map_id TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  rotation REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'placed',
  placed_by_owner_type TEXT,
  placed_by_owner_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_map_item_placements_scope ON map_item_placements(world_id, timeline_id, map_id, state);
CREATE INDEX IF NOT EXISTS idx_map_item_placements_item ON map_item_placements(item_instance_id);

CREATE TABLE IF NOT EXISTS item_transfers (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  map_id TEXT NOT NULL,
  item_instance_id TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  from_owner_type TEXT,
  from_owner_id TEXT,
  to_owner_type TEXT,
  to_owner_id TEXT,
  kind TEXT NOT NULL DEFAULT 'system',
  status TEXT NOT NULL DEFAULT 'completed',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (item_instance_id) REFERENCES item_instances(id)
);
CREATE INDEX IF NOT EXISTS idx_item_transfers_scope ON item_transfers(world_id, timeline_id, map_id);
CREATE INDEX IF NOT EXISTS idx_item_transfers_owners ON item_transfers(from_owner_type, from_owner_id, to_owner_type, to_owner_id);

CREATE TABLE IF NOT EXISTS actor_relationships (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  source_actor_type TEXT NOT NULL,
  source_actor_id TEXT NOT NULL,
  target_actor_type TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  affinity REAL NOT NULL DEFAULT 0,
  trust REAL NOT NULL DEFAULT 0,
  tension REAL NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_actor_relationship_pair
  ON actor_relationships(world_id, timeline_id, source_actor_type, source_actor_id, target_actor_type, target_actor_id);

CREATE TABLE IF NOT EXISTS actor_interactions (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  map_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  initiator_actor_type TEXT NOT NULL,
  initiator_actor_id TEXT NOT NULL,
  target_actor_type TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested',
  payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_actor_interactions_scope ON actor_interactions(world_id, timeline_id, map_id, status);
CREATE INDEX IF NOT EXISTS idx_actor_interactions_actors ON actor_interactions(initiator_actor_type, initiator_actor_id, target_actor_type, target_actor_id);

CREATE TABLE IF NOT EXISTS player_avatar (
  id TEXT PRIMARY KEY DEFAULT 'player_1',
  name TEXT NOT NULL DEFAULT '旅行者',
  mode TEXT NOT NULL DEFAULT 'avatar',
  location TEXT NOT NULL DEFAULT 'main_area',
  main_area_point_id TEXT,
  x REAL NOT NULL DEFAULT 0,
  y REAL NOT NULL DEFAULT 0,
  current_action TEXT,
  current_action_target TEXT,
  action_start_tick INTEGER DEFAULT 0,
  action_end_tick INTEGER DEFAULT 0,
  is_online INTEGER NOT NULL DEFAULT 1,
  is_controlled_by_llm INTEGER NOT NULL DEFAULT 0,
  appearance TEXT DEFAULT '{}',
  inventory TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS player_memories (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL DEFAULT 'player_1',
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  game_day INTEGER NOT NULL,
  game_tick INTEGER NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5,
  emotional_valence REAL DEFAULT 0,
  emotional_intensity REAL DEFAULT 0,
  related_characters TEXT DEFAULT '[]',
  related_location TEXT DEFAULT '',
  tags TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pm_player ON player_memories(player_id);
CREATE INDEX IF NOT EXISTS idx_pm_time ON player_memories(player_id, game_day DESC, game_tick DESC);
`;

export function initDatabase(dbPath?: string): Database.Database {
  const resolvedPath =
    dbPath ?? process.env.DB_PATH ?? path.resolve("data/mist-town.db");

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  currentDbPath = resolvedPath;
  db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA_SQL);

  runMigrations(db);

  return db;
}

function runMigrations(database: Database.Database): void {
  const hasColumn = database
    .prepare(`PRAGMA table_info(memories)`)
    .all()
    .some((col: any) => col.name === "embedding");
  if (!hasColumn) {
    database.exec(`ALTER TABLE memories ADD COLUMN embedding TEXT DEFAULT NULL`);
  }

  const hasMainAreaPointId = database
    .prepare(`PRAGMA table_info(character_states)`)
    .all()
    .some((col: any) => col.name === "main_area_point_id");
  if (!hasMainAreaPointId) {
    database.exec(`ALTER TABLE character_states ADD COLUMN main_area_point_id TEXT DEFAULT NULL`);
  }

  const runtimeColumns = database
    .prepare(`PRAGMA table_info(user_character_runtime)`)
    .all() as Array<{ name: string }>;
  const runtimeColumnNames = new Set(runtimeColumns.map((col) => col.name));
  if (!runtimeColumnNames.has("world_id")) {
    safeAddColumn(database, `ALTER TABLE user_character_runtime ADD COLUMN world_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!runtimeColumnNames.has("timeline_id")) {
    safeAddColumn(database, `ALTER TABLE user_character_runtime ADD COLUMN timeline_id TEXT NOT NULL DEFAULT ''`);
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_user_character_runtime_presence
     ON user_character_runtime(world_id, timeline_id, current_map_id)`,
  );

  migrateMapItemPlacementsToAccountItemRefs(database);
}

function migrateMapItemPlacementsToAccountItemRefs(database: Database.Database): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'map_item_placements'")
    .get();
  if (!table) return;

  const foreignKeys = database.prepare("PRAGMA foreign_key_list(map_item_placements)").all() as Array<{ table: string }>;
  const hasLocalItemInstanceFk = foreignKeys.some((fk) => fk.table === "item_instances");
  if (!hasLocalItemInstanceFk) return;

  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE IF NOT EXISTS map_item_placements_next (
      id TEXT PRIMARY KEY,
      item_instance_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL,
      map_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      rotation REAL NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'placed',
      placed_by_owner_type TEXT,
      placed_by_owner_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    INSERT OR REPLACE INTO map_item_placements_next
      (id, item_instance_id, world_id, timeline_id, map_id, x, y, rotation, state,
       placed_by_owner_type, placed_by_owner_id, metadata, created_at, updated_at)
    SELECT id, item_instance_id, world_id, timeline_id, map_id, x, y, rotation, state,
           placed_by_owner_type, placed_by_owner_id, metadata, created_at, updated_at
    FROM map_item_placements;
    DROP TABLE map_item_placements;
    ALTER TABLE map_item_placements_next RENAME TO map_item_placements;
    CREATE INDEX IF NOT EXISTS idx_map_item_placements_scope ON map_item_placements(world_id, timeline_id, map_id, state);
    CREATE INDEX IF NOT EXISTS idx_map_item_placements_item ON map_item_placements(item_instance_id);
    PRAGMA foreign_keys = ON;
  `);
}

function safeAddColumn(database: Database.Database, sql: string): void {
  try {
    database.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/duplicate column name/i.test(message)) return;
    throw error;
  }
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function getDbPath(): string {
  if (!currentDbPath) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return currentDbPath;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
