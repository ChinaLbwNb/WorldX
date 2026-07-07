import fs from "node:fs";
import path from "node:path";

function exists(file) {
  return fs.existsSync(file);
}

function readJson(file, issues, label) {
  if (!exists(file)) {
    issues.push(`${label} missing: ${file}`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    issues.push(`${label} invalid JSON: ${error.message}`);
    return null;
  }
}

function listJsonFiles(dir) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(dir, name));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function clampGrid(value, max) {
  return Math.max(0, Math.min(max - 1, value));
}

function pointToTile(point, tileWidth, tileHeight, width, height) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return {
    x: clampGrid(Math.floor(point.x / tileWidth), width),
    y: clampGrid(Math.floor(point.y / tileHeight), height),
  };
}

function isWalkable(collision, width, height, x, y) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  return collision[y * width + x] === 0;
}

function findNearestWalkable(collision, width, height, start) {
  if (!start) return null;
  const limit = Math.max(width, height);
  for (let radius = 0; radius <= limit; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
        const x = start.x + dx;
        const y = start.y + dy;
        if (isWalkable(collision, width, height, x, y)) return { x, y };
      }
    }
  }
  return null;
}

function reachableTiles(collision, width, height, start) {
  const seed = findNearestWalkable(collision, width, height, start);
  if (!seed) return new Set();
  const seen = new Set([`${seed.x},${seed.y}`]);
  const queue = [seed];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = current.x + dx;
      const y = current.y + dy;
      const key = `${x},${y}`;
      if (seen.has(key) || !isWalkable(collision, width, height, x, y)) continue;
      seen.add(key);
      queue.push({ x, y });
    }
  }
  return seen;
}

function objectReachable(object, reachable, tileWidth, tileHeight, width, height) {
  const left = clampGrid(Math.floor((object.x || 0) / tileWidth), width);
  const top = clampGrid(Math.floor((object.y || 0) / tileHeight), height);
  const rightPx = (object.x || 0) + Math.max(object.width || 0, tileWidth);
  const bottomPx = (object.y || 0) + Math.max(object.height || 0, tileHeight);
  const right = clampGrid(Math.floor((rightPx - 1) / tileWidth), width);
  const bottom = clampGrid(Math.floor((bottomPx - 1) / tileHeight), height);

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      if (reachable.has(`${x},${y}`)) return true;
    }
  }
  return false;
}

function validateTmj(tmj, issues) {
  if (!tmj) return null;
  const width = Number(tmj.width);
  const height = Number(tmj.height);
  const tileWidth = Number(tmj.tilewidth);
  const tileHeight = Number(tmj.tileheight || tmj.tilewidth);
  if (![width, height, tileWidth, tileHeight].every((value) => Number.isFinite(value) && value > 0)) {
    issues.push("TMJ dimensions are invalid");
    return null;
  }
  const collisionLayer = tmj.layers?.find((layer) => layer.name === "collision");
  const collision = collisionLayer?.data;
  if (!Array.isArray(collision) || collision.length !== width * height) {
    issues.push("TMJ collision layer is missing or has invalid length");
    return null;
  }
  return { width, height, tileWidth, tileHeight, collision };
}

export function validateWorld(worldDir) {
  const resolvedWorldDir = path.resolve(worldDir);
  const issues = [];
  const warnings = [];

  const worldDesign = readJson(path.join(resolvedWorldDir, "world-design.json"), issues, "world design");
  const tmj = readJson(path.join(resolvedWorldDir, "map", "06-final.tmj"), issues, "final TMJ");
  const worldConfig = readJson(path.join(resolvedWorldDir, "config", "world.json"), issues, "world config");
  const sceneConfig = readJson(path.join(resolvedWorldDir, "config", "scene.json"), issues, "scene config");

  const characterConfigFiles = listJsonFiles(path.join(resolvedWorldDir, "config", "characters"));
  const characterConfigs = characterConfigFiles.flatMap((file) => {
    try {
      return [JSON.parse(fs.readFileSync(file, "utf-8"))];
    } catch (error) {
      issues.push(`character config invalid JSON: ${file}: ${error.message}`);
      return [];
    }
  });

  const backgroundExists = exists(path.join(resolvedWorldDir, "map", "06-background.png"));
  if (!backgroundExists) issues.push("map background missing");

  const tmjInfo = validateTmj(tmj, issues);
  const regions = tmj?.layers?.find((layer) => layer.name === "regions")?.objects || [];
  const elements = tmj?.layers?.find((layer) => layer.name === "interactive_objects")?.objects || [];
  const mainAreaPoints = Array.isArray(worldConfig?.mainAreaPoints) ? worldConfig.mainAreaPoints : [];
  const locations = Array.isArray(worldConfig?.locations) ? worldConfig.locations : [];

  let spatial = {
    walkableRatio: null,
    reachableWalkableRatio: null,
    reachableRegionRatio: null,
    reachableElementRatio: null,
    spawnValid: false,
    regionCount: regions.length,
    elementCount: elements.length,
  };

  if (tmjInfo) {
    const { width, height, tileWidth, tileHeight, collision } = tmjInfo;
    const walkableCount = collision.filter((tile) => tile === 0).length;
    const spawnPoint = mainAreaPoints[0] || null;
    const spawnTile = pointToTile(spawnPoint, tileWidth, tileHeight, width, height);
    const nearestSpawn = findNearestWalkable(collision, width, height, spawnTile);
    const reachable = reachableTiles(collision, width, height, spawnTile);
    const reachableRegionCount = regions.filter((region) =>
      objectReachable(region, reachable, tileWidth, tileHeight, width, height)).length;
    const reachableElementCount = elements.filter((element) =>
      objectReachable(element, reachable, tileWidth, tileHeight, width, height)).length;

    spatial = {
      walkableRatio: ratio(walkableCount, collision.length),
      reachableWalkableRatio: ratio(reachable.size, walkableCount),
      reachableRegionRatio: ratio(reachableRegionCount, regions.length),
      reachableElementRatio: ratio(reachableElementCount, elements.length),
      spawnValid: Boolean(nearestSpawn),
      regionCount: regions.length,
      elementCount: elements.length,
    };

    if (!nearestSpawn) issues.push("no walkable spawn can be resolved");
  }

  if (!worldDesign?.worldName || !worldDesign?.mapDescription) issues.push("world design is incomplete");
  if (locations.length === 0) issues.push("runtime world has no locations");
  if (mainAreaPoints.length === 0) issues.push("runtime world has no mainAreaPoints");
  if (!sceneConfig?.sceneType) warnings.push("scene config has no sceneType");
  if (characterConfigs.length === 0) warnings.push("no generated character configs");

  const stage = {
    worldDesign: Boolean(worldDesign?.worldName && worldDesign?.mapDescription),
    map: Boolean(tmjInfo && backgroundExists),
    characters: characterConfigs.length > 0,
    grounding: Boolean(tmjInfo && mainAreaPoints.length > 0 && spatial.spawnValid),
    config: Boolean(worldConfig && sceneConfig && locations.length > 0),
  };
  stage.runtimeReady = stage.map && stage.grounding && stage.config;

  return {
    worldDir: resolvedWorldDir,
    valid: issues.length === 0,
    e2eExecutable: stage.worldDesign && stage.map && stage.characters && stage.grounding && stage.config,
    stage,
    counts: {
      plannedCharacters: Array.isArray(worldDesign?.characters) ? worldDesign.characters.length : 0,
      generatedCharacterConfigs: characterConfigs.length,
      plannedRegions: Array.isArray(worldDesign?.regions) ? worldDesign.regions.length : 0,
      groundedRegions: regions.length,
      plannedElements: Array.isArray(worldDesign?.interactiveElements) ? worldDesign.interactiveElements.length : 0,
      groundedElements: elements.length,
      runtimeLocations: locations.length,
      mainAreaPoints: mainAreaPoints.length,
    },
    retention: {
      characterConfigRatio: ratio(characterConfigs.length, Array.isArray(worldDesign?.characters) ? worldDesign.characters.length : 0),
      regionRatio: ratio(regions.length, Array.isArray(worldDesign?.regions) ? worldDesign.regions.length : 0),
      elementRatio: ratio(elements.length, Array.isArray(worldDesign?.interactiveElements) ? worldDesign.interactiveElements.length : 0),
    },
    spatial,
    issues,
    warnings,
  };
}
