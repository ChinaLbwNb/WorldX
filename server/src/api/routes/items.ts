import { Router } from "express";
import { appContext } from "../../services/app-context.js";
import { getRequestUserId } from "../request-user.js";
import * as inventoryStore from "../../store/inventory-store.js";
import { removeAccountAssetPath } from "../../utils/account-assets.js";

const router = Router();

function accountOwner(userId: string) {
  return { ownerType: "account" as const, ownerId: userId };
}

function ensureAccountInventoryMigrated(userId: string): void {
  inventoryStore.migrateUserCharacterInventoryToAccount(userId);
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

  const character = userCharacterId ? appContext.playerManager.getPlayer(userCharacterId, userId) : null;
  if (userCharacterId && !character) {
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
  const presence = userCharacterId
    ? appContext.playerManager.getPlayerPresence(userCharacterId)
    : appContext.getCurrentPresenceScope(appContext.worldManager.getActiveMapId());
  const scope = {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: "currentMapId" in presence ? presence.currentMapId : presence.mapId,
  };

  try {
    const result = await appContext.itemGenerator.generateForInventory({
      prompt,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
      worldDescription: appContext.worldManager.getWorldDescription(),
    });
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

router.get("/placements", (req, res) => {
  const mapId = typeof req.query.mapId === "string"
    ? req.query.mapId
    : appContext.worldManager.getActiveMapId();
  const scope = appContext.getCurrentPresenceScope(mapId);
  res.json({
    scope,
    placements: inventoryStore.getMapItemPlacements(scope),
  });
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

  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  if (presence.currentMapId !== appContext.worldManager.getActiveMapId()) {
    res.status(409).json({
      error: "Character map runtime is not loaded yet. Enter that map before picking up items.",
      currentMapId: appContext.worldManager.getActiveMapId(),
      characterMapId: presence.currentMapId,
    });
    return;
  }

  const scope = {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: presence.currentMapId,
  };

  try {
    const result = inventoryStore.pickupMapItemPlacement({
      placementId,
      owner: accountOwner(userId),
      worldId: scope.worldId,
      timelineId: scope.timelineId,
      mapId: scope.mapId,
    });
    res.json({ ok: true, scope, item: result.item, placement: result.placement });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(message === "Placement does not belong to owner" ? 403 : 400).json({ error: message });
  }
});

router.post("/delete", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";

  if (!entryId) {
    res.status(400).json({ error: "entryId is required" });
    return;
  }

  const character = userCharacterId ? appContext.playerManager.getPlayer(userCharacterId, userId) : null;
  if (userCharacterId && !character) {
    res.status(404).json({ error: "User character not found" });
    return;
  }

  const presence = userCharacterId
    ? appContext.playerManager.getPlayerPresence(userCharacterId)
    : appContext.getCurrentPresenceScope(appContext.worldManager.getActiveMapId());
  const scope = {
    worldId: presence.worldId,
    timelineId: presence.timelineId,
    mapId: "currentMapId" in presence ? presence.currentMapId : presence.mapId,
  };

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

router.post("/place", (req, res) => {
  const userId = getRequestUserId(req);
  const userCharacterId = typeof req.body?.userCharacterId === "string" ? req.body.userCharacterId : "";
  const entryId = typeof req.body?.entryId === "string" ? req.body.entryId : "";
  const x = Number(req.body?.x);
  const y = Number(req.body?.y);
  const rotation = Number.isFinite(Number(req.body?.rotation)) ? Number(req.body.rotation) : 0;
  const footprintTiles = normalizeFootprint(req.body?.footprintTiles);

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

  const presence = appContext.playerManager.getPlayerPresence(userCharacterId);
  if (presence.currentMapId !== appContext.worldManager.getActiveMapId()) {
    res.status(409).json({
      error: "Character map runtime is not loaded yet. Enter that map before placing items.",
      currentMapId: appContext.worldManager.getActiveMapId(),
      characterMapId: presence.currentMapId,
    });
    return;
  }

  const placementValidation = appContext.worldManager.validatePlacementFootprint(x, y, footprintTiles);
  if (!placementValidation.ok) {
    res.status(400).json({
      error: "Placement is not on walkable tiles",
      validation: placementValidation,
    });
    return;
  }

  try {
    const entry = inventoryStore.getInventoryItemByEntryId(entryId);
    if (!entry) {
      res.status(404).json({ error: "Inventory entry not found" });
      return;
    }
    const scope = {
      worldId: presence.worldId,
      timelineId: presence.timelineId,
      mapId: presence.currentMapId,
    };
    const blocksMovement = entry.metadata?.blocksMovement !== false;
    const overlap = findPlacementOverlap(
      {
        tileX: placementValidation.tileX,
        tileY: placementValidation.tileY,
        footprintTiles,
      },
      inventoryStore.getMapItemPlacements(scope),
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
        tileX: placementValidation.tileX,
        tileY: placementValidation.tileY,
        blocksMovement,
        assetKind: entry.metadata?.assetKind ?? null,
        assetPath: entry.metadata?.assetPath ?? null,
        assetUrl: entry.metadata?.assetUrl ?? null,
        assetKey: entry.metadata?.assetKey ?? null,
      },
    });
    res.json({ ok: true, scope, placement, validation: placementValidation });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

function normalizeFootprint(raw: unknown): { width: number; height: number } {
  if (!raw || typeof raw !== "object") return { width: 1, height: 1 };
  const value = raw as Record<string, unknown>;
  const width = Math.max(1, Math.min(16, Math.floor(Number(value.width) || 1)));
  const height = Math.max(1, Math.min(16, Math.floor(Number(value.height) || 1)));
  return { width, height };
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
