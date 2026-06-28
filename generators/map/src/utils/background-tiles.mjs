import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

export const BACKGROUND_TILE_SIZE = 1024;

export async function writeBackgroundTiles(mapDir, imageBuffer, options = {}) {
  const tileSize = options.tileSize || BACKGROUND_TILE_SIZE;
  const tileDir = path.join(mapDir, "background-tiles");
  const previewName = "background-preview.png";
  const metadata = await sharp(imageBuffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;

  if (!width || !height) {
    throw new Error("Cannot tile background image without dimensions");
  }

  fs.rmSync(tileDir, { recursive: true, force: true });
  fs.mkdirSync(tileDir, { recursive: true });

  const tiles = [];
  let index = 0;
  for (let y = 0; y < height; y += tileSize) {
    for (let x = 0; x < width; x += tileSize) {
      const tileWidth = Math.min(tileSize, width - x);
      const tileHeight = Math.min(tileSize, height - y);
      const fileName = `tile-${index}.png`;
      await sharp(imageBuffer)
        .extract({ left: x, top: y, width: tileWidth, height: tileHeight })
        .png()
        .toFile(path.join(tileDir, fileName));
      tiles.push({
        key: `world-base-tile-${index}`,
        path: `background-tiles/${fileName}`,
        x,
        y,
        width: tileWidth,
        height: tileHeight,
      });
      index += 1;
    }
  }

  await sharp(imageBuffer)
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .png()
    .toFile(path.join(mapDir, previewName));

  const manifest = {
    version: 1,
    width,
    height,
    tileSize,
    preview: previewName,
    tiles,
  };
  fs.writeFileSync(path.join(tileDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}
