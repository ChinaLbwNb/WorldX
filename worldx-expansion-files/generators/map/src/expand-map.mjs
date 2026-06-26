/**
 * Map expansion script — full pipeline version.
 *
 * Follows the same production pipeline as initial map generation:
 *   Step 1: LLM designs new regions/elements for the expansion area
 *   Step 2: Generate expansion image via image-to-image (outpainting) with multimodal review
 *   Step 3: Compress new region
 *   Step 4: Annotate regions, elements, and walkable areas (parallel) + multimodal review
 *   Step 5: Compute walkable grid for new region
 *   Step 6: Stitch images, merge grids/TMJ, save results
 *
 * Key guarantees:
 *   - New region is EXACTLY the same dimensions as original map (perfect tile alignment)
 *   - Boundary continuity is enforced via prompt engineering + seam blending
 *   - Full multimodal validation at image gen and annotation stages
 *
 * Usage:
 *   node expand-map.mjs --worldDir <path> --direction <north|south|east|west>
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

import { editImage } from "./models/gemini-flash-img.mjs";
import { geminiProVisionJSON } from "./models/gemini-pro.mjs";
import { chatJSON } from "./models/llm-client.mjs";
import { compressMap } from "./steps/step2-compress.mjs";
import { resolveDesignedRegions, scaleRegions } from "./steps/step3-resolve-designed-regions.mjs";
import { locateElements, scaleElements } from "./steps/step3.2-locate-elements.mjs";
import { generateWalkableMap } from "./steps/step4-walkable-areas.mjs";
import { computeGrid } from "./steps/step5-compute-grid.mjs";
import { loadPrompt } from "./utils/prompt-loader.mjs";
import { getImageSize, resizeImage } from "./utils/image-utils.mjs";
import { getMapImageSizeLabel } from "./utils/generation-config.mjs";
import {
  formatElementSummary,
  formatRegionSummary,
} from "./utils/world-design-summary.mjs";
import { normalizeWorldDesign } from "../../../orchestrator/src/world-design-utils.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORLD_SEED_ROOT = path.resolve(__dirname, "../../..");
dotenv.config({ path: path.join(WORLD_SEED_ROOT, ".env") });

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--") && i + 1 < argv.length) {
      args[key.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const worldDir = args.worldDir;
const direction = args.direction;

if (!worldDir || !direction) {
  console.error("Usage: node expand-map.mjs --worldDir <path> --direction <north|south|east|west>");
  process.exit(1);
}

const validDirections = ["north", "south", "east", "west"];
if (!validDirections.includes(direction)) {
  console.error(`Invalid direction: ${direction}. Must be one of: ${validDirections.join(", ")}`);
  process.exit(1);
}

const mapDir = path.join(worldDir, "map");
const backgroundPath = path.join(mapDir, "06-background.png");
const tmjPath = path.join(mapDir, "06-final.tmj");
const worldDesignPath = path.join(worldDir, "world-design.json");

// ─── Helpers ────────────────────────────────────────────────────────────────

function logStep(stepNum, message) {
  console.log(`[Step ${stepNum}] ${message}`);
}

function readWorldDesign() {
  if (!fs.existsSync(worldDesignPath)) return null;
  try {
    return normalizeWorldDesign(JSON.parse(fs.readFileSync(worldDesignPath, "utf-8")));
  } catch {
    return null;
  }
}

function readTMJ() {
  return JSON.parse(fs.readFileSync(tmjPath, "utf-8"));
}

function writeTMJ(tmj) {
  fs.writeFileSync(tmjPath, JSON.stringify(tmj, null, 2));
}

function getDirectionText(dir) {
  return { north: "北边（上方）", south: "南边（下方）", east: "东边（右侧）", west: "西边（左侧）" }[dir];
}

/**
 * Extract edge strip from old map for boundary context.
 */
async function extractEdgeStrip(oldBuffer, oldWidth, oldHeight, dir, stripSize) {
  let extractRegion;
  switch (dir) {
    case "east": // right edge strip
      extractRegion = { left: oldWidth - stripSize, top: 0, width: stripSize, height: oldHeight };
      break;
    case "west": // left edge strip
      extractRegion = { left: 0, top: 0, width: stripSize, height: oldHeight };
      break;
    case "south": // bottom edge strip
      extractRegion = { left: 0, top: oldHeight - stripSize, width: oldWidth, height: stripSize };
      break;
    case "north": // top edge strip
      extractRegion = { left: 0, top: 0, width: oldWidth, height: stripSize };
      break;
  }
  return sharp(oldBuffer).extract(extractRegion).png().toBuffer();
}

/**
 * Build a seed canvas for outpainting:
 * - Places the edge strip on the correct side
 * - Fills remaining area with stretched/blurred continuation of the edge
 *
 * For east expansion: edge strip (right edge of old map) is placed on LEFT of canvas,
 *   fill on RIGHT. The boundary between strip and fill is at strip's right edge.
 *   We slice the RIGHT edge of the strip to extend rightward.
 * For west expansion: edge strip (left edge of old map) is placed on RIGHT of canvas,
 *   fill on LEFT. Boundary is at strip's left edge. Slice LEFT edge of strip to extend leftward.
 * For south: edge strip (bottom edge) on TOP, fill on BOTTOM. Slice BOTTOM edge to extend down.
 * For north: edge strip (top edge) on BOTTOM, fill on TOP. Slice TOP edge to extend up.
 */
async function buildSeedCanvas(edgeStripBuffer, oldWidth, oldHeight, dir, stripSize) {
  // Create a blank canvas of the same size as original map
  const canvas = sharp({
    create: {
      width: oldWidth,
      height: oldHeight,
      channels: 4,
      background: { r: 128, g: 128, b: 128, alpha: 1 },
    },
  });

  const isHorizontal = dir === "east" || dir === "west";
  const fillSize = isHorizontal ? oldWidth - stripSize : oldHeight - stripSize;

  let fillBuffer;
  if (isHorizontal) {
    // Horizontal expansion (east/west)
    const sliceWidth = Math.min(8, Math.floor(stripSize / 4));
    // For east: slice RIGHT edge of strip (extends rightward to fill)
    // For west: slice LEFT edge of strip (extends leftward to fill)
    const sliceLeft = dir === "east" ? stripSize - sliceWidth : 0;
    const sliceRegion = { left: sliceLeft, top: 0, width: sliceWidth, height: oldHeight };
    const sliceBuffer = await sharp(edgeStripBuffer).extract(sliceRegion).png().toBuffer();
    fillBuffer = await sharp(sliceBuffer)
      .resize(fillSize, oldHeight, { fit: "fill" })
      .blur(3)
      .png()
      .toBuffer();
  } else {
    // Vertical expansion (south/north)
    const sliceHeight = Math.min(8, Math.floor(stripSize / 4));
    // For south: slice BOTTOM edge of strip (extends downward to fill)
    // For north: slice TOP edge of strip (extends upward to fill)
    const sliceTop = dir === "south" ? stripSize - sliceHeight : 0;
    const sliceRegion = { left: 0, top: sliceTop, width: oldWidth, height: sliceHeight };
    const sliceBuffer = await sharp(edgeStripBuffer).extract(sliceRegion).png().toBuffer();
    fillBuffer = await sharp(sliceBuffer)
      .resize(oldWidth, fillSize, { fit: "fill" })
      .blur(3)
      .png()
      .toBuffer();
  }

  // Composite: place edge strip and fill in correct positions
  const composites = [];

  switch (dir) {
    case "east":
      // Edge strip on left, fill on right
      composites.push({ input: edgeStripBuffer, left: 0, top: 0 });
      composites.push({ input: fillBuffer, left: stripSize, top: 0 });
      break;
    case "west":
      // Fill on left, edge strip on right
      composites.push({ input: fillBuffer, left: 0, top: 0 });
      composites.push({ input: edgeStripBuffer, left: fillSize, top: 0 });
      break;
    case "south":
      // Edge strip on top, fill on bottom
      composites.push({ input: edgeStripBuffer, left: 0, top: 0 });
      composites.push({ input: fillBuffer, left: 0, top: stripSize });
      break;
    case "north":
      // Fill on top, edge strip on bottom
      composites.push({ input: fillBuffer, left: 0, top: 0 });
      composites.push({ input: edgeStripBuffer, left: 0, top: fillSize });
      break;
  }

  return canvas.composite(composites).png().toBuffer();
}

/**
 * Blend the seam between old map and new region to hide any discontinuity.
 * Creates a gradient blend over BLEND_WIDTH pixels.
 */
async function blendSeam(oldBuffer, newRegionBuffer, oldWidth, oldHeight, dir, tileSize) {
  const BLEND_WIDTH = Math.max(tileSize, Math.round((dir === "east" || dir === "west" ? oldWidth : oldHeight) * 0.03));
  const isHorizontal = dir === "east" || dir === "west";
  const seamSize = isHorizontal ? oldHeight : oldWidth;

  // Extract the seam zone from both images
  let oldSeamRegion, newSeamRegion;
  switch (dir) {
    case "east":
      oldSeamRegion = { left: oldWidth - BLEND_WIDTH, top: 0, width: BLEND_WIDTH, height: oldHeight };
      newSeamRegion = { left: 0, top: 0, width: BLEND_WIDTH, height: oldHeight };
      break;
    case "west":
      oldSeamRegion = { left: 0, top: 0, width: BLEND_WIDTH, height: oldHeight };
      newSeamRegion = { left: oldWidth - BLEND_WIDTH, top: 0, width: BLEND_WIDTH, height: oldHeight };
      break;
    case "south":
      oldSeamRegion = { left: 0, top: oldHeight - BLEND_WIDTH, width: oldWidth, height: BLEND_WIDTH };
      newSeamRegion = { left: 0, top: 0, width: oldWidth, height: BLEND_WIDTH };
      break;
    case "north":
      oldSeamRegion = { left: 0, top: 0, width: oldWidth, height: BLEND_WIDTH };
      newSeamRegion = { left: 0, top: oldHeight - BLEND_WIDTH, width: oldWidth, height: BLEND_WIDTH };
      break;
  }

  const oldSeam = await sharp(oldBuffer).extract(oldSeamRegion).raw().toBuffer();
  const newSeam = await sharp(newRegionBuffer).extract(newSeamRegion).raw().toBuffer();

  // Create gradient blend mask
  const channels = 4;
  const blendedSeam = Buffer.alloc(oldSeam.length);
  const totalPixels = isHorizontal ? BLEND_WIDTH * oldHeight : oldWidth * BLEND_WIDTH;

  for (let i = 0; i < totalPixels; i++) {
    // Determine position along the blend axis
    let t;
    if (isHorizontal) {
      const x = i % BLEND_WIDTH;
      t = dir === "east" ? x / (BLEND_WIDTH - 1) : 1 - x / (BLEND_WIDTH - 1);
    } else {
      const y = Math.floor(i / oldWidth);
      t = dir === "south" ? y / (BLEND_WIDTH - 1) : 1 - y / (BLEND_WIDTH - 1);
    }
    // Smoothstep for nicer blending
    t = t * t * (3 - 2 * t);

    for (let c = 0; c < channels; c++) {
      const idx = i * channels + c;
      blendedSeam[idx] = Math.round(oldSeam[idx] * (1 - t) + newSeam[idx] * t);
    }
  }

  // Create blended seam image
  const blendWidth = isHorizontal ? BLEND_WIDTH : oldWidth;
  const blendHeight = isHorizontal ? oldHeight : BLEND_WIDTH;
  const blendedSeamImg = await sharp(blendedSeam, {
    raw: { width: blendWidth, height: blendHeight, channels },
  }).png().toBuffer();

  // Apply blended seam to new region
  let seamLeft = 0, seamTop = 0;
  switch (dir) {
    case "east": seamLeft = 0; seamTop = 0; break;
    case "west": seamLeft = oldWidth - BLEND_WIDTH; seamTop = 0; break;
    case "south": seamLeft = 0; seamTop = 0; break;
    case "north": seamLeft = 0; seamTop = oldHeight - BLEND_WIDTH; break;
  }

  return sharp(newRegionBuffer)
    .composite([{ input: blendedSeamImg, left: seamLeft, top: seamTop }])
    .png()
    .toBuffer();
}

/**
 * Stitch old map and new region together with exact pixel alignment.
 */
async function stitchMaps(oldBuffer, newRegionBuffer, oldWidth, oldHeight, dir) {
  // Get actual dimensions of both buffers
  const oldMeta = await sharp(oldBuffer).metadata();
  const newMeta = await sharp(newRegionBuffer).metadata();
  const oldW = oldMeta.width;
  const oldH = oldMeta.height;
  const newW = newMeta.width;
  const newH = newMeta.height;

  let finalWidth, finalHeight;
  let oldLeft = 0, oldTop = 0;
  let newLeft = 0, newTop = 0;

  switch (dir) {
    case "east":
      finalWidth = oldW + newW;
      finalHeight = Math.max(oldH, newH);
      newLeft = oldW;
      break;
    case "west":
      finalWidth = oldW + newW;
      finalHeight = Math.max(oldH, newH);
      oldLeft = newW;
      break;
    case "south":
      finalWidth = Math.max(oldW, newW);
      finalHeight = oldH + newH;
      newTop = oldH;
      break;
    case "north":
      finalWidth = Math.max(oldW, newW);
      finalHeight = oldH + newH;
      oldTop = newH;
      break;
  }

  return sharp({
    create: {
      width: finalWidth,
      height: finalHeight,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 255 },
    },
  })
    .composite([
      { input: oldBuffer, left: oldLeft, top: oldTop },
      { input: newRegionBuffer, left: newLeft, top: newTop },
    ])
    .png()
    .toBuffer();
}

/**
 * Merge two collision grids.
 */
function mergeGrids(oldGrid, newGrid, dir) {
  const oldH = oldGrid.length;
  const oldW = oldGrid[0].length;
  const newH = newGrid.length;
  const newW = newGrid[0].length;

  let mergedW, mergedH;
  switch (dir) {
    case "east":
    case "west":
      mergedW = oldW + newW;
      mergedH = Math.max(oldH, newH);
      break;
    case "south":
    case "north":
      mergedW = Math.max(oldW, newW);
      mergedH = oldH + newH;
      break;
  }

  const merged = Array.from({ length: mergedH }, () => new Array(mergedW).fill(1));

  const placeGrid = (grid, offsetX, offsetY) => {
    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const my = y + offsetY;
        const mx = x + offsetX;
        if (my >= 0 && my < mergedH && mx >= 0 && mx < mergedW) {
          merged[my][mx] = grid[y][x];
        }
      }
    }
  };

  // Place old grid
  const oldOffX = dir === "west" ? newW : 0;
  const oldOffY = dir === "north" ? newH : 0;
  placeGrid(oldGrid, oldOffX, oldOffY);

  // Place new grid
  const newOffX = dir === "east" ? oldW : 0;
  const newOffY = dir === "south" ? oldH : 0;
  placeGrid(newGrid, newOffX, newOffY);

  return { grid: merged, width: mergedW, height: mergedH };
}

/**
 * Build a combined TMJ from old TMJ + new region data.
 */
function buildCombinedTMJ(oldTMJ, newRegionData, dir, tileSize, oldBgWidth, oldBgHeight, newBgWidth, newBgHeight) {
  const { newGrid, newRegions, newElements } = newRegionData;
  const oldGridData = oldTMJ.layers.find((l) => l.name === "collision")?.data || [];
  const oldRegions = oldTMJ.layers.find((l) => l.name === "regions")?.objects || [];
  const oldElements = oldTMJ.layers.find((l) => l.name === "interactive_objects")?.objects || [];

  // Reconstruct old grid
  const oldGridW = oldTMJ.width;
  const oldGridH = oldTMJ.height;
  const oldGrid = [];
  for (let y = 0; y < oldGridH; y++) {
    const row = [];
    for (let x = 0; x < oldGridW; x++) {
      row.push(oldGridData[y * oldGridW + x] ?? 1);
    }
    oldGrid.push(row);
  }

  // Merge grids
  const { grid: mergedGrid, width: mergedW, height: mergedH } = mergeGrids(oldGrid, newGrid, dir);

  // Calculate pixel coordinate offsets based on ACTUAL image dimensions
  // (not just oldWidth/oldHeight, to handle any size mismatches robustly)
  let pixelOffsetX = 0, pixelOffsetY = 0; // offset for OLD objects
  let newPixelOffsetX = 0, newPixelOffsetY = 0; // offset for NEW objects

  switch (dir) {
    case "west":
      // New region is on the LEFT, old shifts right by newBgWidth
      pixelOffsetX = newBgWidth;
      newPixelOffsetX = 0;
      break;
    case "north":
      // New region is on TOP, old shifts down by newBgHeight
      pixelOffsetY = newBgHeight;
      newPixelOffsetY = 0;
      break;
    case "east":
      // Old stays, new region is on the RIGHT
      pixelOffsetX = 0;
      newPixelOffsetX = oldBgWidth;
      break;
    case "south":
      // Old stays, new region is on the BOTTOM
      pixelOffsetY = 0;
      newPixelOffsetY = oldBgHeight;
      break;
  }

  // Offset existing objects if expanding west/north (they shift)
  const offsetOldRegions = oldRegions.map((r) => ({
    ...r,
    x: r.x + pixelOffsetX,
    y: r.y + pixelOffsetY,
  }));
  const offsetOldElements = oldElements.map((e) => ({
    ...e,
    x: e.x + pixelOffsetX,
    y: e.y + pixelOffsetY,
  }));

  // Convert new regions to TMJ objects with offset
  let nextObjId = Math.max(
    0,
    ...[...offsetOldRegions, ...offsetOldElements].map((o) => o.id || 0),
  ) + 1;

  const newRegionObjs = newRegions.map((r) => ({
    id: nextObjId++,
    name: r.name || r.id,
    type: "",
    x: r.topLeft.x + newPixelOffsetX,
    y: r.topLeft.y + newPixelOffsetY,
    width: r.bottomRight.x - r.topLeft.x,
    height: r.bottomRight.y - r.topLeft.y,
    rotation: 0,
    visible: true,
    properties: [
      { name: "id", type: "string", value: r.id },
      { name: "description", type: "string", value: r.description || "" },
      { name: "regionType", type: "string", value: r.type || "" },
      { name: "actions", type: "string", value: JSON.stringify(r.actions || []) },
      { name: "adjacentRegions", type: "string", value: JSON.stringify(r.adjacentRegions || []) },
    ],
  }));

  const newElementObjs = newElements.map((e) => ({
    id: nextObjId++,
    name: e.name || e.id,
    type: "",
    x: e.topLeft.x + newPixelOffsetX,
    y: e.topLeft.y + newPixelOffsetY,
    width: e.bottomRight.x - e.topLeft.x,
    height: e.bottomRight.y - e.topLeft.y,
    rotation: 0,
    visible: true,
    properties: [
      { name: "objectId", type: "string", value: e.id },
      { name: "interactions", type: "string", value: JSON.stringify(e.suggestedInteractions || e.interactions || []) },
    ],
  }));

  const bgWidth = mergedW * tileSize;
  const bgHeight = mergedH * tileSize;

  // Build merged collision data
  const collisionData = [];
  for (let y = 0; y < mergedH; y++) {
    for (let x = 0; x < mergedW; x++) {
      collisionData.push(mergedGrid[y]?.[x] ?? 1);
    }
  }

  return {
    compressionlevel: -1,
    width: mergedW,
    height: mergedH,
    tilewidth: tileSize,
    tileheight: tileSize,
    infinite: false,
    orientation: "orthogonal",
    renderorder: "right-down",
    tiledversion: "1.10.2",
    type: "map",
    version: "1.10",
    layers: [
      {
        id: 1,
        name: "background",
        type: "imagelayer",
        image: "06-background.png",
        imagewidth: bgWidth,
        imageheight: bgHeight,
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: 2,
        name: "collision",
        type: "tilelayer",
        data: collisionData,
        width: mergedW,
        height: mergedH,
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
      },
      {
        id: 3,
        name: "regions",
        type: "objectgroup",
        objects: [...offsetOldRegions, ...newRegionObjs],
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        draworder: "topdown",
      },
      {
        id: 4,
        name: "interactive_objects",
        type: "objectgroup",
        objects: [...offsetOldElements, ...newElementObjs],
        opacity: 1,
        visible: true,
        x: 0,
        y: 0,
        draworder: "topdown",
      },
    ],
    nextlayerid: 5,
    nextobjectid: nextObjId,
  };
}

/**
 * Update world.json to include new regions, elements, and main area points
 * created by the expansion. This ensures the runtime WorldManager can discover
 * the new locations and objects after reload.
 */
function updateWorldJson(worldDir, finalTMJ, oldTMJ, dir, tileSize) {
  // Rebuild merged grid from finalTMJ collision layer for walkable point search
  const collisionData = finalTMJ.layers?.find((l) => l.name === "collision")?.data || [];
  const mergedGrid = [];
  for (let y = 0; y < finalTMJ.height; y++) {
    const row = [];
    for (let x = 0; x < finalTMJ.width; x++) {
      row.push(collisionData[y * finalTMJ.width + x] ?? 1);
    }
    mergedGrid.push(row);
  }
  const worldJsonPath = path.join(worldDir, "world.json");
  if (!fs.existsSync(worldJsonPath)) {
    console.warn("[expand-map] world.json not found, skipping update");
    return;
  }

  let worldConfig;
  try {
    worldConfig = JSON.parse(fs.readFileSync(worldJsonPath, "utf-8"));
  } catch (e) {
    console.warn(`[expand-map] Failed to parse world.json: ${e.message}`);
    return;
  }

  // Determine the max existing object id in old TMJ to identify new objects
  const oldMaxObjId = Math.max(
    0,
    ...[
      ...(oldTMJ.layers?.find((l) => l.name === "regions")?.objects || []),
      ...(oldTMJ.layers?.find((l) => l.name === "interactive_objects")?.objects || []),
    ].map((o) => o.id || 0),
  );

  // Find new region objects in the final TMJ (id > oldMaxObjId)
  const regionsLayer = finalTMJ.layers?.find((l) => l.name === "regions");
  const interactiveLayer = finalTMJ.layers?.find((l) => l.name === "interactive_objects");

  const newRegionObjs = (regionsLayer?.objects || []).filter((o) => (o.id || 0) > oldMaxObjId);
  const newElementObjs = (interactiveLayer?.objects || []).filter((o) => (o.id || 0) > oldMaxObjId);

  // Ensure arrays exist
  if (!worldConfig.locations) worldConfig.locations = [];
  if (!worldConfig.mainAreaPoints) worldConfig.mainAreaPoints = [];
  const existingLocationIds = new Set(worldConfig.locations.map((l) => l.id));
  const existingPointIds = new Set(worldConfig.mainAreaPoints.map((p) => p.id));

  const timestamp = Date.now();
  const newLocations = [];
  const newMainAreaPoints = [];

  // Create LocationConfig for each new region
  for (const regionObj of newRegionObjs) {
    const props = {};
    for (const p of regionObj.properties || []) {
      props[p.name] = p.value;
    }
    const regionId = props.id || `expand_${dir}_${timestamp}_loc_${regionObj.id}`;
    const locationId = `loc_${regionId.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    if (existingLocationIds.has(locationId)) continue;

    // Find walkable tile in this region for main area point
    const regionGridX = Math.floor(regionObj.x / tileSize);
    const regionGridY = Math.floor(regionObj.y / tileSize);
    const regionGridW = Math.ceil(regionObj.width / tileSize);
    const regionGridH = Math.ceil(regionObj.height / tileSize);

    let walkableGridX = -1, walkableGridY = -1;
    for (let gy = regionGridY; gy < regionGridY + regionGridH && gy < mergedGrid.length; gy++) {
      for (let gx = regionGridX; gx < regionGridX + regionGridW && gx < (mergedGrid[gy]?.length || 0); gx++) {
        if (mergedGrid[gy]?.[gx] === 0) {
          walkableGridX = gx;
          walkableGridY = gy;
          break;
        }
      }
      if (walkableGridX >= 0) break;
    }

    // Create main area point at walkable tile center (or region center if no walkable found)
    const pointX = walkableGridX >= 0
      ? (walkableGridX + 0.5) * tileSize
      : regionObj.x + regionObj.width / 2;
    const pointY = walkableGridY >= 0
      ? (walkableGridY + 0.5) * tileSize
      : regionObj.y + regionObj.height / 2;
    const pointId = `map_expand_${dir}_${regionObj.id}`;
    if (!existingPointIds.has(pointId)) {
      newMainAreaPoints.push({
        id: pointId,
        name: regionObj.name || regionId,
        x: Math.round(pointX),
        y: Math.round(pointY),
        adjacentPointIds: [], // Will be rebuilt by WorldManager.rebuildMainAreaPointAdjacencyFromTmj
      });
      existingPointIds.add(pointId);
    }

    // Parse interactions from elements that belong to this region (spatial containment)
    const regionObjects = [];
    for (const elemObj of newElementObjs) {
      const elemCx = elemObj.x + elemObj.width / 2;
      const elemCy = elemObj.y + elemObj.height / 2;
      if (elemCx >= regionObj.x && elemCx <= regionObj.x + regionObj.width &&
          elemCy >= regionObj.y && elemCy <= regionObj.y + regionObj.height) {
        const elemProps = {};
        for (const p of elemObj.properties || []) {
          elemProps[p.name] = p.value;
        }
        const elemId = elemProps.objectId || `expand_${dir}_obj_${elemObj.id}`;
        regionObjects.push({
          id: elemId,
          name: elemObj.name || elemId,
          locationId,
          defaultState: "idle",
          capacity: 1,
          interactions: [
            { id: "interact", name: "交互", availableWhenState: "idle", duration: 1 },
          ],
        });
      }
    }

    // Determine adjacent locations based on direction
    const adjacentLocations = [];
    // Connect to existing locations (the expansion connects to the old map)
    for (const oldLoc of worldConfig.locations) {
      adjacentLocations.push(oldLoc.id);
    }

    newLocations.push({
      id: locationId,
      name: regionObj.name || regionId,
      description: props.description || `扩展区域 (${dir})`,
      adjacentLocations,
      mainAreaPointId: pointId,
      objects: regionObjects,
    });
    existingLocationIds.add(locationId);
  }

  // Append new locations and main area points
  worldConfig.locations = [...(worldConfig.locations || []), ...newLocations];
  worldConfig.mainAreaPoints = [...(worldConfig.mainAreaPoints || []), ...newMainAreaPoints];

  // Update world size
  worldConfig.worldSize = {
    width: finalTMJ.width * tileSize,
    height: finalTMJ.height * tileSize,
    tileSize,
    gridWidth: finalTMJ.width,
    gridHeight: finalTMJ.height,
  };

  // Write back
  try {
    fs.writeFileSync(worldJsonPath, JSON.stringify(worldConfig, null, 2));
    console.log(`[expand-map] world.json updated: +${newLocations.length} locations, +${newMainAreaPoints.length} main area points`);
  } catch (e) {
    console.warn(`[expand-map] Failed to write world.json: ${e.message}`);
  }
}

// ─── Main Pipeline ──────────────────────────────────────────────────────────

async function main() {
  // ── Validation ──
  logStep(1, `开始地图扩展: 方向=${direction}, worldDir=${worldDir}`);

  if (!fs.existsSync(mapDir)) throw new Error(`Map directory not found: ${mapDir}`);
  if (!fs.existsSync(backgroundPath)) throw new Error(`Background image not found: ${backgroundPath}`);
  if (!fs.existsSync(tmjPath)) throw new Error(`TMJ file not found: ${tmjPath}`);

  // ── Read existing assets ──
  const oldBuffer = fs.readFileSync(backgroundPath);
  const oldMeta = await sharp(oldBuffer).metadata();
  const oldWidth = oldMeta.width;
  const oldHeight = oldMeta.height;
  const oldTMJ = readTMJ();
  const tileSize = oldTMJ.tilewidth || 16;
  const worldDesign = readWorldDesign();

  logStep(1, `原图尺寸: ${oldWidth}x${oldHeight}, tileSize=${tileSize}, 网格=${oldTMJ.width}x${oldTMJ.height}`);

  // Verify dimensions are tile-aligned
  if (oldWidth % tileSize !== 0 || oldHeight % tileSize !== 0) {
    console.warn(`[expand-map] Warning: original dimensions not tile-aligned (${oldWidth}x${oldHeight} / tileSize=${tileSize})`);
  }

  // Create expand working directory for intermediate artifacts
  const expandDir = path.join(mapDir, `expand-${direction}-${Date.now()}`);
  fs.mkdirSync(expandDir, { recursive: true });
  const saveExpand = (filename, data) => {
    const p = path.join(expandDir, filename);
    if (Buffer.isBuffer(data)) fs.writeFileSync(p, data);
    else fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
    return p;
  };

  // ── Step 1: LLM designs new region content ──
  logStep(1, "推理模型设计新区域内容...");

  const directionText = getDirectionText(direction);
  const mapDescription = worldDesign?.mapDescription || "a top-down fantasy map";
  const worldDescription = worldDesign?.worldDescription || worldDesign?.worldSocialContext || "";

  const existingRegionsList = (worldDesign?.regions || [])
    .map((r) => `- ${r.id}: ${r.name} (${r.type}, ${r.enterable ? "可进入" : "景观"}) - ${r.description}`)
    .join("\n") || "（无）";

  const existingElementsList = (worldDesign?.interactiveElements || [])
    .map((e) => `- ${e.id}: ${e.name} - ${e.description}`)
    .join("\n") || "（无）";

  const designPrompt = loadPrompt("expand-design-region.md", {
    direction,
    directionText,
    mapDescription,
    worldDescription: worldDescription || "与现有地图风格保持一致",
    existingRegions: existingRegionsList,
    existingElements: existingElementsList,
  });

  let newDesign;
  try {
    newDesign = await chatJSON(
      [{ role: "user", content: designPrompt }],
      {
        temperature: 0.4,
        logStep: "expand-design",
        requestTimeoutMs: 90000,
      },
    );
  } catch (err) {
    console.warn(`[expand-map] LLM design failed (${err.message}), using fallback design`);
    // Fallback: simple generic design
    newDesign = {
      regions: [
        {
          id: `new_${direction}_area`,
          name: `${directionText}新区域`,
          description: "新扩展的区域，包含道路和自然景观",
          type: "outdoor",
          enterable: false,
          placementHint: "新区域中央",
          visualDescription: "与现有地图风格一致的户外区域，有道路连接",
          interactions: [],
        },
      ],
      interactiveElements: [
        {
          id: `resource_${direction}_1`,
          name: "资源采集点",
          description: "可以采集资源的地点",
          placementHint: "靠近连接道路",
          visualDescription: "显眼的资源物体，与地图风格一致",
          interactions: [
            { id: "collect", name: "采集", description: "采集资源", effects: [{ type: "character_need", target: "resources", value: 1 }] },
          ],
        },
      ],
      boundaryConnection: {
        terrainAtBoundary: "道路和地形自然延伸",
        continuingElements: "道路延续",
        styleNotes: "保持一致的绘画风格",
      },
    };
  }

  saveExpand("01-new-design.json", newDesign);
  logStep(1, `设计完成: ${(newDesign.regions || []).length}个新区域, ${(newDesign.interactiveElements || []).length}个新元素`);

  // Create a mini worldDesign for the new region (for annotation steps)
  const newRegionWorldDesign = normalizeWorldDesign({
    mapDescription: `${mapDescription} - ${directionText}扩展区域`,
    worldDescription: worldDescription,
    regions: newDesign.regions || [],
    interactiveElements: newDesign.interactiveElements || [],
    worldActions: [],
    mapPlan: {},
  });

  // ── Step 2: Generate new region image (outpainting with review) ──
  logStep(2, "生成扩展区域图像...");

  const MAX_RETRIES = parseInt(process.env.EXPAND_MAX_RETRIES || process.env.MAX_RETRIES || "3", 10);
  const GENERATE_TIMEOUT_MS = parseInt(process.env.EXPAND_GENERATE_TIMEOUT_MS || "240000", 10);
  const REVIEW_TIMEOUT_MS = parseInt(process.env.EXPAND_REVIEW_TIMEOUT_MS || "120000", 10);

  // Edge strip size (12% of dimension, minimum 2 tiles)
  const isHorizontal = direction === "east" || direction === "west";
  const edgeDimension = isHorizontal ? oldWidth : oldHeight;
  const edgeStripSize = Math.max(tileSize * 3, Math.round(edgeDimension * 0.12));

  // Extract edge strip and build seed canvas
  logStep(2, `提取边缘条带 (${edgeStripSize}px) 并构建生成画布...`);
  const edgeStripBuffer = await extractEdgeStrip(oldBuffer, oldWidth, oldHeight, direction, edgeStripSize);
  saveExpand("02-edge-strip.png", edgeStripBuffer);

  const seedCanvas = await buildSeedCanvas(edgeStripBuffer, oldWidth, oldHeight, direction, edgeStripSize);
  saveExpand("02-seed-canvas.png", seedCanvas);

  const newRegionSummary = formatRegionSummary(newRegionWorldDesign);
  const newElementSummary = formatElementSummary(newRegionWorldDesign);
  const boundaryNotes = newDesign.boundaryConnection
    ? `边界地形：${newDesign.boundaryConnection.terrainAtBoundary || "自然延续"}\n延续元素：${newDesign.boundaryConnection.continuingElements || "道路、地形自然延伸"}\n风格要点：${newDesign.boundaryConnection.styleNotes || "保持完全一致"}`
    : "边界处道路、地形必须自然衔接，不能断裂";

  // Direction-specific prompt variables
  const directionPromptVars = {
    east:  { edgePositionDesc: "左侧", newAreaDesc: "右侧", outerEdgeDesc: "最右侧边缘", adjacentEdge: "左侧边缘" },
    west:  { edgePositionDesc: "右侧", newAreaDesc: "左侧", outerEdgeDesc: "最左侧边缘", adjacentEdge: "右侧边缘" },
    south: { edgePositionDesc: "上方", newAreaDesc: "下方", outerEdgeDesc: "最下方边缘", adjacentEdge: "上方边缘" },
    north: { edgePositionDesc: "下方", newAreaDesc: "上方", outerEdgeDesc: "最上方边缘", adjacentEdge: "下方边缘" },
  }[direction];

  let newRegionBuffer = null;
  let reviewPassed = false;
  let attempts = 0;
  let additionalConstraints = "";

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    attempts = attempt;
    logStep(2, `生成新区域图像 (尝试 ${attempt}/${MAX_RETRIES + 1})...`);

    const genPrompt = loadPrompt("expand-map-generation.md", {
      directionText,
      mapDescription,
      worldDescription: worldDescription || "与原图风格一致",
      newRegionSummary,
      newElementSummary,
      boundaryNotes,
      edgePositionDesc: directionPromptVars.edgePositionDesc,
      newAreaDesc: directionPromptVars.newAreaDesc,
      outerEdgeDesc: directionPromptVars.outerEdgeDesc,
      additionalConstraints,
    });

    try {
      // Use editImage on the seed canvas - model will fill in the new area
      newRegionBuffer = await editImage(genPrompt, seedCanvas, {
        imageSize: getMapImageSizeLabel(),
        logStep: `expand-gen-${direction}-a${attempt}`,
        requestTimeoutMs: GENERATE_TIMEOUT_MS,
      });

      // Ensure exact dimensions
      const genMeta = await sharp(newRegionBuffer).metadata();
      if (genMeta.width !== oldWidth || genMeta.height !== oldHeight) {
        logStep(2, `调整生成图像尺寸: ${genMeta.width}x${genMeta.height} -> ${oldWidth}x${oldHeight}`);
        newRegionBuffer = await sharp(newRegionBuffer)
          .resize(oldWidth, oldHeight, { fit: "fill" })
          .png()
          .toBuffer();
      }

      saveExpand(`02-new-region-attempt-${attempt}.png`, newRegionBuffer);
      logStep(2, `新区域图像已生成: ${newRegionBuffer.length} bytes`);

      // Multimodal review
      logStep(2, `审查新区域图像 (尝试 ${attempt}/${MAX_RETRIES + 1})...`);
      const { buffer: smallOld } = await resizeImage(oldBuffer, 1024);
      const { buffer: smallNew } = await resizeImage(newRegionBuffer, 1024);

      const reviewPrompt = loadPrompt("expand-map-review.md", {
        mapDescription,
        directionText,
        adjacentEdge: directionPromptVars.adjacentEdge,
      });

      let review;
      try {
        review = await geminiProVisionJSON(reviewPrompt, [smallOld, smallNew], {
          logStep: `expand-review-${direction}-a${attempt}`,
          requestTimeoutMs: REVIEW_TIMEOUT_MS,
        });
      } catch (e) {
        console.warn(`[expand-map] Review failed on attempt ${attempt}: ${e.message}`);
        review = { pass: false, issues: [`Review failed: ${e.message}`], promptAdjustments: [], boundaryScore: 5, styleScore: 5 };
      }

      logStep(2, `审查结果: pass=${review.pass}, boundary=${review.boundaryScore}/10, style=${review.styleScore}/10`);

      if (review.pass && (review.boundaryScore ?? 7) >= 6 && (review.styleScore ?? 7) >= 6) {
        logStep(2, `新区域图像通过审查 (尝试 ${attempt})`);
        reviewPassed = true;
        break;
      }

      if (attempt <= MAX_RETRIES && review.promptAdjustments?.length) {
        additionalConstraints += `\n## 第${attempt}次审查反馈\n${review.promptAdjustments.join("\n")}\n边界衔接分数: ${review.boundaryScore}/10, 风格一致性分数: ${review.styleScore}/10\n问题: ${(review.issues || []).join("; ")}`;
      }
    } catch (err) {
      console.warn(`[expand-map] Generation attempt ${attempt} failed: ${err.message}`);
      if (attempt > MAX_RETRIES) throw err;
    }
  }

  if (!newRegionBuffer) {
    throw new Error("Failed to generate new region after all retries");
  }

  if (!reviewPassed) {
    console.warn(`[expand-map] Review never passed after ${attempts} attempts, using best effort result`);
  }

  // ── Step 3: Blend seam + Compress ──
  logStep(3, "边界融合处理与图像压缩...");
  newRegionBuffer = await blendSeam(oldBuffer, newRegionBuffer, oldWidth, oldHeight, direction, tileSize);
  saveExpand("03-new-region-blended.png", newRegionBuffer);

  const {
    compressedMap: compressedNewRegion,
    width: compNewWidth,
    height: compNewHeight,
  } = await compressMap(newRegionBuffer);
  saveExpand("03-compressed-new-region.png", compressedNewRegion);
  logStep(3, `压缩完成: ${compNewWidth}x${compNewHeight}`);

  // ── Step 4: Annotate regions, elements, walkable areas (parallel) ──
  logStep(4, "并行执行：功能区标注 + 元素标注 + 可行走区域标注...");

  const newRegionUserPrompt = `${mapDescription} - ${directionText}扩展区域`;

  const [regionResult, elementResult, walkableResult] = await Promise.all([
    resolveDesignedRegions(compressedNewRegion, newRegionWorldDesign, newRegionUserPrompt, saveExpand),
    locateElements(compressedNewRegion, newRegionWorldDesign, newRegionUserPrompt, saveExpand),
    generateWalkableMap(compressedNewRegion, newRegionUserPrompt, newRegionWorldDesign, saveExpand),
  ]);

  saveExpand("04-new-regions.json", regionResult.regions);
  saveExpand("04-new-elements.json", elementResult.elements);

  logStep(4, `标注完成: ${regionResult.regions.length}个区域, ${elementResult.elements.length}个元素, 可行走区域review=${walkableResult.reviewPassed}`);

  // Scale coordinates from compressed to original resolution
  const scaledNewRegions = scaleRegions(regionResult.regions, oldWidth, compNewWidth);
  const scaledNewElements = scaleElements(elementResult.elements, oldWidth, compNewWidth);

  // ── Step 5: Compute walkable grid for new region ──
  logStep(5, "计算新区域可行走网格...");
  const {
    grid: newGrid,
    gridWidth: newGridW,
    gridHeight: newGridH,
  } = await computeGrid(compressedNewRegion, walkableResult.buffer, oldWidth);
  saveExpand("05-new-grid.json", { gridWidth: newGridW, gridHeight: newGridH, grid: newGrid });
  logStep(5, `新区域网格: ${newGridW}x${newGridH}`);

  // ── Step 6: Stitch images, merge TMJ, save results ──
  logStep(6, "拼接地图、合并数据并保存...");

  // Target background dimensions (must be tile-aligned like the main pipeline Step 6)
  const oldBgWidth = oldTMJ.width * tileSize;
  const oldBgHeight = oldTMJ.height * tileSize;
  const newRegionBgWidth = newGridW * tileSize;
  const newRegionBgHeight = newGridH * tileSize;

  // Resize buffers to tile-aligned dimensions for stitching
  const oldBufferForStitch = (oldBgWidth !== oldWidth || oldBgHeight !== oldHeight)
    ? await sharp(oldBuffer)
        .resize(oldBgWidth, oldBgHeight, { fit: "fill" })
        .png()
        .toBuffer()
    : oldBuffer;
  const newRegionForStitch = (newRegionBgWidth !== oldWidth || newRegionBgHeight !== oldHeight)
    ? await sharp(newRegionBuffer)
        .resize(newRegionBgWidth, newRegionBgHeight, { fit: "fill" })
        .png()
        .toBuffer()
    : newRegionBuffer;

  // Stitch images
  const stitchedBuffer = await stitchMaps(oldBufferForStitch, newRegionForStitch, oldBgWidth, oldBgHeight, direction);
  const stitchedMeta = await sharp(stitchedBuffer).metadata();

  // Scale new regions/elements coordinates from original generated resolution to tile-aligned background resolution
  const scaleCoords = (obj, fromW, fromH, toW, toH) => ({
    ...obj,
    topLeft: {
      x: Math.round(obj.topLeft.x * (toW / fromW)),
      y: Math.round(obj.topLeft.y * (toH / fromH)),
    },
    bottomRight: {
      x: Math.round(obj.bottomRight.x * (toW / fromW)),
      y: Math.round(obj.bottomRight.y * (toH / fromH)),
    },
  });

  // scaledNewRegions/Elements are at oldWidth/oldHeight (generated image resolution).
  // Rescale to newRegionBgWidth/newRegionBgHeight (tile-aligned background resolution).
  const finalNewRegions = scaledNewRegions.map((r) =>
    scaleCoords(r, oldWidth, oldHeight, newRegionBgWidth, newRegionBgHeight)
  );
  const finalNewElements = scaledNewElements.map((e) =>
    scaleCoords(e, oldWidth, oldHeight, newRegionBgWidth, newRegionBgHeight)
  );

  // Note: old TMJ objects already have coordinates in oldBgWidth x oldBgHeight space
  // (since the TMJ was built for the existing 06-background.png), so no rescaling needed.

  // Build combined TMJ with correctly scaled coordinates and proper offsets
  const finalTMJ = buildCombinedTMJ(
    oldTMJ,
    {
      newGrid,
      newRegions: finalNewRegions,
      newElements: finalNewElements,
    },
    direction,
    tileSize,
    oldBgWidth,
    oldBgHeight,
    newRegionBgWidth,
    newRegionBgHeight,
  );

  // ── Save results (part of Step 6) ──

  // Backup old files
  const backupBg = path.join(mapDir, `06-background.bak-${Date.now()}.png`);
  const backupTmj = path.join(mapDir, `06-final.bak-${Date.now()}.tmj`);
  fs.copyFileSync(backgroundPath, backupBg);
  fs.copyFileSync(tmjPath, backupTmj);

  // Write new files
  fs.writeFileSync(backgroundPath, stitchedBuffer);
  writeTMJ(finalTMJ);

  // Update world.json to include new regions, elements, and main area points
  updateWorldJson(worldDir, finalTMJ, oldTMJ, direction, tileSize);

  // Update world-design.json to include new regions/elements
  if (worldDesign && fs.existsSync(worldDesignPath)) {
    try {
      const updatedDesign = JSON.parse(fs.readFileSync(worldDesignPath, "utf-8"));
      const timestamp = Date.now();
      const newRegionsWithIds = (newDesign.regions || []).map((r, i) => ({
        ...r,
        id: r.id || `expand_${direction}_${timestamp}_r${i}`,
      }));
      const newElementsWithIds = (newDesign.interactiveElements || []).map((e, i) => ({
        ...e,
        id: e.id || `expand_${direction}_${timestamp}_e${i}`,
      }));
      updatedDesign.regions = [...(updatedDesign.regions || []), ...newRegionsWithIds];
      updatedDesign.interactiveElements = [...(updatedDesign.interactiveElements || []), ...newElementsWithIds];
      fs.writeFileSync(worldDesignPath, JSON.stringify(updatedDesign, null, 2));
    } catch (e) {
      console.warn(`[expand-map] Failed to update world-design.json: ${e.message}`);
    }
  }

  // Update metadata
  const metadataPath = path.join(mapDir, "metadata.json");
  if (fs.existsSync(metadataPath)) {
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
      if (!metadata.expansions) metadata.expansions = [];
      metadata.expansions.push({
        direction,
        timestamp: new Date().toISOString(),
        previousSize: { width: oldBgWidth, height: oldBgHeight },
        newSize: { width: stitchedMeta.width, height: stitchedMeta.height },
        previousGrid: { width: oldTMJ.width, height: oldTMJ.height },
        newGrid: { width: finalTMJ.width, height: finalTMJ.height },
        newRegions: regionResult.regions.length,
        newElements: elementResult.elements.length,
        reviewPassed,
        attempts,
        expandDir: path.basename(expandDir),
      });
      metadata.completedAt = new Date().toISOString();
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
    } catch (e) {
      console.warn("[expand-map] Failed to update metadata:", e.message);
    }
  }

  // Also save stitched preview in expand dir
  saveExpand("06-stitched-final.png", stitchedBuffer);
  saveExpand("06-final.tmj", finalTMJ);

  logStep(6, `地图扩展完成! 新尺寸: ${stitchedMeta.width}x${stitchedMeta.height}, 网格: ${finalTMJ.width}x${finalTMJ.height}`);
  logStep(6, `新增区域: ${regionResult.regions.length}个, 新增元素: ${elementResult.elements.length}个`);

  console.log(JSON.stringify({
    ok: true,
    direction,
    newWidth: stitchedMeta.width,
    newHeight: stitchedMeta.height,
    newGridWidth: finalTMJ.width,
    newGridHeight: finalTMJ.height,
    newRegions: regionResult.regions.length,
    newElements: elementResult.elements.length,
    reviewPassed,
    attempts,
  }));
}

main().catch((err) => {
  console.error("[expand-map] Failed:", err);
  console.log(JSON.stringify({ ok: false, error: err.message || String(err) }));
  process.exit(1);
});