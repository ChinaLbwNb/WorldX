import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateWorld } from "./lib/validate-world.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "worldx-exp-test-"));
const worldDir = path.join(root, "world_test");
fs.mkdirSync(path.join(worldDir, "map"), { recursive: true });
fs.mkdirSync(path.join(worldDir, "config", "characters"), { recursive: true });

const collision = [
  1,1,1,1,1,
  1,0,0,0,1,
  1,0,0,0,1,
  1,0,0,0,1,
  1,1,1,1,1,
];

fs.writeFileSync(path.join(worldDir, "world-design.json"), JSON.stringify({
  worldName: "Test World",
  mapDescription: "A test map",
  characters: [{ name: "A" }],
  regions: [{ id: "square" }],
  interactiveElements: [{ id: "well" }],
}), "utf-8");
fs.writeFileSync(path.join(worldDir, "map", "06-background.png"), "fixture", "utf-8");
fs.writeFileSync(path.join(worldDir, "map", "06-final.tmj"), JSON.stringify({
  width: 5,
  height: 5,
  tilewidth: 10,
  tileheight: 10,
  layers: [
    { name: "collision", data: collision },
    { name: "regions", objects: [{ id: 1, name: "Square", x: 10, y: 10, width: 20, height: 20 }] },
    { name: "interactive_objects", objects: [{ id: 2, name: "Well", x: 20, y: 20, width: 10, height: 10 }] },
  ],
}), "utf-8");
fs.writeFileSync(path.join(worldDir, "config", "world.json"), JSON.stringify({
  locations: [{ id: "main_area" }],
  mainAreaPoints: [{ id: "spawn", x: 25, y: 25 }],
}), "utf-8");
fs.writeFileSync(path.join(worldDir, "config", "scene.json"), JSON.stringify({ sceneType: "open" }), "utf-8");
fs.writeFileSync(path.join(worldDir, "config", "characters", "char_1.json"), JSON.stringify({ id: "char_1", name: "A" }), "utf-8");

const result = validateWorld(worldDir);
assert.equal(result.valid, true, JSON.stringify(result.issues));
assert.equal(result.e2eExecutable, true);
assert.equal(result.spatial.spawnValid, true);
assert.equal(result.spatial.reachableRegionRatio, 1);
assert.equal(result.spatial.reachableElementRatio, 1);

const brokenDir = path.join(root, "world_broken");
fs.cpSync(worldDir, brokenDir, { recursive: true });
const brokenTmj = JSON.parse(fs.readFileSync(path.join(brokenDir, "map", "06-final.tmj"), "utf-8"));
brokenTmj.layers.find((layer) => layer.name === "collision").data = [0];
fs.writeFileSync(path.join(brokenDir, "map", "06-final.tmj"), JSON.stringify(brokenTmj), "utf-8");
const broken = validateWorld(brokenDir);
assert.equal(broken.valid, false);
assert.ok(broken.issues.some((issue) => issue.includes("collision layer")));

fs.rmSync(root, { recursive: true, force: true });
console.log("worldx-paper experiment self-test passed");
