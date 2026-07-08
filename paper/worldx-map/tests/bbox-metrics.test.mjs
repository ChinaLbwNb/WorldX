import test from "node:test";
import assert from "node:assert/strict";
import {
  bboxIoU,
  normalizedCenterError,
  evaluatePredictions,
} from "../evaluation/bbox-metrics.mjs";

test("bboxIoU returns 1 for identical boxes", () => {
  const box = { x1: 10, y1: 20, x2: 110, y2: 120 };
  assert.equal(bboxIoU(box, box), 1);
});

test("bboxIoU returns 0 for disjoint boxes", () => {
  assert.equal(
    bboxIoU(
      { x1: 0, y1: 0, x2: 10, y2: 10 },
      { x1: 20, y1: 20, x2: 30, y2: 30 },
    ),
    0,
  );
});

test("normalizedCenterError is zero for equal centers", () => {
  const value = normalizedCenterError(
    { x1: 0, y1: 0, x2: 20, y2: 20 },
    { x1: 5, y1: 5, x2: 15, y2: 15 },
    100,
    100,
  );
  assert.equal(value, 0);
});

test("missing predictions count as IoU 0 and NCE 1", () => {
  const gold = {
    mapId: "T",
    imageWidth: 100,
    imageHeight: 100,
    targets: [
      { id: "a", type: "region", present: true, bbox: { x1: 0, y1: 0, x2: 20, y2: 20 } },
      { id: "b", type: "element", present: true, bbox: { x1: 50, y1: 50, x2: 70, y2: 70 } },
    ],
  };
  const predictions = {
    method: "test",
    targets: [
      { id: "a", status: "located", bbox: { x1: 0, y1: 0, x2: 20, y2: 20 } },
      { id: "b", status: "missing", bbox: null },
    ],
  };
  const result = evaluatePredictions(gold, predictions);
  assert.equal(result.targetCount, 2);
  assert.equal(result.locatedCount, 1);
  assert.equal(result.missingRate, 0.5);
  assert.equal(result.meanIoUAll, 0.5);
  assert.equal(result.meanNCEAll, 0.5);
  assert.equal(result.recallAt05, 0.5);
});

test("absent targets are scored as false positives separately", () => {
  const gold = {
    mapId: "T2",
    imageWidth: 100,
    imageHeight: 100,
    targets: [
      { id: "present", type: "region", present: true, bbox: { x1: 0, y1: 0, x2: 20, y2: 20 } },
      { id: "absent_a", type: "element", present: false, bbox: null },
      { id: "absent_b", type: "element", present: false, bbox: null },
    ],
  };
  const predictions = {
    method: "test",
    targets: [
      { id: "present", status: "located", bbox: { x1: 0, y1: 0, x2: 20, y2: 20 } },
      { id: "absent_a", status: "located", bbox: { x1: 40, y1: 40, x2: 50, y2: 50 } },
      { id: "absent_b", status: "missing", bbox: null },
    ],
  };
  const result = evaluatePredictions(gold, predictions);
  assert.equal(result.absentTargetCount, 2);
  assert.equal(result.absentFalsePositiveCount, 1);
  assert.equal(result.absentFalsePositiveRate, 0.5);
  assert.equal(result.presenceAccuracy, 2 / 3);
});

test("present gold target without bbox is rejected", () => {
  const gold = {
    imageWidth: 100,
    imageHeight: 100,
    targets: [{ id: "bad", type: "region", present: true, bbox: null }],
  };
  assert.throws(
    () => evaluatePredictions(gold, { targets: [] }),
    /Present gold targets missing bbox/,
  );
});
