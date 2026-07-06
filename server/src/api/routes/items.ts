import { Router, type Request, type Response } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import * as inventoryStore from "../../store/inventory-store.js";
import { removeAccountAssetPath } from "../../utils/account-assets.js";
import { onlinePlayers } from "../../services/online-players.js";
import { canUserBuildWorld, findWorldById } from "../../utils/world-directories.js";
import { openDatabaseAt } from "../../store/db.js";
import type Database from "better-sqlite3";
import { recordTutorialTaskEvent } from "../../store/tutorial-task-store.js";

const router = Router();

function accountOwner(userId: string) {
  return { ownerType: "account" as const, ownerId: userId };
}

function ensureAccountInventoryMigrated(userId: string): void {
  inventoryStore.migrateUserCharacterInventoryToAccount(userId);
}

function openWorldDbForScope(scope: { worldId: string; timelineId: string; mapId: string }): Database.Database {
  const world = findWorldById(scope.worldId);
  if (!world) throw new Error("World not found for scope");
  return openDatabaseAt(appContext.timelineManager.getTimelineDbPath(world.dir, scope.timelineId));
}

router.post("/generate", async (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : "";

  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  if (prompt.length > 300) {
    res.status(400).json({ error: "prompt must be 300 characters or fewer" });
    return;
  }
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const rm = appContext.resourceManager;
  const costs = rm.getBuildCosts();
  const spendResult = rm.spendResources(userId, costs.item);
  if (!spendResult.success) {
    res.status(400).json({
      error: spendResult.reason,
      required: costs.item,
      current: spendResult.newAmount,
    });
    return;
  }

  ensureAccountInventoryMigrated(userId);
  const scope = getCharacterScope(userCharacterId);
  const world = findWorldById(scope.worldId);
  if (!world) {
    rm.addResources(userId, costs.item);
    res.status(404).json({ error: "World not found for character presence", scope });
    return;
  }

  try {
    const result = await appContext.itemGenerator.generateForInventory({
      prompt,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      worldDescription: world.worldName,
    });
    recordTutorialTaskEvent(userId, "generate_item");
    res.json({
      ok: true,
      cost: costs.item,
      resources: rm.getResourceAmount(userId),
      scope,
      item: result.item,
      design: result.design,
    });
  } catch (error) {
    rm.addResources(userId, costs.item);
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message.startsWith("物品") ? message : `物品生成失败：${message}` });
  }
});

router.get("/inventory", (req, res) => {
  const userId = getRequestUserId(req);
  ensureAccountInventoryMigrated(userId);
  res.json({
    userId,
    owner: accountOwner(userId),
    items: inventoryStore.getInventoryForOwner(accountOwner(userId)),
  });
});

router.get("/transfers", (req, res) => {
  const userId = getRequestUserId(req);
  const status = req.query.status === "completed" || req.query.status === "cancelled" || req.query.status === "failed"
    ? req.query.status
    : "requested";
  res.json({
    userId,
    status,
    ...inventoryStore.listItemTransfersForAccount({ userId, status }),
  });
});

router.get("/trade/candidates", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  const targetUserId = typeof req.query.targetUserId === "string" ? req.query.targetUserId.trim() : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!targetUserId) {
    res.status(400).json({ error: "targetUserId is required" });
    return;
  }
  if (targetUserId === userId) {
    res.status(400).json({ error: "targetUserId must be another account" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const scope = getCharacterScope(userCharacterId);
  const targetOnline = onlinePlayers.list(scope).some((player) => player.userId === targetUserId);
  if (!targetOnline) {
    res.status(409).json({ error: "Target account is not online in the current map" });
    return;
  }

  ensureAccountInventoryMigrated(targetUserId);
  res.json({
    scope,
    targetUserId,
    items: inventoryStore.getInventoryForOwner(accountOwner(targetUserId)),
  });
});

router.get("/placements", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.query.userCharacterId === "string" ? req.query.userCharacterId : "";
  const mapId = typeof req.query.mapId === "string" ? req.query.mapId : "";
  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  const scope = resolvePlacementScope(userId, userCharacterId, mapId);
  if (!scope.ok) {
    res.status(scope.status).json({ error: scope.error });
    return;
  }
  let worldDb: Database.Database | null = null;
  try {
    worldDb = openWorldDbForScope(scope.scope);
  res.json({
    scope: scope.scope,
      placements: inventoryStore.getMapItemPlacements(scope.scope, worldDb),
  });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    worldDb?.close();
  }
});

router.post("/pickup", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const placementId = typeof req.body?.placementId === "string" ? req.body.placementId : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!placementId) {
    res.status(400).json({ error: "placementId is required" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const scope = getCharacterScope(userCharacterId);
  const world = findWorldById(scope.worldId);
  if (!world) {
    res.status(404).json({ error: "World not found for character presence", scope });
    return;
  }
  if (!canUserBuildWorld(world, userId)) {
    res.status(403).json({ error: "You need builder permission to pick up map items in this world" });
    return;
  }

  let worldDb: Database.Database | null = null;
  try {
    worldDb = openWorldDbForScope(scope);
    const result = inventoryStore.pickupMapItemPlacement({
      placementId,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      worldDb,
    });
    appContext.eventBus.emit("map_item_picked_up", {
      scope,
      placement: result.placement,
      item: result.item,
      actor: { userId, userCharacterId },
    });
    res.json({ ok: true, scope, item: result.item, placement: result.placement });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "Placement does not belong to owner" ? 403 : 400).json({ error: message });
  } finally {
    worldDb?.close();
  }
});

router.post("/delete", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!entryId) {
    res.status(400).json({ error: "entryId is required" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const scope = getCharacterScope(userCharacterId);

  try {
    ensureAccountInventoryMigrated(userId);
    const result = inventoryStore.deleteInventoryEntry({
      entryId,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
    });
    const deletedAsset = removeAccountAssetPath(result.deletedAssetPath);
    res.json({ ok: true, scope, item: result.item, deletedAsset });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/drop", (req, res) => {
  handleInventoryLifecycle(req, res, "drop");
});

router.post("/use", (req, res) => {
  handleInventoryLifecycle(req, res, "use");
});

router.post("/transfer/request", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";
  const targetUserId = typeof req.body?.targetUserId === "string" ? req.body.targetUserId.trim() : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!entryId) {
    res.status(400).json({ error: "entryId is required" });
    return;
  }
  if (!targetUserId) {
    res.status(400).json({ error: "targetUserId is required" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  const scope = {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
  };
  const targetOnline = onlinePlayers.list(scope).some((player) => player.userId === targetUserId);
  if (!targetOnline) {
    res.status(409).json({ error: "Target account is not online in the current map" });
    return;
  }

  try {
    ensureAccountInventoryMigrated(userId);
    const transfer = inventoryStore.requestInventoryTransfer({
      entryId,
      fromOwner: accountOwner(userId),
      toOwner: accountOwner(targetUserId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      kind: "gift",
      metadata: {
        fromUserCharacterId: userCharacterId,
        fromCharacterName: character.name,
      },
    });
    appContext.eventBus.emit("item_transfer_requested", {
      scope,
      transfer,
      actor: { userId, userCharacterId },
      target: { userId: targetUserId },
    });
    res.json({ ok: true, scope, transfer });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post("/trade/request", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const offerEntryId = typeof req.body?.offerEntryId === "string" ? req.body.offerEntryId : "";
  const requestedEntryId = typeof req.body?.requestedEntryId === "string" ? req.body.requestedEntryId : "";
  const targetUserId = typeof req.body?.targetUserId === "string" ? req.body.targetUserId.trim() : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!offerEntryId) {
    res.status(400).json({ error: "offerEntryId is required" });
    return;
  }
  if (!requestedEntryId) {
    res.status(400).json({ error: "requestedEntryId is required" });
    return;
  }
  if (!targetUserId) {
    res.status(400).json({ error: "targetUserId is required" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  const scope = {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
  };
  const targetOnline = onlinePlayers.list(scope).some((player) => player.userId === targetUserId);
  if (!targetOnline) {
    res.status(409).json({ error: "Target account is not online in the current map" });
    return;
  }

  try {
    ensureAccountInventoryMigrated(userId);
    ensureAccountInventoryMigrated(targetUserId);
    const requestedEntry = inventoryStore.getInventoryEntryOwner(requestedEntryId);
    if (!requestedEntry) {
      res.status(404).json({ error: "Requested inventory entry not found" });
      return;
    }
    if (requestedEntry.owner.ownerType !== "account" || requestedEntry.owner.ownerId !== targetUserId) {
      res.status(403).json({ error: "Requested inventory entry does not belong to target account" });
      return;
    }
    const offeredItem = inventoryStore.getInventoryItemByEntryId(offerEntryId);
    const requestedItem = inventoryStore.getInventoryItemByEntryId(requestedEntryId);

    const transfer = inventoryStore.requestInventoryTransfer({
      entryId: offerEntryId,
      fromOwner: accountOwner(userId),
      toOwner: accountOwner(targetUserId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      kind: "trade",
      metadata: {
        requestedEntryId,
        requestedItemInstanceId: requestedEntry.itemInstanceId,
        requestedItemName: requestedItem?.name ?? "",
        offeredItemName: offeredItem?.name ?? "",
        fromUserCharacterId: userCharacterId,
        fromCharacterName: character.name,
      },
    });
    appContext.eventBus.emit("item_transfer_requested", {
      scope,
      transfer,
      actor: { userId, userCharacterId },
      target: { userId: targetUserId },
    });
    res.json({ ok: true, scope, transfer });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Inventory entry does not belong to owner" ? 403 : 400;
    res.status(status).json({ error: message });
  }
});

router.post("/transfer/:transferId/respond", (req, res) => {
  const userId = getRequestUserId(req);
  const transferId = typeof req.params.transferId === "string" ? req.params.transferId : "";
  const accept = req.body?.accept === true;

  if (!transferId) {
    res.status(400).json({ error: "transferId is required" });
    return;
  }

  try {
    const transfer = inventoryStore.completeInventoryTransfer({
      transferId,
      targetOwner: accountOwner(userId),
      accept,
    });
    const scope = {
      worldId: transfer.worldId,
      timelineId: transfer.timelineId,
      mapId: transfer.mapId,
    };
    appContext.eventBus.emit(accept ? "item_transfer_completed" : "item_transfer_cancelled", {
      scope,
      transfer,
      actor: { userId },
    });
    res.json({ ok: true, scope, transfer });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "Transfer does not belong to target owner" ? 403 : 400).json({ error: message });
  }
});

router.post("/transfer/:transferId/cancel", (req, res) => {
  const userId = getRequestUserId(req);
  const transferId = typeof req.params.transferId === "string" ? req.params.transferId : "";

  if (!transferId) {
    res.status(400).json({ error: "transferId is required" });
    return;
  }

  try {
    const transfer = inventoryStore.cancelInventoryTransfer({
      transferId,
      requesterOwner: accountOwner(userId),
    });
    const scope = {
      worldId: transfer.worldId,
      timelineId: transfer.timelineId,
      mapId: transfer.mapId,
    };
    appContext.eventBus.emit("item_transfer_cancelled", {
      scope,
      transfer,
      actor: { userId },
    });
    res.json({ ok: true, scope, transfer });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "Transfer does not belong to requester owner" ? 403 : 400).json({ error: message });
  }
});

router.post("/place", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  const rotation = Number.isFinite(Number(req.body?.rotation)) ? Number(req.body.rotation) : 0;
  const footprintTiles = normalizeFootprint(req.body?.footprintTiles);
  const visualScale = normalizeVisualScale(req.body?.visualScale);

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!entryId) {
    res.status(400).json({ error: "entryId is required" });
    return;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    res.status(400).json({ error: "x and y must be finite numbers" });
    return;
  }

  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const scope = getCharacterScope(userCharacterId);
  const world = findWorldById(scope.worldId);
  if (!world) {
    res.status(404).json({ error: "World not found for character presence", scope });
    return;
  }
  if (!canUserBuildWorld(world, userId)) {
    res.status(403).json({ error: "You need builder permission to place items in this world" });
    return;
  }
  const placementValidation = appContext.mapPackageLoader.validatePlacementFootprint(
    world.dir,
    scope.mapId,
    x,
    y,
    footprintTiles,
  );
  if (!placementValidation.ok) {
    res.status(400).json({
      error: "Placement is not on walkable tiles",
      validation: placementValidation,
    });
    return;
  }

  let worldDb: Database.Database | null = null;
  try {
    worldDb = openWorldDbForScope(scope);
    const entry = inventoryStore.getInventoryItemByEntryId(entryId);
    if (!entry) {
      res.status(404).json({ error: "Inventory entry not found" });
      return;
    }
    const blocksMovement = entry.metadata?.blocksMovement !== false;
    const overlap = findPlacementOverlap(
      {
        tileX: placementValidation.tileX,
        tileY: placementValidation.tileY,
        footprintTiles,
      },
      inventoryStore.getMapItemPlacements(scope, worldDb),
    );
    if (overlap) {
      res.status(409).json({
        error: "Placement overlaps an existing item",
        overlap,
        validation: placementValidation,
      });
      return;
    }
    ensureAccountInventoryMigrated(userId);
    const placement = inventoryStore.placeInventoryEntry({
      entryId,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      x,
      y,
      rotation,
      metadata: {
        footprintTiles,
        visualScale,
        tileX: placementValidation.tileX,
        tileY: placementValidation.tileY,
        blocksMovement,
        assetKind: entry.metadata?.assetKind ?? null,
        assetPath: entry.metadata?.assetPath ?? null,
        assetUrl: entry.metadata?.assetUrl ?? null,
        assetKey: entry.metadata?.assetKey ?? null,
      },
      worldDb,
    });
    appContext.eventBus.emit("map_item_placed", {
      scope,
      placement,
      actor: { userId, userCharacterId },
    });
    recordTutorialTaskEvent(userId, "place_item");
    res.json({ ok: true, scope, placement, validation: placementValidation });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    worldDb?.close();
  }
});

function getCharacterScope(userCharacterId: string): { worldId: string; timelineId: string; mapId: string } {
  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  return {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
  };
}

function handleInventoryLifecycle(req: Request, res: Response, kind: "drop" | "use"): void {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";

  if (!userCharacterId) {
    res.status(400).json({ error: "userCharacterId is required" });
    return;
  }
  if (!entryId) {
    res.status(400).json({ error: "entryId is required" });
    return;
  }
  const character = appContext.playerManager.getPlayer(userCharacterId, userId);
  if (!character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const scope = getCharacterScope(userCharacterId);
  try {
    ensureAccountInventoryMigrated(userId);
    const result = inventoryStore.removeInventoryEntryForLifecycle({
      entryId,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      kind,
      metadata: {
        userCharacterId,
        characterName: character.name,
      },
    });
    appContext.eventBus.emit(kind === "use" ? "item_used" : "item_dropped", {
      scope,
      kind,
      item: result.item,
      actor: { userId, userCharacterId },
    });
    res.json({ ok: true, scope, kind, item: result.item });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message === "Inventory entry does not belong to owner" ? 403 : 400;
    res.status(status).json({ error: message });
  }
}

function resolvePlacementScope(
  userId: string,
  userCharacterId: string,
  mapId: string,
): { ok: true; scope: { worldId: string; timelineId: string; mapId: string } } | { ok: false; status: number; error: string } {
  if (userCharacterId) {
    const character = appContext.playerManager.getPlayer(userCharacterId, userId);
    if (!character) return { ok: false, status: 404, error: "User character not found" };
    const scope = getCharacterScope(userCharacterId);
    return {
      ok: true,
      scope: {
        ...scope,
        mapId: mapId || scope.mapId,
      },
    };
  }
  return { ok: false, status: 400, error: "userCharacterId is required" };
}

function normalizeFootprint(raw: unknown): { width: number; height: number } {
  if (!raw || typeof raw !== "object") return { width: 1, height: 1 };
  const value = raw as Record<string, unknown>;
  const width = Math.max(1, Math.min(16, Math.floor(Number(value.width) || 1)));
  const height = Math.max(1, Math.min(16, Math.floor(Number(value.height) || 1)));
  return { width, height };
}

function normalizeVisualScale(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.5, Math.min(3, Math.round(value * 10) / 10));
}

function findPlacementOverlap(
  candidate: { tileX: number; tileY: number; footprintTiles: { width: number; height: number } },
  placements: inventoryStore.MapItemPlacementView[],
): { placementId: string; tile: { gx: number; gy: number } } | null {
  const occupied = new Map<string, string>();
  for (const placement of placements) {
    for (const tile of getPlacementTiles(
      Number(placement.metadata?.tileX ?? 0),
      Number(placement.metadata?.tileY ?? 0),
      normalizeFootprint(placement.metadata?.footprintTiles),
    )) {
      occupied.set(tileKey(tile.gx, tile.gy), placement.id);
    }
  }

  for (const tile of getPlacementTiles(candidate.tileX, candidate.tileY, candidate.footprintTiles)) {
    const placementId = occupied.get(tileKey(tile.gx, tile.gy));
    if (placementId) {
      return { placementId, tile };
    }
  }
  return null;
}

function getPlacementTiles(
  tileX: number,
  tileY: number,
  footprintTiles: { width: number; height: number },
): Array<{ gx: number; gy: number }> {
  const width = Math.max(1, Math.min(16, Math.floor(footprintTiles.width || 1)));
  const height = Math.max(1, Math.min(16, Math.floor(footprintTiles.height || 1)));
  const startX = tileX - Math.floor((width - 1) / 2);
  const startY = tileY - Math.floor((height - 1) / 2);
  const tiles: Array<{ gx: number; gy: number }> = [];
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      tiles.push({ gx: startX + dx, gy: startY + dy });
    }
  }
  return tiles;
}

function tileKey(gx: number, gy: number): string {
  return `${gx},${gy}`;
}

export default router;
