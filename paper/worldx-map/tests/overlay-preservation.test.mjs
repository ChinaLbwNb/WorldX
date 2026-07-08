import test from "node:test";
import assert from "node:assert/strict";
import {
  computeOverlayPreservation,
  dilateBox,
} from "../evaluation/overlay-preservation.mjs";

function rgbImage(width, height, rgb = [10, 20, 30]) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    data[i * 3] = rgb[0];
    data[i * 3 + 1] = rgb[1];
    data[i * 3 + 2] = rgb[2];
  }
  return data;
}

test("dilateBox expands and clamps", () => {
  assert.deepEqual(
    dilateBox({ x1: 1, y1: 1, x2: 11, y2: 11 }, 20, 20, 0.1),
    { x1: 0, y1: 0, x2: 12, y2: 12 },
  );
});

test("changes entirely inside excluded target do not count as drift", () => {
  const width = 4;
  const height = 4;
  const original = rgbImage(width, height);
  const overlay = rgbImage(width, height);
  const index = (1 * width + 1) * 3;
  overlay[index] = 255;
  overlay[index + 1] = 0;
  overlay[index + 2] = 255;

  const result = computeOverlayPreservation({
    originalRgb: original,
    overlayRgb: overlay,
    width,
    height,
    channels: 3,
    excludedBoxes: [{ x1: 1, y1: 1, x2: 2, y2: 2 }],
    changeThreshold: 12,
  });

  assert.equal(result.outsidePixels, 15);
  assert.equal(result.changedOutsidePixels, 0);
  assert.equal(result.outsideTargetChangeRate, 0);
  assert.equal(result.outsideTargetMeanAbsoluteChange, 0);
});

test("non-target drift is measured", () => {
  const width = 2;
  const height = 1;
  const original = rgbImage(width, height, [0, 0, 0]);
  const overlay = rgbImage(width, height, [0, 0, 0]);
  overlay[3] = 12;

  const result = computeOverlayPreservation({
    originalRgb: original,
    overlayRgb: overlay,
    width,
    height,
    channels: 3,
    excludedBoxes: [],
    changeThreshold: 12,
  });

  assert.equal(result.outsidePixels, 2);
  assert.equal(result.changedOutsidePixels, 1);
  assert.equal(result.outsideTargetChangeRate, 0.5);
  assert.equal(result.outsideTargetMeanAbsoluteChange, 2);
});
