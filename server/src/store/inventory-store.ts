import { getDb } from "./db.js";
import { getAuthDb } from "./auth-store.js";
import { generateId } from "../utils/id-generator.js";
import type { InventoryOwnerRef, ItemCategory } from "../types/index.js";

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

export function pickupMapItemPlacement(input: {
  placementId: string;
  owner: InventoryOwnerRef;
  worldId: string;
  timelineId: string;
  mapId: string;
}): { item: InventoryItemView; placement: MapItemPlacementView } {
  const worldDb = getDb();
  const accountDb = getAuthDb();
  const placement = getMapItemPlacement(input.placementId);
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
  const updatedPlacement = getMapItemPlacement(input.placementId);
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
}): MapItemPlacementView {
  const worldDb = getDb();
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
  const placement = getMapItemPlacement(placementId);
  if (!placement) throw new Error(`Placement not found after insert: ${placementId}`);
  return placement;
}

export function getMapItemPlacements(scope: { worldId: string; timelineId: string; mapId: string }): MapItemPlacementView[] {
  return (
    getDb()
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

function getMapItemPlacement(placementId: string): MapItemPlacementView | null {
  const row = getDb()
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
