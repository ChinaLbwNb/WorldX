import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const requireFromServer = createRequire(path.join(repoRoot, "server", "package.json"));
const Database = requireFromServer("better-sqlite3");
const apiBase = process.env.WORLDX_API_BASE ?? "http://localhost:3100/api";
const dataDir = path.resolve(process.env.WORLDX_DATA_DIR ?? path.join(repoRoot, "output"));
const worldsDir = path.join(dataDir, "worlds");
const authDbPath = path.join(dataDir, "auth.db");
const stamp = Date.now().toString(36);
const worldId = `perm_test_world_${stamp}`;
const worldDir = path.join(worldsDir, worldId);
const deleteWorldId = `perm_delete_world_${stamp}`;
const deleteWorldDir = path.join(worldsDir, deleteWorldId);
const users = [
  { key: "owner", username: `perm_owner_${stamp}`, role: "owner" },
  { key: "admin", username: `perm_admin_${stamp}`, role: "admin" },
  { key: "builder", username: `perm_builder_${stamp}`, role: "builder" },
  { key: "viewer", username: `perm_viewer_${stamp}`, role: "viewer" },
  { key: "stranger", username: `perm_stranger_${stamp}`, role: "stranger" },
  { key: "target", username: `perm_target_${stamp}`, role: "target" },
];

const results = [];
const createdUserIds = [];

function push(name, expected, actual, detail = "") {
  const ok = actual === expected;
  results.push({ ok, name, expected, actual, detail });
}

async function request(token, method, route, body) {
  const res = await fetch(`${apiBase}${route}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

async function register(user) {
  const res = await request("", "POST", "/auth/register", {
    username: user.username,
    password: "123123",
    displayName: user.username,
  });
  if (res.status !== 200 || !res.data?.token || !res.data?.user?.id) {
    throw new Error(`register ${user.username} failed: ${res.status} ${JSON.stringify(res.data)}`);
  }
  user.id = res.data.user.id;
  user.token = res.data.token;
  createdUserIds.push(user.id);
}

async function canListWorld(user) {
  const response = await request(user.token, "GET", "/world/worlds");
  if (response.status !== 200) return `status:${response.status}`;
  return Boolean(response.data?.worlds?.some((world) => world.id === worldId));
}

function writeMinimalWorld(ownerUserId, targetWorldId = worldId, targetWorldDir = worldDir) {
  fs.mkdirSync(path.join(targetWorldDir, "config"), { recursive: true });
  fs.mkdirSync(path.join(targetWorldDir, "maps", "map_origin"), { recursive: true });
  fs.writeFileSync(path.join(targetWorldDir, "worldx.meta.json"), JSON.stringify({
    ownerUserId,
    visibility: "private",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2), "utf-8");
  fs.writeFileSync(path.join(targetWorldDir, "config", "world.json"), JSON.stringify({
    worldName: `权限测试世界 ${stamp}`,
    worldDescription: "permission test world",
    originalPrompt: "permission test world",
    contentLanguage: "zh",
    activeMapId: "map_origin",
    worldMaps: {
      activeMapId: "map_origin",
      maps: [{
        id: "map_origin",
        name: "默认地图",
        status: "ready",
        x: 0,
        y: 0,
        directionFromParent: null,
        createdAt: new Date().toISOString(),
      }],
      links: [],
    },
    locations: [],
    mainAreaPoints: [],
    characters: [],
    resources: [],
  }, null, 2), "utf-8");
}

function seedMemberships() {
  const db = new Database(authDbPath);
  try {
    for (const user of users) {
      if (user.role === "admin" || user.role === "builder" || user.role === "viewer") {
        db.prepare(
          `INSERT INTO account_world_members
           (world_id, user_id, role, invited_by_user_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(world_id, user_id) DO UPDATE SET role = excluded.role, updated_at = datetime('now')`,
        ).run(worldId, user.id, user.role, users[0].id);
      }
    }
  } finally {
    db.close();
  }
}

function cleanup() {
  if (!fs.existsSync(authDbPath)) return;
  const db = new Database(authDbPath);
  try {
    db.prepare("DELETE FROM account_world_members WHERE world_id = ?").run(worldId);
    db.prepare("DELETE FROM account_world_members WHERE world_id = ?").run(deleteWorldId);
    for (const userId of createdUserIds) {
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM account_world_assets WHERE user_id = ? OR world_id = ?").run(userId, worldId);
      db.prepare("DELETE FROM account_world_assets WHERE user_id = ? OR world_id = ?").run(userId, deleteWorldId);
      db.prepare("DELETE FROM account_timeline_assets WHERE user_id = ? OR world_id = ?").run(userId, worldId);
      db.prepare("DELETE FROM account_timeline_assets WHERE user_id = ? OR world_id = ?").run(userId, deleteWorldId);
      db.prepare("DELETE FROM account_inventory_entries WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM account_item_instances WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM account_item_definitions WHERE user_id = ?").run(userId);
      db.prepare(
        `DELETE FROM account_user_character_presence
         WHERE character_id IN (SELECT id FROM account_user_characters WHERE user_id = ?)`,
      ).run(userId);
      db.prepare("DELETE FROM account_user_characters WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM account_resources WHERE user_id = ?").run(userId);
      db.prepare("DELETE FROM auth_users WHERE id = ?").run(userId);
    }
  } finally {
    db.close();
  }
  removeWorldDirWithRetry(worldDir);
  removeWorldDirWithRetry(deleteWorldDir);
}

async function switchAwayFromTempWorld() {
  const owner = users.find((user) => user.key === "owner");
  if (!owner?.token) return;
  await request(owner.token, "POST", "/world/select", { worldId: "world_2026-04-19T17-12-41" }).catch(() => null);
}

function removeWorldDirWithRetry(targetDir) {
  if (!fs.existsSync(targetDir)) return;
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    }
  }
  throw lastError;
}

async function main() {
  if (!fs.existsSync(authDbPath)) {
    throw new Error(`auth db not found: ${authDbPath}`);
  }
  const health = await request("", "GET", "/auth/me");
  if (health.status !== 401) {
    throw new Error(`unexpected auth health status: ${health.status}`);
  }

  try {
    for (const user of users) await register(user);
    writeMinimalWorld(users[0].id);
    writeMinimalWorld(users[0].id, deleteWorldId, deleteWorldDir);
    seedMemberships();

    const byKey = Object.fromEntries(users.map((user) => [user.key, user]));
    const roleExpectations = {
      owner: { access: 200, manage: 200, members: 200, addMember: 200, deleteWorld: 200 },
      admin: { access: 200, manage: 200, members: 200, addMember: 200, deleteWorld: 403 },
      builder: { access: 200, manage: 403, members: 403, addMember: 403, deleteWorld: 403 },
      viewer: { access: 200, manage: 403, members: 403, addMember: 403, deleteWorld: 403 },
      stranger: { access: 403, manage: 403, members: 403, addMember: 403, deleteWorld: 403 },
    };

    for (const user of users.filter((item) => item.key !== "target")) {
      const exp = roleExpectations[user.key];
      push(`${user.key}: list/access private world`, exp.access === 200, await canListWorld(user));
      push(`${user.key}: update visibility/manage`, exp.manage, (await request(user.token, "PATCH", `/world/worlds/${worldId}`, { visibility: "private" })).status);
      push(`${user.key}: list members/manage`, exp.members, (await request(user.token, "GET", `/world/worlds/${worldId}/members`)).status);
      push(`${user.key}: add member/manage`, exp.addMember, (await request(user.token, "POST", `/world/worlds/${worldId}/members`, { userId: byKey.target.id, role: "viewer" })).status);
      if (user.key !== "owner") {
        push(`${user.key}: delete world only owner`, exp.deleteWorld, (await request(user.token, "DELETE", `/world/worlds/${worldId}`)).status);
      }
    }

    const ownerAddGuest = await request(byKey.owner.token, "POST", `/world/worlds/${worldId}/members`, {
      userId: byKey.target.id,
      role: "guest",
    });
    push("owner: legacy guest normalizes to viewer", 200, ownerAddGuest.status, JSON.stringify(ownerAddGuest.data));
    push("owner: normalized guest role payload", "viewer", ownerAddGuest.data?.member?.role ?? "");

    const ownerAddMember = await request(byKey.owner.token, "POST", `/world/worlds/${worldId}/members`, {
      userId: byKey.target.id,
      role: "member",
    });
    push("owner: legacy member normalizes to builder", 200, ownerAddMember.status, JSON.stringify(ownerAddMember.data));
    push("owner: normalized member role payload", "builder", ownerAddMember.data?.member?.role ?? "");

    const ownerCannotAddSelf = await request(byKey.owner.token, "POST", `/world/worlds/${worldId}/members`, {
      userId: byKey.owner.id,
      role: "admin",
    });
    push("owner: cannot add owner as explicit member", 400, ownerCannotAddSelf.status);

    const ownerDelete = await request(byKey.owner.token, "DELETE", `/world/worlds/${deleteWorldId}`);
    push("owner: can delete owned world", 200, ownerDelete.status, JSON.stringify(ownerDelete.data));
    push("owner: deleted world directory removed", false, fs.existsSync(deleteWorldDir));
  } finally {
    await switchAwayFromTempWorld();
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} expected=${r.expected} actual=${r.actual}${r.detail ? ` detail=${r.detail}` : ""}`);
  }
  if (failed.length) {
    console.error(`\n${failed.length} permission test(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`\nAll ${results.length} permission tests passed`);
  }
}

main().catch((error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});
