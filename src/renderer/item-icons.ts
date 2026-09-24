/**
 * Item pictures for the UI, baked from the sprites. See ironflow.md C32.
 *
 * C32 made every item in a panel a picture. The pictures already exist: the
 * atlas draws every item that rides a belt and every building that stands on
 * the ground. So a bag's iron plate is the belt's iron plate, and a carried
 * miner is the miner, seen from the same raised camera (§11).
 *
 * §4 keeps `ui/**` out of this layer, so the composition root turns this into
 * the UI's `ItemIconSource`: a function from an item id to an image URL.
 *
 * ## How a picture is framed
 *
 * A sprite is drawn about its ground anchor and grows up the screen (§11's
 * asset spec), and its shadow falls south-east. Rather than repeat that
 * geometry here, the sprite is painted large onto a scratch canvas, the
 * painted pixels are measured, and that box is scaled into the icon with a
 * margin. A sprite whose art changes is framed correctly without a line here
 * changing.
 *
 * Each picture is baked on first request and kept. There are a few dozen
 * items, so the cache is the whole content table at most.
 */

import type { BuildingRegistry } from '../game/registries/building-registry.js';
import { NORTH } from '../game/world/coordinates.js';

import { buildingSprite } from './entity-view.js';
import { itemSprite, type SpriteAtlas, type SpriteId } from './sprite-atlas.js';

/** The scratch canvas's side. Larger than any sprite at the zooms below. */
const SCRATCH_PX = 384;

/** Where the scratch sprite's ground anchor goes: centred, low, room above. */
const ANCHOR_X = SCRATCH_PX / 2;
const ANCHOR_Y = SCRATCH_PX * 0.6;

/** A building is painted this many zoom units across its longer side. */
const BUILDING_ZOOM_SPAN = 2.4;

/** An item is small on a belt (four to a tile, §9), so it is painted large. */
const ITEM_ZOOM = 8;

/** Empty pixels kept around the picture, as a share of the icon. */
const MARGIN = 0.08;

/** Alpha below this is antialiasing haze, not picture. */
const ALPHA_THRESHOLD = 8;

/**
 * A fresh canvas of the given size. Its context is asked for here, not by the
 * factory, because the first request fixes its attributes.
 */
export type IconCanvasFactory = (width: number, height: number) => HTMLCanvasElement | null;

export interface ItemIconOptions {
  readonly atlas: SpriteAtlas;
  readonly buildings: BuildingRegistry;
  readonly createCanvas: IconCanvasFactory;
  /** The icon's side in device pixels. §11 says author at 2x. */
  readonly size: number;
}

/**
 * The sprite that pictures an item, and the zoom to paint it at. A
 * building's item is the building (§15: a building costs one of its own
 * item, under the same id); anything else is the item as it rides a belt.
 */
export function iconSpriteFor(itemId: string, buildings: BuildingRegistry): { sprite: SpriteId; zoom: number } {
  if (buildings.has(itemId)) {
    const definition = buildings.get(itemId);
    const span = Math.max(definition.size.width, definition.size.height);
    return { sprite: buildingSprite(definition, NORTH), zoom: BUILDING_ZOOM_SPAN / span };
  }
  return { sprite: itemSprite(itemId), zoom: ITEM_ZOOM };
}

/** An item id to a PNG data URL, baked on first request; null if it cannot be. */
export function createItemIconSource(options: ItemIconOptions): (itemId: string) => string | null {
  const cache = new Map<string, string | null>();
  const pictures = createPictureSource(options);

  return (itemId: string): string | null => {
    const cached = cache.get(itemId);
    if (cached !== undefined) return cached;
    const url = pictures(itemId)?.toDataURL('image/png') ?? null;
    cache.set(itemId, url);
    return url;
  };
}

/**
 * An item id and a count to a PNG data URL: the item's picture with the count
 * in its lower right corner, as a stack is drawn in the genre. For the held
 * item's cursor (2026-09-24), which shows how many the bag has left.
 *
 * The picture is baked once per item; the count is painted over a copy of it
 * on every call, so a caller asks only when the count changes.
 */
export function createCountedIconSource(options: ItemIconOptions): (itemId: string, count: number) => string | null {
  const pictures = createPictureSource(options);
  let target: CanvasRenderingContext2D | null | undefined;

  return (itemId: string, count: number): string | null => {
    const picture = pictures(itemId);
    if (picture === null) return null;
    if (target === undefined) target = context(options.createCanvas(options.size, options.size), false);
    if (target === null) return null;
    const size = options.size;
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, size, size);
    target.drawImage(picture, 0, 0);

    const text = compactCount(count);
    target.font = `bold ${Math.round(size * COUNT_FONT_SHARE)}px sans-serif`;
    target.textAlign = 'right';
    target.textBaseline = 'bottom';
    target.lineJoin = 'round';
    target.lineWidth = 3;
    target.strokeStyle = 'rgba(0, 0, 0, 0.9)';
    target.strokeText(text, size - 1, size);
    target.fillStyle = '#ffffff';
    target.fillText(text, size - 1, size);
    return target.canvas.toDataURL('image/png');
  };
}

/** A count that fits a cursor's corner: 999, 1.2k, 12k. */
export function compactCount(count: number): string {
  const whole = Math.max(0, Math.round(count));
  if (whole < 1000) return String(whole);
  if (whole < 10_000) return `${Math.floor(whole / 100) / 10}k`;
  return `${Math.floor(whole / 1000)}k`;
}

/** The count's type size, as a share of the icon's side. */
const COUNT_FONT_SHARE = 0.36;

/** An item id to its baked picture, cached; null if it cannot be drawn. */
function createPictureSource(options: ItemIconOptions): (itemId: string) => HTMLCanvasElement | null {
  const cache = new Map<string, HTMLCanvasElement | null>();
  let scratch: CanvasRenderingContext2D | null | undefined;

  return (itemId: string): HTMLCanvasElement | null => {
    const cached = cache.get(itemId);
    if (cached !== undefined) return cached;
    // Read back once per item, so the browser is told to keep it in memory.
    if (scratch === undefined) scratch = context(options.createCanvas(SCRATCH_PX, SCRATCH_PX), true);
    let picture: HTMLCanvasElement | null = null;
    try {
      picture = scratch === null ? null : bake(scratch, itemId, options);
    } catch {
      // A picture is decoration: an item that cannot be drawn keeps its letters.
      picture = null;
    }
    cache.set(itemId, picture);
    return picture;
  };
}

function bake(scratch: CanvasRenderingContext2D, itemId: string, options: ItemIconOptions): HTMLCanvasElement | null {
  const { sprite, zoom } = iconSpriteFor(itemId, options.buildings);
  scratch.setTransform(1, 0, 0, 1, 0, 0);
  scratch.clearRect(0, 0, SCRATCH_PX, SCRATCH_PX);
  options.atlas.draw(scratch, sprite, ANCHOR_X, ANCHOR_Y, zoom);

  const box = paintedBox(scratch.getImageData(0, 0, SCRATCH_PX, SCRATCH_PX).data);
  if (box === null) return null;

  const size = options.size;
  const canvas = options.createCanvas(size, size);
  const ctx = context(canvas, false);
  if (canvas === null || ctx === null) return null;
  const room = size * (1 - 2 * MARGIN);
  const scale = Math.min(room / box.width, room / box.height);
  const width = box.width * scale;
  const height = box.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(scratch.canvas, box.x, box.y, box.width, box.height, (size - width) / 2, (size - height) / 2, width, height);
  return canvas;
}

/**
 * A 2D context, or null where there is none. A DOM without canvas support
 * (jsdom) throws rather than answering null, and a picture is not worth that.
 */
function context(canvas: HTMLCanvasElement | null, readBack: boolean): CanvasRenderingContext2D | null {
  try {
    return canvas?.getContext('2d', { willReadFrequently: readBack }) ?? null;
  } catch {
    return null;
  }
}

/** The smallest rectangle holding every painted pixel, or null for none. */
export function paintedBox(
  pixels: ArrayLike<number>,
  side = SCRATCH_PX,
): { x: number; y: number; width: number; height: number } | null {
  let minX = side;
  let minY = side;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if ((pixels[(y * side + x) * 4 + 3] ?? 0) < ALPHA_THRESHOLD) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}
