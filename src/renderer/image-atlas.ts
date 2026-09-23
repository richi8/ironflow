/**
 * The image-backed sprite atlas. See ironflow.md C29 art task 2 and §16 path 2.
 *
 * `SpriteAtlas` was declared in C03 so this file could exist without the
 * layers changing a line, and it is the swap §11 promised: every sprite is one
 * `drawImage` out of one image instead of a dozen paths, arcs and strokes.
 * C29's first measurement is why it was built *now* — at the far zoom the
 * procedural atlas spent 38 ms of a 45 ms frame drawing about nineteen
 * thousand sprites, against an 8 ms budget.
 *
 * ## Where the image comes from
 *
 * There is no artist, so there is no painted sheet: `layoutAtlas` packs every
 * sprite the game can name into a JSON descriptor, one sheet per scale, and
 * `paintLevel` paints a sheet with `sprite-painter.ts` the first time the game
 * draws from it. The descriptor is the whole contract — a sheet drawn by hand,
 * loaded as an `<img>`, goes into the same constructor with the same
 * descriptor and a source that returns it.
 *
 * ## Levels
 *
 * One scale does not serve a 16x zoom range. The atlas holds several
 * **levels**, each the same sprites painted at one scale, and draws from the
 * smallest level at least as large as what the screen needs — so a sprite is
 * only ever scaled *down*, by at most half, which is what keeps it sharp
 * (§11: "author at 2x and let the renderer downscale"). Below `DETAIL_ZOOM`
 * there is a second set, painted without small details or animation (C29 art
 * task 4), because detail that is a fraction of a pixel is shimmer.
 *
 * Above the largest level — past 2x device pixels per world pixel — it draws
 * live through the procedural atlas instead. Few enough tiles fit on screen at
 * that zoom that painting is cheap, and a painted sprite is sharp at any size.
 */

import type { Rotation } from '../game/world/coordinates.js';

import { describeSprite, type SpriteAtlas, type SpriteDescriptor, type SpriteId } from './sprite-atlas.js';
import { DETAIL_ZOOM, EAST_STEP, RISE_UNIT, SHADOW_SLANT, SOUTH_STEP } from './sprite-geometry.js';
import { paintSprite } from './sprite-painter.js';

/** One sprite's rectangle in a level's image, and where its anchor is in it. */
export interface AtlasCell {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The anchor — the footprint's ground centre — from the cell's corner. */
  readonly ax: number;
  readonly ay: number;
}

/** One scale's worth of sprites. `cells` is keyed by sprite id. */
export interface AtlasLevel {
  readonly scale: number;
  /** Painted with small details and animation (true), or without (false). */
  readonly detail: boolean;
  readonly width: number;
  readonly height: number;
  readonly cells: Readonly<Record<SpriteId, AtlasCell>>;
}

/** The JSON descriptor. Plain data, so a hand-painted sheet can ship one. */
export interface AtlasDescriptor {
  readonly format: 'ironflow-atlas';
  readonly version: 1;
  readonly levels: readonly AtlasLevel[];
}

/** What one level is painted from: its scale, its detail and its sprites. */
export interface LevelSpec {
  readonly scale: number;
  readonly detail: boolean;
  readonly ids: readonly SpriteId[];
}

/* -------------------------------------------------------------------------- *
 * Extents
 * -------------------------------------------------------------------------- */

/** How far a sprite reaches from its anchor, in tiles, each way. */
export interface Extent {
  readonly left: number;
  readonly right: number;
  readonly up: number;
  readonly down: number;
}

/** One unit of bulk, in tiles of screen rise (§11: 0.45). */
const LIFT_TILES = RISE_UNIT / SOUTH_STEP.y;

/** Room for outlines and antialiasing, in tiles, on every side. */
const EXTENT_MARGIN = 0.05;

/**
 * The box a sprite is painted inside, conservatively.
 *
 * Worked out from the descriptor rather than measured off the pixels: it is a
 * pure function a test can check, and it costs nothing at startup. The painter
 * keeps to it (see the rules in `sprite-painter.ts`) and the baker clips each
 * cell to it, so a drawing that strays is cut off visibly rather than bleeding
 * into its neighbour.
 */
export function spriteExtent(sprite: SpriteDescriptor): Extent {
  const m = EXTENT_MARGIN;
  switch (sprite.kind) {
    case 'machine': {
      const shadow = sprite.bulk * LIFT_TILES * SHADOW_SLANT;
      const hw = sprite.width / 2;
      const hh = sprite.height / 2;
      return { left: hw + m, right: hw + shadow + m, up: hh + sprite.bulk * LIFT_TILES + m, down: hh + shadow + m };
    }
    case 'splitter': {
      const across = sprite.rotation === 1 || sprite.rotation === 3;
      const hw = across ? 0.5 : 1;
      const hh = across ? 1 : 0.5;
      return { left: hw + m, right: hw + m, up: hh + 0.32 * LIFT_TILES + m, down: hh + m };
    }
    case 'underground':
      return { left: 0.5 + m, right: 0.5 + m, up: 0.5 + 0.42 * LIFT_TILES + m, down: 0.5 + m };
    case 'inserter':
      return inserterExtent(sprite.rotation);
    case 'item':
      return { left: 0.2 + m, right: 0.22 + m, up: 0.28 + m, down: 0.22 + m };
    case 'player':
      // The figure at `PLAYER_SCALE`: a pick swung forward reaches 0.56 tiles,
      // and a pick raised over the helmet 0.98 tiles up the screen.
      return { left: 0.58 + m, right: 0.58 + m, up: 1.02 + m, down: 0.58 + m };
    case 'belt':
    case 'face':
    case 'resource':
    case 'missing':
      return { left: 0.5 + m, right: 0.5 + m, up: 0.5 + m, down: 0.5 + m };
  }
}

/**
 * An inserter reaches 0.65 tiles along its facing, either way, and stands up
 * to 1.1 tiles tall at the top of its swing. Across the facing it is only as
 * wide as its base. Rotation-aware, because a square box around every arm
 * position would make these a third of the whole atlas.
 */
function inserterExtent(rotation: Rotation): Extent {
  const m = EXTENT_MARGIN;
  const along = 0.66;
  const across = 0.3;
  const northSouth = rotation === 0 || rotation === 2;
  const side = northSouth ? across : along;
  return { left: side + m, right: side + m, up: (northSouth ? along : across) + 0.85 + m, down: (northSouth ? along : across) + m };
}

/* -------------------------------------------------------------------------- *
 * Packing
 * -------------------------------------------------------------------------- */

/** Transparent pixels between cells, so a scaled copy never samples a neighbour. */
export const ATLAS_GUTTER = 2;

export interface PackResult {
  readonly positions: readonly { readonly x: number; readonly y: number }[];
  readonly width: number;
  readonly height: number;
}

/**
 * Shelf packing: tallest first, left to right, a new shelf when a row is full.
 *
 * Not optimal and does not need to be. The sprites come in a few dozen sizes
 * with long runs of identical ones — sixty-eight inserter arms, thirty-two
 * belt phases — and shelves waste little on inputs like that. Positions come
 * back in the input's order; the sort is stable, so the layout is too.
 */
export function packShelves(sizes: readonly { readonly w: number; readonly h: number }[], maxWidth: number): PackResult {
  const order = sizes.map((_size, index) => index);
  order.sort((a, b) => (sizes[b]?.h ?? 0) - (sizes[a]?.h ?? 0) || (sizes[b]?.w ?? 0) - (sizes[a]?.w ?? 0) || a - b);

  const positions: { x: number; y: number }[] = sizes.map(() => ({ x: 0, y: 0 }));
  let x = 0;
  let y = 0;
  let shelf = 0;
  let width = 0;
  for (const index of order) {
    const size = sizes[index];
    if (size === undefined) continue;
    if (size.w > maxWidth) throw new RangeError(`packShelves: a ${size.w}px cell does not fit a ${maxWidth}px sheet.`);
    if (x > 0 && x + size.w > maxWidth) {
      y += shelf + ATLAS_GUTTER;
      x = 0;
      shelf = 0;
    }
    positions[index] = { x, y };
    x += size.w + ATLAS_GUTTER;
    shelf = Math.max(shelf, size.h);
    width = Math.max(width, x - ATLAS_GUTTER);
  }
  return { positions, width, height: y + shelf };
}

/**
 * Lay out one level: a cell per id, sized by its extent at `scale`.
 *
 * Pure — no canvas — so the descriptor is testable in Node and a baked sheet
 * and a hand-drawn one are described by the same function. Ids that parse to
 * nothing are skipped: the atlas draws the marker for them live.
 */
export function layoutLevel(spec: LevelSpec): AtlasLevel {
  const ids: SpriteId[] = [];
  const sizes: { w: number; h: number; ax: number; ay: number }[] = [];
  const tileW = EAST_STEP.x * spec.scale;
  const tileH = SOUTH_STEP.y * spec.scale;
  let area = 0;

  for (const id of new Set(spec.ids)) {
    const sprite = describeSprite(id);
    if (sprite.kind === 'missing') continue;
    const extent = spriteExtent(sprite);
    const ax = Math.ceil(extent.left * tileW) + 1;
    const ay = Math.ceil(extent.up * tileH) + 1;
    const w = ax + Math.ceil(extent.right * tileW) + 1;
    const h = ay + Math.ceil(extent.down * tileH) + 1;
    ids.push(id);
    sizes.push({ w, h, ax, ay });
    area += (w + ATLAS_GUTTER) * (h + ATLAS_GUTTER);
  }

  // Roughly square, so neither side runs into a browser's canvas limit.
  const widest = sizes.reduce((max, size) => Math.max(max, size.w), 1);
  const maxWidth = Math.max(widest, Math.ceil(Math.sqrt(area * 1.15)));
  const packed = packShelves(sizes, maxWidth);

  const cells: Record<SpriteId, AtlasCell> = {};
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const size = sizes[i];
    const at = packed.positions[i];
    if (id === undefined || size === undefined || at === undefined) continue;
    cells[id] = { x: at.x, y: at.y, w: size.w, h: size.h, ax: size.ax, ay: size.ay };
  }
  return { scale: spec.scale, detail: spec.detail, width: Math.max(1, packed.width), height: Math.max(1, packed.height), cells };
}

/* -------------------------------------------------------------------------- *
 * Baking
 * -------------------------------------------------------------------------- */

/** An offscreen canvas and the image to copy from it. Injected; see main.ts. */
export interface AtlasSurface {
  readonly ctx: CanvasRenderingContext2D;
  readonly image: CanvasImageSource;
}

export type AtlasSurfaceFactory = (width: number, height: number) => AtlasSurface;

/** Lay out every level. Pure; the descriptor a baked atlas is drawn from. */
export function layoutAtlas(specs: readonly LevelSpec[]): AtlasDescriptor {
  return { format: 'ironflow-atlas', version: 1, levels: specs.map(layoutLevel) };
}

/**
 * Paint one level's sprites onto a surface of its size. Browser only.
 *
 * Each sprite is clipped to its own cell, so a painting that overreaches its
 * extent is cut off where it would otherwise have bled into its neighbour.
 */
export function paintLevel(level: AtlasLevel, createSurface: AtlasSurfaceFactory): CanvasImageSource {
  const surface = createSurface(level.width, level.height);
  const ctx = surface.ctx;
  for (const id of Object.keys(level.cells)) {
    const cell = level.cells[id];
    if (cell === undefined) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(cell.x, cell.y, cell.w, cell.h);
    ctx.clip();
    paintSprite(ctx, describeSprite(id), cell.x + cell.ax, cell.y + cell.ay, level.scale, level.detail);
    ctx.restore();
  }
  return surface.image;
}

/**
 * Where a level's image comes from, asked the first time the level is drawn.
 *
 * Lazy because the levels are not equally needed: the 2x one is about three
 * quarters of the atlas — forty megabytes of canvas — and a 1x display only
 * draws from it zoomed past 1. A baked atlas paints the level when asked
 * (`paintLevel`); a painted sheet would return its already-loaded image.
 */
export type LevelImageSource = (level: AtlasLevel, index: number) => CanvasImageSource;

/** A baked atlas's image source: paint each level on first use. */
export function bakedLevels(createSurface: AtlasSurfaceFactory): LevelImageSource {
  return (level) => paintLevel(level, createSurface);
}

/* -------------------------------------------------------------------------- *
 * The atlas
 * -------------------------------------------------------------------------- */

interface LiveLevel {
  readonly index: number;
  readonly level: AtlasLevel;
  readonly scale: number;
  readonly detail: boolean;
  /** Null until the level is first drawn from. */
  image: CanvasImageSource | null;
  readonly cells: ReadonlyMap<SpriteId, AtlasCell>;
}

export class ImageAtlas implements SpriteAtlas {
  readonly kind = 'image' as const;

  /** Ascending by scale, the detailed ones and the plain ones kept apart. */
  private readonly detailed: readonly LiveLevel[];
  private readonly plain: readonly LiveLevel[];
  private readonly fallback: SpriteAtlas;
  private pixelRatio = 1;

  /** The level chosen for the last zoom asked about. A frame asks about one. */
  private lastZoom = Number.NaN;
  private lastLevel: LiveLevel | null = null;

  private readonly source: LevelImageSource;

  /** Levels whose image has been made, in the order they were first needed. */
  readonly loaded: number[] = [];

  constructor(descriptor: AtlasDescriptor, source: LevelImageSource, fallback: SpriteAtlas) {
    const live: LiveLevel[] = descriptor.levels.map((level, index) => ({
      index,
      level,
      scale: level.scale,
      detail: level.detail,
      image: null,
      cells: new Map(Object.entries(level.cells)),
    }));
    live.sort((a, b) => a.scale - b.scale);
    this.detailed = live.filter((level) => level.detail);
    this.plain = live.filter((level) => !level.detail);
    this.source = source;
    this.fallback = fallback;
  }

  /**
   * Make the image for the level `zoom` draws from, now rather than on the
   * frame that first needs it. The composition root calls it at startup for
   * the zoom the game opens at, so the first frame does not pay for it.
   */
  prepare(zoom: number): void {
    const level = this.pick(zoom);
    if (level !== null) this.imageOf(level);
  }

  /**
   * Device pixels per CSS pixel. The renderer draws in CSS pixels, so what a
   * sprite needs is `zoom * ratio` pixels of image per world pixel; without
   * this a 2x display would draw every sprite from a level half as sharp as
   * the screen. The composition root calls it on resize.
   */
  setPixelRatio(ratio: number): void {
    if (!(ratio > 0) || ratio === this.pixelRatio) return;
    this.pixelRatio = ratio;
    this.lastZoom = Number.NaN;
  }

  /** The level `zoom` draws from, or null to paint live. Exported for tests. */
  levelFor(zoom: number): { readonly scale: number; readonly detail: boolean } | null {
    const level = this.pick(zoom);
    return level === null ? null : { scale: level.scale, detail: level.detail };
  }

  draw(ctx: CanvasRenderingContext2D, id: SpriteId, sx: number, sy: number, zoom: number): void {
    const level = this.pick(zoom);
    const cell = level?.cells.get(id);
    if (level === null || cell === undefined) {
      this.fallback.draw(ctx, id, sx, sy, zoom);
      return;
    }
    const image = this.imageOf(level);
    const k = zoom / level.scale;
    let dx = sx - cell.ax * k;
    let dy = sy - cell.ay * k;
    // A level drawn at exactly its own size is a pixel copy; snapping it to
    // the device grid keeps it one. A scaled copy is filtered anyway.
    if (level.scale === zoom * this.pixelRatio) {
      dx = Math.round(dx * this.pixelRatio) / this.pixelRatio;
      dy = Math.round(dy * this.pixelRatio) / this.pixelRatio;
    }
    ctx.drawImage(image, cell.x, cell.y, cell.w, cell.h, dx, dy, cell.w * k, cell.h * k);
  }

  private imageOf(level: LiveLevel): CanvasImageSource {
    if (level.image === null) {
      level.image = this.source(level.level, level.index);
      this.loaded.push(level.index);
    }
    return level.image;
  }

  private pick(zoom: number): LiveLevel | null {
    if (zoom === this.lastZoom) return this.lastLevel;
    const needed = zoom * this.pixelRatio;
    const levels = zoom < DETAIL_ZOOM && this.plain.length > 0 ? this.plain : this.detailed;
    let chosen: LiveLevel | null = null;
    for (const level of levels) {
      if (level.scale >= needed - 1e-6) {
        chosen = level;
        break;
      }
    }
    // Past the largest plain level, the largest one still beats painting:
    // below `DETAIL_ZOOM` a sprite is small whatever the display.
    if (chosen === null && levels === this.plain) chosen = levels[levels.length - 1] ?? null;
    this.lastZoom = zoom;
    this.lastLevel = chosen;
    return chosen;
  }
}
