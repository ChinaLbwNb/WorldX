function area(box) {
  if (!box) return 0;
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

export function bboxIoU(a, b) {
  if (!a || !b) return 0;
  const ix1 = Math.max(a.x1, b.x1);
  const iy1 = Math.max(a.y1, b.y1);
  const ix2 = Math.min(a.x2, b.x2);
  const iy2 = Math.min(a.y2, b.y2);
  const intersection = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
  const union = area(a) + area(b) - intersection;
  return union > 0 ? intersection / union : 0;
}

export function normalizedCenterError(pred, gold, imageWidth, imageHeight) {
  if (!pred || !gold) return 1;
  const pcx = (pred.x1 + pred.x2) / 2;
  const pcy = (pred.y1 + pred.y2) / 2;
  const gcx = (gold.x1 + gold.x2) / 2;
  const gcy = (gold.y1 + gold.y2) / 2;
  const diagonal = Math.hypot(imageWidth, imageHeight);
  if (diagonal <= 0) throw new Error("Invalid image dimensions");
  return Math.hypot(pcx - gcx, pcy - gcy) / diagonal;
}

export function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function evaluatePredictions(gold, predictions) {
  const width = Number(gold.imageWidth || predictions.imageWidth);
  const height = Number(gold.imageHeight || predictions.imageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Gold/prediction files must provide valid imageWidth and imageHeight");
  }

  const predById = new Map((predictions.targets || []).map((item) => [String(item.id), item]));
  const presentGold = (gold.targets || []).filter((item) => item.present === true && item.bbox);
  const rows = presentGold.map((target) => {
    const pred = predById.get(String(target.id));
    const located = pred?.status === "located" && pred?.bbox;
    const iou = located ? bboxIoU(pred.bbox, target.bbox) : 0;
    const nce = located ? normalizedCenterError(pred.bbox, target.bbox, width, height) : 1;
    return {
      id: target.id,
      type: target.type,
      located: Boolean(located),
      iou,
      nce,
      recallAt03: iou >= 0.3 ? 1 : 0,
      recallAt05: iou >= 0.5 ? 1 : 0,
    };
  });

  const locatedRows = rows.filter((row) => row.located);
  const targetCount = rows.length;
  const locatedCount = locatedRows.length;

  return {
    mapId: gold.mapId || predictions.mapId || null,
    method: predictions.method || null,
    targetCount,
    locatedCount,
    missingCount: targetCount - locatedCount,
    missingRate: targetCount > 0 ? (targetCount - locatedCount) / targetCount : null,
    meanIoUAll: mean(rows.map((row) => row.iou)),
    meanIoULocated: mean(locatedRows.map((row) => row.iou)),
    meanNCEAll: mean(rows.map((row) => row.nce)),
    meanNCELocated: mean(locatedRows.map((row) => row.nce)),
    recallAt03: mean(rows.map((row) => row.recallAt03)),
    recallAt05: mean(rows.map((row) => row.recallAt05)),
    rows,
  };
}
