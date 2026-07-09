import test from "node:test";
import assert from "node:assert/strict";
import { buildTMJ } from "../../../generators/map/src/utils/tmj-builder.mjs";

test("TMJ interactive object serializes interactions", () => {
  const tmj = buildTMJ({
    gridWidth: 2,
    gridHeight: 2,
    tileSize: 16,
    collisionGrid: [[0, 1], [0, 0]],
    regions: [],
    interactiveObjects: [
      {
        id: "well",
        name: "Well",
        topLeft: { x: 10, y: 20 },
        bottomRight: { x: 30, y: 40 },
        interactions: [
          { id: "draw_water", name: "Draw water", duration: 1 },
        ],
      },
    ],
    backgroundImage: "bg.png",
  });

  const layer = tmj.layers.find((item) => item.name === "interactive_objects");
  assert.ok(layer);
  assert.equal(layer.objects.length, 1);
  const property = layer.objects[0].properties.find((item) => item.name === "interactions");
  assert.ok(property);
  assert.deepEqual(JSON.parse(property.value), [
    { id: "draw_water", name: "Draw water", duration: 1 },
  ]);
});

test("TMJ keeps backward compatibility with suggestedInteractions", () => {
  const tmj = buildTMJ({
    gridWidth: 1,
    gridHeight: 1,
    collisionGrid: [[0]],
    interactiveObjects: [
      {
        id: "legacy",
        topLeft: { x: 0, y: 0 },
        bottomRight: { x: 10, y: 10 },
        suggestedInteractions: [{ id: "legacy_action" }],
      },
    ],
  });
  const layer = tmj.layers.find((item) => item.name === "interactive_objects");
  const property = layer.objects[0].properties.find((item) => item.name === "interactions");
  assert.deepEqual(JSON.parse(property.value), [{ id: "legacy_action" }]);
});
