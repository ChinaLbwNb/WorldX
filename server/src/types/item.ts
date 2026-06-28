import type { PresenceScope } from "./actor.js";

export type ItemCategory =
  | "material"
  | "tool"
  | "food"
  | "equipment"
  | "quest"
  | "furniture"
  | "decoration"
  | "container"
  | "misc";

export interface ItemDefinition {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  iconKey?: string;
  stackable: boolean;
  maxStack: number;
  placeable: boolean;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ItemInstance {
  id: string;
  definitionId: string;
  scope: Pick<PresenceScope, "worldId" | "timelineId">;
  quantity: number;
  state: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export type InventoryOwnerType = "account" | "user_character" | "npc" | "container" | "system";

export interface InventoryOwnerRef {
  ownerType: InventoryOwnerType;
  ownerId: string;
}

export interface InventoryEntry {
  id: string;
  owner: InventoryOwnerRef;
  itemInstanceId: string;
  quantity: number;
  slot?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface MapItemPlacement {
  id: string;
  itemInstanceId: string;
  scope: PresenceScope;
  x: number;
  y: number;
  rotation: number;
  state: "placed" | "picked_up" | "removed";
  placedBy?: InventoryOwnerRef | null;
  metadata: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export type ItemTransferKind =
  | "collect"
  | "pickup"
  | "drop"
  | "place"
  | "trade"
  | "gift"
  | "system";

export interface ItemTransfer {
  id: string;
  scope: PresenceScope;
  itemInstanceId: string;
  quantity: number;
  fromOwner?: InventoryOwnerRef | null;
  toOwner?: InventoryOwnerRef | null;
  kind: ItemTransferKind;
  status: "requested" | "completed" | "cancelled" | "failed";
  metadata: Record<string, unknown>;
  createdAt?: string;
}
