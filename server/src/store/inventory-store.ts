import { getDb } from "./db.js";
import { getAuthDb } from "./auth-store.js";
import { generateId } from "../utils/id-generator.js";
import type { InventoryOwnerRef, ItemCategory } from "../types/index.js";
import type Database from "better-sqlite3";

export type InventoryItemView = {
  entryId: string;
  itemInstanceId: string;
  definitionId: string;
  name: string;
  description: string;
  category: string;
  iconKey: string | null;
  quantity: number;
  stackable: boolean;
  maxStack: number;
  placeable: boolean;
  state: Record<string, unknown>;
  metadata: Record<string, unknown>;
};

export type MapItemPlacementView = {
  id: string;
  itemInstanceId: string;
  definitionId: string;
  name: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  x: number;
  y: number;
  rotation: number;
  state: string;
  placedBy: InventoryOwnerRef | null;
  metadata: Record<string, unknown>;
};

export type ItemTransferView = {
  id: string;
  userId: string;
  worldId: string;
  timelineId: string;
  mapId: string;
  itemInstanceId: string;
  quantity: number;
  fromOwner: InventoryOwnerRef | null;
  toOwner: InventoryOwnerRef | null;
  kind: string;
  status: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  item: InventoryItemView | null;
};

export type InventoryEntryOwnerView = {
  entryId: string;
  owner: InventoryOwnerRef;
  userId: string;
  itemInstanceId: string;
  quantity: number;
};

type AddItemInput = {
  owner: InventoryOwnerRef;
  definition: {
    id: string;
    name: string;
    description?: string;
    category?: ItemCategory;
    iconKey?: string | null;
    stackable?: boolean;
    maxStack?: number;
    placeable?: boolean;
    metadata?: Record<string, unknown>;
  };
  worldId: string;
  timelineId: string;
  mapId: string;
  quantity: number;
  transferKind?: "collect" | "pickup" | "drop" | "place" | "trade" | "gift" | "destroy" | "system";
  state?: Record<string, unknown>;
  transferMetadata?: Record<string, unknown>;
};

type InventoryLifecycleKind = "drop" | "use";
const TRANSFER_TTL_MS = 15 * 60 * 1000;

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getAccountUserIdForOwner(owner: InventoryOwnerRef): string {
  if (owner.ownerType === "account") {
    return owner.ownerId;
  }
  if (owner.ownerType === "user_character") {
    const row = getAuthDb()
      .prepare("SELECT user_id FROM account_user_characters WHERE id = ?")
      .get(owner.ownerId) as { user_id?: string } | undefined;
    if (row?.user_id) return row.user_id;
  }
  return owner.ownerId;
}

export function migrateUserCharacterInventoryToAccount(userId: string): void {
  const accountDb = getAuthDb();
  accountDb.prepare(
    `UPDATE account_inventory_entries
     SET owner_type = 'account', owner_id = ?, user_id = ?, updated_at = datetime('now')
     WHERE user_id = ? AND owner_type = 'user_character'`,
  ).run(userId, userId, userId);

  accountDb.prepare(
    `UPDATE account_item_transfers
     SET to_owner_type = 'account', to_owner_id = ?, user_id = ?
     WHERE user_id = ? AND to_owner_type = 'user_character'`,
  ).run(userId, userId, userId);

  accountDb.prepare(
    `UPDATE account_item_transfers
     SET from_owner_type = 'account', from_owner_id = ?, user_id = ?
     WHERE user_id = ? AND from_owner_type = 'user_character'`,
  ).run(userId, userId, userId);

  const characterIds = (
    accountDb.prepare("SELECT id FROM account_user_characters WHERE user_id = ?").all(userId) as Array<{ id: string }>
  ).map((row) => row.id);
  if (characterIds.length === 0) return;
  const placeholders = characterIds.map(() => "?").join(", ");
  getDb().prepare(
    `UPDATE map_item_placements
     SET placed_by_owner_type = 'account', placed_by_owner_id = ?, updated_at = datetime('now')
     WHERE placed_by_owner_type = 'user_character'
       AND placed_by_owner_id IN (${placeholders})`,
  ).run(userId, ...characterIds);
}

export function ensureItemDefinition(input: AddItemInput["definition"], userId: string): void {
  getAuthDb()
    .prepare(
      `INSERT INTO account_item_definitions
       (id, user_id, name, description, category, icon_key, stackable, max_stack, placeable, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         name = excluded.name,
         description = excluded.description,
         category = excluded.category,
         icon_key = excluded.icon_key,
         stackable = excluded.stackable,
         max_stack = excluded.max_stack,
         placeable = excluded.placeable,
         metadata = excluded.metadata,
         updated_at = datetime('now')`,
    )
    .run(
      input.id,
      userId,
      input.name,
      input.description ?? "",
      input.category ?? "misc",
      input.iconKey ?? null,
      input.stackable === false ? 0 : 1,
      input.maxStack ?? 999,
      input.placeable ? 1 : 0,
      JSON.stringify(input.metadata ?? {}),
    );
}

export function addItemToInventory(input: AddItemInput): InventoryItemView {
  if (input.quantity <= 0) {
    throw new Error("quantity must be positive");
  }

  const accountUserId = getAccountUserIdForOwner(input.owner);
  ensureItemDefinition({
    ...input.definition,
  }, accountUserId);

  const db = getAuthDb();
  const itemInstanceId = `item_${generateId()}`;
  const entryId = `inv_${generateId()}`;
  const transferId = `transfer_${generateId()}`;

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO account_item_instances
       (id, definition_id, user_id, quantity, state)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      itemInstanceId,
      input.definition.id,
      accountUserId,
      input.quantity,
      JSON.stringify(input.state ?? {}),
    );

    db.prepare(
      `INSERT INTO account_inventory_entries
       (id, owner_type, owner_id, user_id, item_instance_id, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId,
      input.owner.ownerType,
      input.owner.ownerId,
      accountUserId,
      itemInstanceId,
      input.quantity,
    );

    db.prepare(
      `INSERT INTO account_item_transfers
       (id, user_id, world_id, timeline_id, map_id, item_instance_id, quantity,
        to_owner_type, to_owner_id, kind, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId,
      accountUserId,
      input.worldId,
      input.timelineId,
      input.mapId,
      itemInstanceId,
      input.quantity,
      input.owner.ownerType,
      input.owner.ownerId,
      input.transferKind ?? "system",
      "completed",
      JSON.stringify(input.transferMetadata ?? {}),
    );
  });

  tx();
  const item = getInventoryItemByEntryId(entryId);
  if (!item) {
    throw new Error(`Inventory entry not found after insert: ${entryId}`);
  }
  return item;
}

export function getInventoryForOwner(owner: InventoryOwnerRef): InventoryItemView[] {
  return (
    getAuthDb()
      .prepare(
        `SELECT e.id AS entry_id,
                e.item_instance_id,
                e.quantity AS entry_quantity,
                d.id AS definition_id,
                d.name,
                d.description,
                d.category,
                d.icon_key,
                d.stackable,
                d.max_stack,
                d.placeable,
                d.metadata,
                i.state
         FROM account_inventory_entries e
         JOIN account_item_instances i ON i.id = e.item_instance_id
         JOIN account_item_definitions d ON d.id = i.definition_id
         WHERE e.owner_type = ? AND e.owner_id = ?
         ORDER BY e.created_at ASC`,
      )
      .all(owner.ownerType, owner.ownerId) as any[]
  ).map(rowToInventoryItemView);
}

export function getInventoryItemByEntryId(entryId: string): InventoryItemView | null {
  const row = getAuthDb()
    .prepare(
      `SELECT e.id AS entry_id,
              e.item_instance_id,
              e.quantity AS entry_quantity,
              d.id AS definition_id,
              d.name,
              d.description,
              d.category,
              d.icon_key,
              d.stackable,
              d.max_stack,
              d.placeable,
              d.metadata,
              i.state
       FROM account_inventory_entries e
       JOIN account_item_instances i ON i.id = e.item_instance_id
       JOIN account_item_definitions d ON d.id = i.definition_id
       WHERE e.id = ?`,
    )
    .get(entryId) as any;
  return row ? rowToInventoryItemView(row) : null;
}

export function getInventoryEntryOwner(entryId: string): InventoryEntryOwnerView | null {
  const row = getAuthDb()
    .prepare(
      `SELECT id, owner_type, owner_id, user_id, item_instance_id, quantity
       FROM account_inventory_entries
       WHERE id = ?`,
    )
    .get(entryId) as any;
  if (!row) return null;
  return {
    entryId: row.id,
    owner: { ownerType: row.owner_type, ownerId: row.owner_id },
    userId: row.user_id,
    itemInstanceId: row.item_instance_id,
    quantity: Number(row.quantity ?? 1),
  };
}

export function deleteInventoryEntry(input: {
  entryId: string;
  owner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
}): { item: InventoryItemView; deletedAssetPath: string | null } {
  const item = getInventoryItemByEntryId(input.entryId);
  if (!item) throw new Error("Inventory entry not found");

  const db = getAuthDb();
  const entry = db.prepare(
    `SELECT owner_type, owner_id, item_instance_id, quantity
     FROM account_inventory_entries
     WHERE id = ?`,
  ).get(input.entryId) as any;
  if (!entry) throw new Error("Inventory entry not found");
  if (entry.owner_type !== input.owner.ownerType || entry.owner_id !== input.owner.ownerId) {
    throw new Error("Inventory entry does not belong to owner");
  }

  let deletedAssetPath: string | null = null;

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM account_inventory_entries WHERE id = ?").run(input.entryId);

    const remainingInventoryRefs = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM account_inventory_entries WHERE item_instance_id = ?").get(item.itemInstanceId) as any)?.count ?? 0,
    );
    const remainingPlacementRefs = Number(
      (getDb().prepare("SELECT COUNT(*) AS count FROM map_item_placements WHERE item_instance_id = ? AND state = 'placed'").get(item.itemInstanceId) as any)?.count ?? 0,
    );
    if (remainingInventoryRefs === 0 && remainingPlacementRefs === 0) {
      db.prepare("DELETE FROM account_item_transfers WHERE item_instance_id = ?").run(item.itemInstanceId);
      db.prepare("DELETE FROM account_item_instances WHERE id = ?").run(item.itemInstanceId);
    }

    const remainingDefinitionInstances = Number(
      (db.prepare("SELECT COUNT(*) AS count FROM account_item_instances WHERE definition_id = ?").get(item.definitionId) as any)?.count ?? 0,
    );
    if (remainingDefinitionInstances === 0) {
      db.prepare("DELETE FROM account_item_definitions WHERE id = ?").run(item.definitionId);
      const assetPath = typeof item.metadata?.assetPath === "string" ? item.metadata.assetPath : "";
      if (assetPath && !isAssetPathReferenced(db, assetPath)) {
        deletedAssetPath = assetPath;
      }
    }
  });

  tx();
  return { item, deletedAssetPath };
}

export function removeInventoryEntryForLifecycle(input: {
  entryId: string;
  owner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
  kind: InventoryLifecycleKind;
  metadata?: Record<string, unknown>;
}): { item: InventoryItemView } {
  const item = getInventoryItemByEntryId(input.entryId);
  if (!item) throw new Error("Inventory entry not found");
  const db = getAuthDb();
  const entry = db.prepare(
    `SELECT owner_type, owner_id, user_id, item_instance_id, quantity
     FROM account_inventory_entries
     WHERE id = ?`,
  ).get(input.entryId) as any;
  if (!entry) throw new Error("Inventory entry not found");
  if (entry.owner_type !== input.owner.ownerType || entry.owner_id !== input.owner.ownerId) {
    throw new Error("Inventory entry does not belong to owner");
  }
  if (input.kind === "use" && !isItemUsable(item)) {
    throw new Error("Item is not usable");
  }

  const currentState = item.state && typeof item.state === "object" ? item.state : {};
  const nextState = {
    ...currentState,
    lifecycle: input.kind === "use" ? "used" : "dropped",
    lifecycleAt: new Date().toISOString(),
    lifecycleScope: {
      worldId: input.worldId,
      timelineId: input.timelineId,
      mapId: input.mapId,
    },
  };
  const transferId = `transfer_${generateId()}`;
  const quantity = Number(entry.quantity ?? 1);
  const accountUserId = getAccountUserIdForOwner(input.owner);

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM account_inventory_entries WHERE id = ?").run(input.entryId);
    db.prepare(
      `UPDATE account_item_instances
       SET state = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(JSON.stringify(nextState), item.itemInstanceId);
    db.prepare(
      `INSERT INTO account_item_transfers
       (id, user_id, world_id, timeline_id, map_id, item_instance_id, quantity,
        from_owner_type, from_owner_id, kind, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId,
      accountUserId,
      input.worldId,
      input.timelineId,
      input.mapId,
      item.itemInstanceId,
      quantity,
      input.owner.ownerType,
      input.owner.ownerId,
      input.kind,
      "completed",
      JSON.stringify(input.metadata ?? {}),
    );
  });
  tx();
  return { item };
}

export function requestInventoryTransfer(input: {
  entryId: string;
  fromOwner: InventoryOwnerRef;
  toOwner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
  kind?: "trade" | "gift";
  metadata?: Record<string, unknown>;
}): ItemTransferView {
  const db = getAuthDb();
  const entry = db.prepare(
    `SELECT e.owner_type, e.owner_id, e.user_id, e.item_instance_id, e.quantity
     FROM account_inventory_entries e
     WHERE e.id = ?`,
  ).get(input.entryId) as any;
  if (!entry) throw new Error("Inventory entry not found");
  if (entry.owner_type !== input.fromOwner.ownerType || entry.owner_id !== input.fromOwner.ownerId) {
    throw new Error("Inventory entry does not belong to owner");
  }
  if (input.fromOwner.ownerType !== "account" || input.toOwner.ownerType !== "account") {
    throw new Error("Only account-owned item transfers are supported");
  }
  if (input.fromOwner.ownerId === input.toOwner.ownerId) {
    throw new Error("Cannot transfer item to the same account");
  }

  const transferId = `transfer_${generateId()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TRANSFER_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO account_item_transfers
     (id, user_id, world_id, timeline_id, map_id, item_instance_id, quantity,
      from_owner_type, from_owner_id, to_owner_type, to_owner_id, kind, status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    transferId,
    input.fromOwner.ownerId,
    input.worldId,
    input.timelineId,
    input.mapId,
    entry.item_instance_id,
    Number(entry.quantity ?? 1),
    input.fromOwner.ownerType,
    input.fromOwner.ownerId,
    input.toOwner.ownerType,
    input.toOwner.ownerId,
    input.kind ?? "gift",
    "requested",
    JSON.stringify({
      ...(input.metadata ?? {}),
      entryId: input.entryId,
      expiresAt,
    }),
  );

  const transfer = getItemTransferById(transferId);
  if (!transfer) throw new Error(`Transfer not found after request: ${transferId}`);
  return transfer;
}

export function listItemTransfersForAccount(input: {
  userId: string;
  status?: "requested" | "completed" | "cancelled" | "failed";
}): { incoming: ItemTransferView[]; outgoing: ItemTransferView[] } {
  expireRequestedTransfersForAccount(input.userId);
  const status = input.status ?? "requested";
  const incoming = (getAuthDb().prepare(
    `SELECT * FROM account_item_transfers
     WHERE to_owner_type = 'account' AND to_owner_id = ? AND status = ?
     ORDER BY created_at DESC`,
  ).all(input.userId, status) as any[]).map(rowToTransferView);
  const outgoing = (getAuthDb().prepare(
    `SELECT * FROM account_item_transfers
     WHERE from_owner_type = 'account' AND from_owner_id = ? AND status = ?
     ORDER BY created_at DESC`,
  ).all(input.userId, status) as any[]).map(rowToTransferView);
  return { incoming, outgoing };
}

export function completeInventoryTransfer(input: {
  transferId: string;
  targetOwner: InventoryOwnerRef;
  accept: boolean;
}): ItemTransferView {
  const transfer = getItemTransferById(input.transferId);
  if (!transfer) throw new Error("Transfer not found");
  expireRequestedTransfer(transfer);
  const currentTransfer = getItemTransferById(input.transferId);
  if (!currentTransfer) throw new Error("Transfer not found");
  if (currentTransfer.status !== "requested") throw new Error("Transfer is not pending");
  if (!currentTransfer.fromOwner || !currentTransfer.toOwner) throw new Error("Transfer owner is incomplete");
  if (currentTransfer.toOwner.ownerType !== input.targetOwner.ownerType || currentTransfer.toOwner.ownerId !== input.targetOwner.ownerId) {
    throw new Error("Transfer does not belong to target owner");
  }

  return completePendingInventoryTransfer({
    transferId: input.transferId,
    transfer: currentTransfer,
    accept: input.accept,
  });
}

export function cancelInventoryTransfer(input: {
  transferId: string;
  requesterOwner: InventoryOwnerRef;
}): ItemTransferView {
  const db = getAuthDb();
  const transfer = getItemTransferById(input.transferId);
  if (!transfer) throw new Error("Transfer not found");
  expireRequestedTransfer(transfer);
  const currentTransfer = getItemTransferById(input.transferId);
  if (!currentTransfer) throw new Error("Transfer not found");
  if (currentTransfer.status !== "requested") throw new Error("Transfer is not pending");
  if (!currentTransfer.fromOwner) throw new Error("Transfer owner is incomplete");
  if (
    currentTransfer.fromOwner.ownerType !== input.requesterOwner.ownerType ||
    currentTransfer.fromOwner.ownerId !== input.requesterOwner.ownerId
  ) {
    throw new Error("Transfer does not belong to requester owner");
  }
  db.prepare("UPDATE account_item_transfers SET status = 'cancelled' WHERE id = ?").run(input.transferId);
  const cancelled = getItemTransferById(input.transferId);
  if (!cancelled) throw new Error("Transfer not found after cancel");
  return cancelled;
}

function completePendingInventoryTransfer(input: {
  transferId: string;
  transfer: ItemTransferView;
  accept: boolean;
}): ItemTransferView {
  const db = getAuthDb();
  const transfer = input.transfer;
  if (transfer.status !== "requested") throw new Error("Transfer is not pending");
  if (!transfer.fromOwner || !transfer.toOwner) throw new Error("Transfer owner is incomplete");

  if (!input.accept) {
    db.prepare("UPDATE account_item_transfers SET status = 'cancelled' WHERE id = ?").run(input.transferId);
    const cancelled = getItemTransferById(input.transferId);
    if (!cancelled) throw new Error("Transfer not found after cancel");
    return cancelled;
  }

  const entryId = typeof transfer.metadata?.entryId === "string" ? transfer.metadata.entryId : "";
  if (!entryId) throw new Error("Transfer has no source inventory entry");

  if (transfer.kind === "trade") {
    return completeInventoryTradeTransfer({
      transferId: input.transferId,
      transfer,
      sourceEntryId: entryId,
    });
  }

  const tx = db.transaction(() => {
    const entry = db.prepare(
      `SELECT owner_type, owner_id, user_id, item_instance_id
       FROM account_inventory_entries
       WHERE id = ?`,
    ).get(entryId) as any;
    if (!entry) throw new Error("Source inventory entry no longer exists");
    if (
      entry.owner_type !== transfer.fromOwner?.ownerType ||
      entry.owner_id !== transfer.fromOwner?.ownerId ||
      entry.item_instance_id !== transfer.itemInstanceId
    ) {
      throw new Error("Source inventory entry is no longer transferable");
    }
    db.prepare(
      `UPDATE account_inventory_entries
       SET owner_type = ?, owner_id = ?, user_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      transfer.toOwner!.ownerType,
      transfer.toOwner!.ownerId,
      getAccountUserIdForOwner(transfer.toOwner!),
      entryId,
    );
    db.prepare("UPDATE account_item_instances SET user_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(getAccountUserIdForOwner(transfer.toOwner!), transfer.itemInstanceId);
    db.prepare(
      `UPDATE account_item_definitions
       SET user_id = ?, updated_at = datetime('now')
       WHERE id = (
         SELECT definition_id FROM account_item_instances WHERE id = ?
       )`,
    ).run(getAccountUserIdForOwner(transfer.toOwner!), transfer.itemInstanceId);
    db.prepare("UPDATE account_item_transfers SET status = 'completed' WHERE id = ?").run(input.transferId);
  });
  tx();

  const completed = getItemTransferById(input.transferId);
  if (!completed) throw new Error("Transfer not found after completion");
  return completed;
}

function completeInventoryTradeTransfer(input: {
  transferId: string;
  transfer: ItemTransferView;
  sourceEntryId: string;
}): ItemTransferView {
  const db = getAuthDb();
  const requestedEntryId = typeof input.transfer.metadata?.requestedEntryId === "string"
    ? input.transfer.metadata.requestedEntryId
    : "";
  if (!requestedEntryId) throw new Error("Trade has no requested inventory entry");
  if (requestedEntryId === input.sourceEntryId) throw new Error("Cannot trade the same inventory entry");
  if (!input.transfer.fromOwner || !input.transfer.toOwner) throw new Error("Transfer owner is incomplete");

  const fromOwner = input.transfer.fromOwner;
  const toOwner = input.transfer.toOwner;
  const fromUserId = getAccountUserIdForOwner(fromOwner);
  const toUserId = getAccountUserIdForOwner(toOwner);

  const tx = db.transaction(() => {
    const offeredEntry = db.prepare(
      `SELECT id, owner_type, owner_id, item_instance_id
       FROM account_inventory_entries
       WHERE id = ?`,
    ).get(input.sourceEntryId) as any;
    if (!offeredEntry) throw new Error("Source inventory entry no longer exists");
    if (
      offeredEntry.owner_type !== fromOwner.ownerType ||
      offeredEntry.owner_id !== fromOwner.ownerId ||
      offeredEntry.item_instance_id !== input.transfer.itemInstanceId
    ) {
      throw new Error("Source inventory entry is no longer transferable");
    }

    const requestedEntry = db.prepare(
      `SELECT id, owner_type, owner_id, item_instance_id
       FROM account_inventory_entries
       WHERE id = ?`,
    ).get(requestedEntryId) as any;
    if (!requestedEntry) throw new Error("Requested inventory entry no longer exists");
    if (
      requestedEntry.owner_type !== toOwner.ownerType ||
      requestedEntry.owner_id !== toOwner.ownerId
    ) {
      throw new Error("Requested inventory entry is no longer tradable");
    }

    db.prepare(
      `UPDATE account_inventory_entries
       SET owner_type = ?, owner_id = ?, user_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      toOwner.ownerType,
      toOwner.ownerId,
      toUserId,
      input.sourceEntryId,
    );
    db.prepare(
      `UPDATE account_inventory_entries
       SET owner_type = ?, owner_id = ?, user_id = ?, updated_at = datetime('now')
       WHERE id = ?`,
    ).run(
      fromOwner.ownerType,
      fromOwner.ownerId,
      fromUserId,
      requestedEntryId,
    );
    db.prepare("UPDATE account_item_instances SET user_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(toUserId, offeredEntry.item_instance_id);
    db.prepare("UPDATE account_item_instances SET user_id = ?, updated_at = datetime('now') WHERE id = ?")
      .run(fromUserId, requestedEntry.item_instance_id);
    db.prepare(
      `UPDATE account_item_definitions
       SET user_id = ?, updated_at = datetime('now')
       WHERE id = (
         SELECT definition_id FROM account_item_instances WHERE id = ?
       )`,
    ).run(toUserId, offeredEntry.item_instance_id);
    db.prepare(
      `UPDATE account_item_definitions
       SET user_id = ?, updated_at = datetime('now')
       WHERE id = (
         SELECT definition_id FROM account_item_instances WHERE id = ?
       )`,
    ).run(fromUserId, requestedEntry.item_instance_id);
    db.prepare("UPDATE account_item_transfers SET status = 'completed' WHERE id = ?").run(input.transferId);
  });
  tx();

  const completed = getItemTransferById(input.transferId);
  if (!completed) throw new Error("Transfer not found after completion");
  return completed;
}

export function pickupMapItemPlacement(input: {
  placementId: string;
  owner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
  worldDb?: Database.Database;
}): { item: InventoryItemView; placement: MapItemPlacementView } {
  const worldDb = input.worldDb ?? getDb();
  const accountDb = getAuthDb();
  const placement = getMapItemPlacement(input.placementId, worldDb);
  if (!placement) throw new Error("Placement not found");
  if (placement.state !== "placed") throw new Error("Placement is not available");
  if (
    placement.worldId !== input.worldId ||
    placement.timelineId !== input.timelineId ||
    placement.mapId !== input.mapId
  ) {
    throw new Error("Placement is outside current scope");
  }
  if (
    !placement.placedBy ||
    placement.placedBy.ownerType !== input.owner.ownerType ||
    placement.placedBy.ownerId !== input.owner.ownerId
  ) {
    throw new Error("Placement does not belong to owner");
  }

  const entryId = `inv_${generateId()}`;
  const transferId = `transfer_${generateId()}`;
  const accountUserId = getAccountUserIdForOwner(input.owner);

  const tx = worldDb.transaction(() => {
    worldDb.prepare(
      `UPDATE map_item_placements
       SET state = 'picked_up', updated_at = datetime('now')
       WHERE id = ? AND state = 'placed'`,
    ).run(input.placementId);
  });
  tx();

  const accountTx = accountDb.transaction(() => {
    accountDb.prepare(
      `INSERT INTO account_inventory_entries
       (id, owner_type, owner_id, user_id, item_instance_id, quantity)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      entryId,
      input.owner.ownerType,
      input.owner.ownerId,
      accountUserId,
      placement.itemInstanceId,
      1,
    );

    accountDb.prepare(
      `INSERT INTO account_item_transfers
       (id, user_id, world_id, timeline_id, map_id, item_instance_id, quantity,
        to_owner_type, to_owner_id, kind, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId,
      accountUserId,
      input.worldId,
      input.timelineId,
      input.mapId,
      placement.itemInstanceId,
      1,
      input.owner.ownerType,
      input.owner.ownerId,
      "pickup",
      "completed",
      JSON.stringify({ placementId: input.placementId }),
    );
  });
  accountTx();
  const item = getInventoryItemByEntryId(entryId);
  const updatedPlacement = getMapItemPlacement(input.placementId, worldDb);
  if (!item) throw new Error(`Inventory entry not found after pickup: ${entryId}`);
  if (!updatedPlacement) throw new Error(`Placement not found after pickup: ${input.placementId}`);
  return { item, placement: updatedPlacement };
}

export function placeInventoryEntry(input: {
  entryId: string;
  owner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
  x: number;
  y: number;
  rotation?: number;
  metadata?: Record<string, unknown>;
  worldDb?: Database.Database;
}): MapItemPlacementView {
  const worldDb = input.worldDb ?? getDb();
  const accountDb = getAuthDb();
  const entry = accountDb.prepare(
    `SELECT e.id,
            e.owner_type,
            e.owner_id,
            e.item_instance_id,
            e.quantity,
            d.placeable,
            d.metadata
     FROM account_inventory_entries e
     JOIN account_item_instances i ON i.id = e.item_instance_id
     JOIN account_item_definitions d ON d.id = i.definition_id
     WHERE e.id = ?`,
  ).get(input.entryId) as any;

  if (!entry) throw new Error("Inventory entry not found");
  if (entry.owner_type !== input.owner.ownerType || entry.owner_id !== input.owner.ownerId) {
    throw new Error("Inventory entry does not belong to owner");
  }
  if (entry.placeable !== 1) {
    throw new Error("Item is not placeable");
  }

  const placementId = `placement_${generateId()}`;
  const transferId = `transfer_${generateId()}`;
  const quantity = Number(entry.quantity ?? 1);
  const accountUserId = getAccountUserIdForOwner(input.owner);

  const tx = worldDb.transaction(() => {
    worldDb.prepare(
      `INSERT INTO map_item_placements
       (id, item_instance_id, world_id, timeline_id, map_id, x, y, rotation,
        placed_by_owner_type, placed_by_owner_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      placementId,
      entry.item_instance_id,
      input.worldId,
      input.timelineId,
      input.mapId,
      input.x,
      input.y,
      input.rotation ?? 0,
      input.owner.ownerType,
      input.owner.ownerId,
      JSON.stringify(input.metadata ?? {}),
    );
  });
  tx();

  const accountTx = accountDb.transaction(() => {
    accountDb.prepare("DELETE FROM account_inventory_entries WHERE id = ?").run(input.entryId);

    accountDb.prepare(
      `INSERT INTO account_item_transfers
       (id, user_id, world_id, timeline_id, map_id, item_instance_id, quantity,
        from_owner_type, from_owner_id, kind, status, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      transferId,
      accountUserId,
      input.worldId,
      input.timelineId,
      input.mapId,
      entry.item_instance_id,
      quantity,
      input.owner.ownerType,
      input.owner.ownerId,
      "place",
      "completed",
      JSON.stringify(input.metadata ?? {}),
    );
  });
  accountTx();
  const placement = getMapItemPlacement(placementId, worldDb);
  if (!placement) throw new Error(`Placement not found after insert: ${placementId}`);
  return placement;
}

export function getMapItemPlacements(
  scope: { worldId: string; timelineId: string; mapId: string },
  worldDb: Database.Database = getDb(),
): MapItemPlacementView[] {
  return (
    worldDb
      .prepare(
        `SELECT p.id,
                p.item_instance_id,
                p.world_id,
                p.timeline_id,
                p.map_id,
                p.x,
                p.y,
                p.rotation,
                p.state,
                p.placed_by_owner_type,
                p.placed_by_owner_id,
                p.metadata
         FROM map_item_placements p
         WHERE p.world_id = ? AND p.timeline_id = ? AND p.map_id = ? AND p.state = 'placed'
         ORDER BY p.created_at ASC`,
      )
      .all(scope.worldId, scope.timelineId, scope.mapId) as any[]
  ).map(rowToPlacementView);
}

function getMapItemPlacement(placementId: string, worldDb: Database.Database = getDb()): MapItemPlacementView | null {
  const row = worldDb
    .prepare(
      `SELECT p.id,
              p.item_instance_id,
              p.world_id,
              p.timeline_id,
              p.map_id,
              p.x,
              p.y,
              p.rotation,
              p.state,
              p.placed_by_owner_type,
              p.placed_by_owner_id,
              p.metadata
       FROM map_item_placements p
       WHERE p.id = ?`,
    )
    .get(placementId) as any;
  return row ? rowToPlacementView(row) : null;
}

function getItemTransferById(transferId: string): ItemTransferView | null {
  const row = getAuthDb()
    .prepare("SELECT * FROM account_item_transfers WHERE id = ?")
    .get(transferId) as any;
  return row ? rowToTransferView(row) : null;
}

function expireRequestedTransfersForAccount(userId: string): void {
  const transfers = (getAuthDb().prepare(
    `SELECT * FROM account_item_transfers
     WHERE status = 'requested'
       AND (
         (to_owner_type = 'account' AND to_owner_id = ?)
         OR (from_owner_type = 'account' AND from_owner_id = ?)
       )`,
  ).all(userId, userId) as any[]).map(rowToTransferView);
  for (const transfer of transfers) {
    expireRequestedTransfer(transfer);
  }
}

function expireRequestedTransfer(transfer: ItemTransferView): void {
  if (transfer.status !== "requested") return;
  const expiresAt = typeof transfer.metadata?.expiresAt === "string" ? transfer.metadata.expiresAt : "";
  if (!expiresAt) return;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs > Date.now()) return;
  getAuthDb()
    .prepare("UPDATE account_item_transfers SET status = 'failed' WHERE id = ? AND status = 'requested'")
    .run(transfer.id);
}

function rowToTransferView(row: any): ItemTransferView {
  return {
    id: row.id,
    userId: row.user_id,
    worldId: row.world_id ?? "",
    timelineId: row.timeline_id ?? "",
    mapId: row.map_id ?? "",
    itemInstanceId: row.item_instance_id,
    quantity: Number(row.quantity ?? 1),
    fromOwner: row.from_owner_type && row.from_owner_id
      ? { ownerType: row.from_owner_type, ownerId: row.from_owner_id }
      : null,
    toOwner: row.to_owner_type && row.to_owner_id
      ? { ownerType: row.to_owner_type, ownerId: row.to_owner_id }
      : null,
    kind: row.kind ?? "system",
    status: row.status ?? "completed",
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at ?? "",
    item: getAccountItemByInstanceId(row.item_instance_id),
  };
}

function rowToPlacementView(row: any): MapItemPlacementView {
  const item = getAccountItemByInstanceId(row.item_instance_id);
  return {
    id: row.id,
    itemInstanceId: row.item_instance_id,
    definitionId: item?.definitionId ?? "",
    name: item?.name ?? "未知物品",
    worldId: row.world_id,
    timelineId: row.timeline_id,
    mapId: row.map_id,
    x: Number(row.x ?? 0),
    y: Number(row.y ?? 0),
    rotation: Number(row.rotation ?? 0),
    state: row.state ?? "placed",
    placedBy: row.placed_by_owner_type && row.placed_by_owner_id
      ? { ownerType: row.placed_by_owner_type, ownerId: row.placed_by_owner_id }
      : null,
    metadata: parseJson(row.metadata, {}),
  };
}

function rowToInventoryItemView(row: any): InventoryItemView {
  return {
    entryId: row.entry_id,
    itemInstanceId: row.item_instance_id,
    definitionId: row.definition_id,
    name: row.name,
    description: row.description ?? "",
    category: row.category ?? "misc",
    iconKey: row.icon_key ?? null,
    quantity: Number(row.entry_quantity ?? 0),
    stackable: row.stackable === 1,
    maxStack: Number(row.max_stack ?? 1),
    placeable: row.placeable === 1,
    state: parseJson(row.state, {}),
    metadata: parseJson(row.metadata, {}),
  };
}

function getAccountItemByInstanceId(itemInstanceId: string): InventoryItemView | null {
  const row = getAuthDb()
    .prepare(
      `SELECT '' AS entry_id,
              i.id AS item_instance_id,
              i.quantity AS entry_quantity,
              d.id AS definition_id,
              d.name,
              d.description,
              d.category,
              d.icon_key,
              d.stackable,
              d.max_stack,
              d.placeable,
              d.metadata,
              i.state
       FROM account_item_instances i
       JOIN account_item_definitions d ON d.id = i.definition_id
       WHERE i.id = ?`,
    )
    .get(itemInstanceId) as any;
  return row ? rowToInventoryItemView(row) : null;
}

function isItemUsable(item: InventoryItemView): boolean {
  return item.metadata?.usable === true;
}

function isAssetPathReferenced(db: ReturnType<typeof getAuthDb>, assetPath: string): boolean {
  const likeNeedle = `%"assetPath":"${assetPath.replace(/["\\]/g, "\\$&")}"%`;
  const definitionCount = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM account_item_definitions WHERE metadata LIKE ?").get(likeNeedle) as any)?.count ?? 0,
  );
  const placementCount = Number(
    (getDb().prepare("SELECT COUNT(*) AS count FROM map_item_placements WHERE metadata LIKE ? AND state = 'placed'").get(likeNeedle) as any)?.count ?? 0,
  );
  return definitionCount > 0 || placementCount > 0;
}
