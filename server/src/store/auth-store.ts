import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DB_PATH = path.resolve(__dirname, "../../../output/auth.db");
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

let authDb: Database.Database | null = null;

export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
};

export function getAuthDb(): Database.Database {
  if (authDb) return authDb;
  fs.mkdirSync(path.dirname(AUTH_DB_PATH), { recursive: true });
  authDb = new Database(AUTH_DB_PATH);
  authDb.pragma("journal_mode = WAL");
  authDb.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

    CREATE TABLE IF NOT EXISTS account_user_characters (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      appearance TEXT DEFAULT '{}',
      inventory TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_user_characters_user ON account_user_characters(user_id);

    CREATE TABLE IF NOT EXISTS account_user_character_presence (
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
      FOREIGN KEY (character_id) REFERENCES account_user_characters(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_character_presence_scope
      ON account_user_character_presence(world_id, timeline_id, current_map_id);

    CREATE TABLE IF NOT EXISTS account_item_definitions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
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

    CREATE TABLE IF NOT EXISTS account_item_instances (
      id TEXT PRIMARY KEY,
      definition_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (definition_id) REFERENCES account_item_definitions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_item_instances_user ON account_item_instances(user_id);

    CREATE TABLE IF NOT EXISTS account_inventory_entries (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_instance_id TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      slot TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (item_instance_id) REFERENCES account_item_instances(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_inventory_owner ON account_inventory_entries(owner_type, owner_id);

    CREATE TABLE IF NOT EXISTS account_item_transfers (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      world_id TEXT,
      timeline_id TEXT,
      map_id TEXT,
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
      FOREIGN KEY (item_instance_id) REFERENCES account_item_instances(id)
    );

    CREATE TABLE IF NOT EXISTS account_resources (
      user_id TEXT PRIMARY KEY,
      amount INTEGER NOT NULL DEFAULT 10,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );

    CREATE TABLE IF NOT EXISTS account_world_assets (
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'user',
      visibility TEXT NOT NULL DEFAULT 'private',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, world_id),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_world_assets_user
      ON account_world_assets(user_id, created_at);

    CREATE TABLE IF NOT EXISTS account_timeline_assets (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      world_id TEXT NOT NULL,
      timeline_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, world_id, timeline_id),
      UNIQUE (id),
      FOREIGN KEY (user_id) REFERENCES auth_users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_account_timeline_assets_user
      ON account_timeline_assets(user_id, world_id, created_at);
  `);
  return authDb;
}

function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 40).replace(/[^\w.@-]/g, "_");
}

function toUser(row: any): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    createdAt: row.created_at ?? "",
    updatedAt: row.updated_at ?? "",
  };
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(userId: string): { token: string; expiresAt: number } {
  const token = `wx_${crypto.randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + SESSION_TTL_MS;
  getAuthDb()
    .prepare(
      `INSERT INTO auth_sessions (token_hash, user_id, expires_at)
       VALUES (?, ?, ?)`,
    )
    .run(hashToken(token), userId, expiresAt);
  return { token, expiresAt };
}

export function registerUser(input: {
  username: string;
  password: string;
  displayName?: string;
}): { user: AuthUser; token: string; expiresAt: number } {
  const username = normalizeUsername(input.username);
  const password = input.password;
  if (username.length < 3) throw new Error("用户名至少需要 3 个字符");
  if (password.length < 6) throw new Error("密码至少需要 6 个字符");

  const exists = getAuthDb()
    .prepare("SELECT id FROM auth_users WHERE username = ?")
    .get(username);
  if (exists) throw new Error("用户名已存在");

  const id = `user_${crypto.randomBytes(9).toString("base64url")}`;
  const salt = crypto.randomBytes(16).toString("hex");
  const displayName = (input.displayName?.trim() || username).slice(0, 32);
  getAuthDb()
    .prepare(
      `INSERT INTO auth_users (id, username, display_name, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, username, displayName, hashPassword(password, salt), salt);
  const user = getUserById(id);
  if (!user) throw new Error("账号创建失败");
  return { user, ...createSession(user.id) };
}

export function loginUser(input: {
  username: string;
  password: string;
}): { user: AuthUser; token: string; expiresAt: number } {
  const username = normalizeUsername(input.username);
  const row = getAuthDb()
    .prepare("SELECT * FROM auth_users WHERE username = ?")
    .get(username) as any;
  if (!row) throw new Error("用户名或密码错误");
  const actualHash = hashPassword(input.password, row.password_salt);
  const ok = crypto.timingSafeEqual(
    Buffer.from(actualHash, "hex"),
    Buffer.from(row.password_hash, "hex"),
  );
  if (!ok) throw new Error("用户名或密码错误");
  return { user: toUser(row), ...createSession(row.id) };
}

export function getUserById(userId: string): AuthUser | null {
  const row = getAuthDb()
    .prepare("SELECT * FROM auth_users WHERE id = ?")
    .get(userId) as any;
  return row ? toUser(row) : null;
}

export function getUserByToken(token: string): AuthUser | null {
  if (!token.trim()) return null;
  const row = getAuthDb()
    .prepare(
      `SELECT u.*
       FROM auth_sessions s
       JOIN auth_users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), Date.now()) as any;
  return row ? toUser(row) : null;
}

export function revokeSession(token: string): void {
  if (!token.trim()) return;
  getAuthDb().prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(hashToken(token));
}

export function updateAuthUserDisplayName(userId: string, displayName: string): AuthUser | null {
  const safeName = displayName.trim().slice(0, 32);
  if (!safeName) return null;
  const result = getAuthDb()
    .prepare("UPDATE auth_users SET display_name = ?, updated_at = datetime('now') WHERE id = ?")
    .run(safeName, userId);
  if (result.changes === 0) return null;
  return getUserById(userId);
}
