import { getAuthDb } from "./auth-store.js";

const DEFAULT_ACCOUNT_RESOURCES = 10;
export type WorldMemberRole = "admin" | "builder" | "viewer";
export type WorldPermission = "manage" | "build" | "view";

function assertAccountUserId(userId: string): string {
  const value = typeof userId === "string" ? userId.trim() : "";
  if (!value) throw new Error("Account user id is required");
  return value;
}

export function ensureAccountResources(userId: string): number {
  const accountUserId = assertAccountUserId(userId);
  const db = getAuthDb();
  db.prepare(
    `INSERT OR IGNORE INTO account_resources (user_id, amount)
     VALUES (?, ?)`,
  ).run(accountUserId, DEFAULT_ACCOUNT_RESOURCES);
  const row = db
    .prepare("SELECT amount FROM account_resources WHERE user_id = ?")
    .get(accountUserId) as { amount?: number } | undefined;
  return Number(row?.amount ?? DEFAULT_ACCOUNT_RESOURCES);
}

export function getAccountResources(userId: string): number {
  const accountUserId = assertAccountUserId(userId);
  const row = getAuthDb()
    .prepare("SELECT amount FROM account_resources WHERE user_id = ?")
    .get(accountUserId) as { amount?: number } | undefined;
  if (!row) return ensureAccountResources(accountUserId);
  const amount = Number(row.amount ?? DEFAULT_ACCOUNT_RESOURCES);
  return Number.isFinite(amount) ? amount : DEFAULT_ACCOUNT_RESOURCES;
}

export function setAccountResources(userId: string, amount: number): number {
  const accountUserId = assertAccountUserId(userId);
  const safeAmount = Math.max(0, Math.floor(Number.isFinite(amount) ? amount : DEFAULT_ACCOUNT_RESOURCES));
  getAuthDb()
    .prepare(
      `INSERT INTO account_resources (user_id, amount, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(user_id) DO UPDATE SET
         amount = excluded.amount,
         updated_at = excluded.updated_at`,
    )
    .run(accountUserId, safeAmount);
  return safeAmount;
}

export function addAccountResources(userId: string, amount: number): number {
  const accountUserId = assertAccountUserId(userId);
  if (amount <= 0) return getAccountResources(accountUserId);
  return setAccountResources(accountUserId, getAccountResources(accountUserId) + amount);
}

export function spendAccountResources(userId: string, amount: number): { ok: true; amount: number } | { ok: false; amount: number; reason: string } {
  const accountUserId = assertAccountUserId(userId);
  if (amount < 0) {
    return { ok: false, amount: getAccountResources(accountUserId), reason: "Amount must be non-negative" };
  }
  const current = getAccountResources(accountUserId);
  if (current < amount) {
    return { ok: false, amount: current, reason: `Insufficient resources. Need ${amount}, have ${current}` };
  }
  return { ok: true, amount: setAccountResources(accountUserId, current - amount) };
}

export function ensureWorldAsset(input: {
  userId: string;
  worldId: string;
  source?: "user" | "library";
  visibility?: "private" | "unlisted" | "public";
  createdAt?: string;
}): void {
  const accountUserId = assertAccountUserId(input.userId);
  if (!authUserExists(accountUserId)) return;
  getAuthDb()
    .prepare(
      `INSERT INTO account_world_assets
       (user_id, world_id, source, visibility, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, world_id) DO UPDATE SET
         source = excluded.source,
         visibility = excluded.visibility,
         updated_at = excluded.updated_at`,
    )
    .run(
      accountUserId,
      input.worldId,
      input.source ?? "user",
      input.visibility ?? "private",
      input.createdAt ?? new Date().toISOString(),
    );
}

function authUserExists(userId: string): boolean {
  const row = getAuthDb()
    .prepare("SELECT 1 FROM auth_users WHERE id = ?")
    .get(userId);
  return Boolean(row);
}

export function userOwnsWorld(userId: string, worldId: string): boolean {
  const accountUserId = assertAccountUserId(userId);
  const row = getAuthDb()
    .prepare(
      `SELECT 1 FROM account_world_assets
       WHERE user_id = ? AND world_id = ?`,
    )
    .get(accountUserId, worldId);
  return Boolean(row);
}

export function listWorldIdsForUser(userId: string): string[] {
  const accountUserId = assertAccountUserId(userId);
  const rows = getAuthDb()
    .prepare(
      `SELECT world_id FROM account_world_assets
       WHERE user_id = ?
       ORDER BY created_at DESC, world_id DESC`,
    )
    .all(accountUserId) as Array<{ world_id: string }>;
  return rows.map((row) => row.world_id);
}

export function deleteWorldAsset(userId: string, worldId: string): void {
  const accountUserId = assertAccountUserId(userId);
  getAuthDb()
    .prepare(
      `DELETE FROM account_world_assets
       WHERE user_id = ? AND world_id = ?`,
    )
    .run(accountUserId, worldId);
}

export function ensureWorldMember(input: {
  worldId: string;
  userId: string;
  role?: WorldMemberRole | "member" | "guest";
  invitedByUserId?: string;
}): void {
  const accountUserId = assertAccountUserId(input.userId);
  const role = normalizeWorldMemberRole(input.role);
  getAuthDb()
    .prepare(
      `INSERT INTO account_world_members
       (world_id, user_id, role, invited_by_user_id, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(world_id, user_id) DO UPDATE SET
         role = excluded.role,
         invited_by_user_id = excluded.invited_by_user_id,
         updated_at = excluded.updated_at`,
    )
    .run(input.worldId, accountUserId, role, input.invitedByUserId ?? null);
}

export function removeWorldMember(worldId: string, userId: string): void {
  const accountUserId = assertAccountUserId(userId);
  getAuthDb()
    .prepare("DELETE FROM account_world_members WHERE world_id = ? AND user_id = ?")
    .run(worldId, accountUserId);
}

export function userIsWorldMember(userId: string, worldId: string): boolean {
  const accountUserId = assertAccountUserId(userId);
  const row = getAuthDb()
    .prepare("SELECT 1 FROM account_world_members WHERE world_id = ? AND user_id = ?")
    .get(worldId, accountUserId);
  return Boolean(row);
}

export function getWorldMemberRole(worldId: string, userId: string): WorldMemberRole | null {
  const accountUserId = assertAccountUserId(userId);
  const row = getAuthDb()
    .prepare("SELECT role FROM account_world_members WHERE world_id = ? AND user_id = ?")
    .get(worldId, accountUserId) as { role?: string } | undefined;
  return row ? normalizeWorldMemberRole(row.role) : null;
}

export function worldMemberHasPermission(role: WorldMemberRole | null, permission: WorldPermission): boolean {
  if (!role) return false;
  if (permission === "view") return true;
  if (permission === "build") return role === "admin" || role === "builder";
  return role === "admin";
}

export function listWorldMembers(worldId: string): Array<{ userId: string; role: WorldMemberRole; invitedByUserId: string | null; createdAt: string }> {
  return (
    getAuthDb()
      .prepare(
        `SELECT user_id, role, invited_by_user_id, created_at
         FROM account_world_members
         WHERE world_id = ?
         ORDER BY created_at ASC`,
      )
      .all(worldId) as any[]
  ).map((row) => ({
    userId: row.user_id,
    role: normalizeWorldMemberRole(row.role),
    invitedByUserId: row.invited_by_user_id ?? null,
    createdAt: row.created_at ?? "",
  }));
}

export function normalizeWorldMemberRole(role: unknown): WorldMemberRole {
  if (role === "admin" || role === "builder" || role === "viewer") return role;
  if (role === "guest") return "viewer";
  return "builder";
}

export function userCanAccessAccountAsset(userId: string, assetPath: string): boolean {
  const accountUserId = assertAccountUserId(userId);
  const normalized = assetPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const [kind, idOrFile] = normalized.split("/");
  if (kind === "user-characters" && idOrFile) {
    const row = getAuthDb()
      .prepare("SELECT 1 FROM account_user_characters WHERE user_id = ? AND id = ?")
      .get(accountUserId, idOrFile);
    return Boolean(row);
  }
  if (kind === "items" && idOrFile) {
    const row = getAuthDb()
      .prepare(
        `SELECT 1 FROM account_item_definitions
         WHERE user_id = ? AND metadata LIKE ?`,
      )
      .get(accountUserId, `%"assetPath":"${normalized.replace(/["\\]/g, "\\$&")}"%`);
    return Boolean(row);
  }
  return false;
}

export function ensureTimelineAsset(input: {
  userId: string;
  worldId: string;
  timelineId: string;
  createdAt?: string;
}): void {
  const accountUserId = assertAccountUserId(input.userId);
  getAuthDb()
    .prepare(
      `INSERT OR IGNORE INTO account_timeline_assets
       (id, user_id, world_id, timeline_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(
      timelineAssetId(accountUserId, input.worldId, input.timelineId),
      accountUserId,
      input.worldId,
      input.timelineId,
      input.createdAt ?? new Date().toISOString(),
    );
}

export function userOwnsTimeline(userId: string, worldId: string, timelineId: string): boolean {
  const accountUserId = assertAccountUserId(userId);
  const row = getAuthDb()
    .prepare(
      `SELECT 1 FROM account_timeline_assets
       WHERE user_id = ? AND world_id = ? AND timeline_id = ?`,
    )
    .get(accountUserId, worldId, timelineId);
  return Boolean(row);
}

export function listTimelineIdsForUser(userId: string, worldId: string): string[] {
  const accountUserId = assertAccountUserId(userId);
  const rows = getAuthDb()
    .prepare(
      `SELECT timeline_id FROM account_timeline_assets
       WHERE user_id = ? AND world_id = ?
       ORDER BY created_at DESC, timeline_id DESC`,
    )
    .all(accountUserId, worldId) as Array<{ timeline_id: string }>;
  return rows.map((row) => row.timeline_id);
}

export function deleteTimelineAsset(userId: string, worldId: string, timelineId: string): void {
  const accountUserId = assertAccountUserId(userId);
  getAuthDb()
    .prepare(
      `DELETE FROM account_timeline_assets
       WHERE user_id = ? AND world_id = ? AND timeline_id = ?`,
    )
    .run(accountUserId, worldId, timelineId);
}

function timelineAssetId(userId: string, worldId: string, timelineId: string): string {
  return `timeline:${userId}:${worldId}:${timelineId}`;
}
