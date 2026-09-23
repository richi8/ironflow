/**
 * The terrain layer and its world-chunk cache. See ironflow.md C03 task 4.
 *
 * Terrain is 1,024 filled paths per world chunk and a screenful of world
 * chunks every frame. §18 risk 6 names Canvas 2D fill rate at zoom-out as the
 * first thing to break, and says the mitigation is chunk caching **from C03,
 * not retrofitted** — so each world chunk is drawn once into an offscreen
 * canvas and blitted from then on.
 *
 * Three things make that correct rather than merely fast:
 *
 * 1. **The cache key includes a zoom bucket.** A bitmap drawn at one scale and
 *    blitted at a very different one is mush. Buckets are powers of the
 *    camera's zoom step, so a wheel notch lands exactly on one and the common
 *    case blits at 1:1.
 * 2. **Entries are stamped with the world chunk's revision**, not its `dirty`
 *    flag. `dirty` latches on the first divergence and never clears (§14), so
 *    a cache keyed on it goes stale the second time a tile changes.
 * 3. **Cold world chunks are drawn directly, clipped to the viewport.** Only a
 *    few bitmaps are built per frame, so arriving somewhere new costs a few
 *    hundred extra paths rather than a fifty-world-chunk stall.
 *
 * Ore is drawn here too, over the terrain face and into the same bitmap (C09
 * task 3). It belongs in this layer and not in the entity layer because a
 * resource patch is not an entity — it is two arrays inside the world chunk
 * (C09 task 1) — and caching it costs nothing extra: mining bumps the world
 * chunk's `revision`, which is already the cache's staleness signal, so a
 * depleting patch redraws itself for free.
 */

import { CHUNK_SIZE, chunkKey } from '../../game/world/chunk.js';
import type { TileBounds } from '../../game/world/coordinates.js';
import { ResourceType } from '../../game/world/resource.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, type Camera } from '../camera.js';
import { tileToScreen } from '../projection.js';
import type { ReadonlyWorldChunk, WorldView } from '../render-state.js';
import {
  TILE_HALF_HEIGHT,
  TILE_HALF_WIDTH,
  resourceSprite,
  terrainVariantSprite,
  type SpriteAtlas,
  type SpriteId,
} from '../sprite-atlas.js';

/* -------------------------------------------------------------------------- *
 * Zoom buckets
 * -------------------------------------------------------------------------- */

/**
 * Nudge applied before rounding a bucket index up.
 *
 * `log(1.2) / log(1.2)` is not exactly 1 in binary floating point, and without
 * this a zoom sitting exactly on a bucket would sometimes round to the next one
 * and rebuild every bitmap in the cache for no visible change.
 */
const BUCKET_EPSILON = 1e-9;

/** The bucket a zoom level falls in. Monotonic in `zoom`. */
export function zoomBucketIndex(zoom: number): number {
  return Math.ceil(Math.log(zoom) / Math.log(ZOOM_STEP) - BUCKET_EPSILON);
}

/**
 * The scale a bucket's bitmaps are drawn at.
 *
 * Always at least the zoom that chose it, so blitting is a downscale. Upscaling
 * a cached bitmap is what makes cached terrain look softer than direct-drawn
 * terrain, and the difference is exactly the kind of thing that reads as "the
 * renderer is broken at some zoom levels".
 */
export function zoomBucketScale(index: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.pow(ZOOM_STEP, index)));
}

/* -------------------------------------------------------------------------- *
 * The cache
 * -------------------------------------------------------------------------- */

/**
 * An LRU of per-world-chunk bitmaps, bounded by count **and** by pixels.
 *
 * C03 says "at most ~64 world chunks". Count alone is the wrong bound: a
 * world chunk's bitmap is 512x256 at the minimum zoom and 2048x1024 at zoom 1,
 * a factor of sixteen in memory, so 64 entries is 32 MB in one case and 512 MB
 * in the other. The entry cap is kept as a coarse ceiling and a pixel budget
 * added under it; whichever binds first, binds.
 *
 * Generic over the value so the eviction and staleness rules can be tested in
 * a Node process, where there is no canvas to put in it.
 */
export interface TerrainCacheOptions<T> {
  readonly maxEntries: number;
  readonly maxPixels: number;
  /** Called when an entry leaves the cache, to release its backing store. */
  readonly dispose?: (value: T) => void;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly revision: number;
  readonly pixels: number;
}

export class TerrainCache<T> {
  /**
   * Insertion-ordered, and read in that order to find the oldest entry.
   *
   * §6 R4 forbids iterating a `Map` in a *simulation system*, because insertion
   * order is not reproducible across a save/load. This is the renderer: nothing
   * here is persisted, nothing here is replayed, and least-recently-used is the
   * one thing insertion order is genuinely good for.
   */
  private readonly entries = new Map<number, CacheEntry<T>>();
  private readonly options: TerrainCacheOptions<T>;
  private pixelCount = 0;

  constructor(options: TerrainCacheOptions<T>) {
    this.options = options;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Total backing-store pixels currently held. */
  get pixels(): number {
    return this.pixelCount;
  }

  /**
   * The cached bitmap for a world chunk at a zoom bucket, if it is still valid.
   *
   * A revision mismatch drops the entry rather than returning it: the caller is
   * about to rebuild it, and keeping a known-stale bitmap in an LRU only means
   * evicting something useful to make room for it.
   */
  get(cx: number, cy: number, bucket: number, revision: number): T | undefined {
    const key = cacheKey(cx, cy, bucket);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    if (entry.revision !== revision) {
      this.remove(key, entry);
      return undefined;
    }

    // Re-insert to mark it as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(cx: number, cy: number, bucket: number, revision: number, value: T, pixels: number): void {
    const key = cacheKey(cx, cy, bucket);
    const existing = this.entries.get(key);
    if (existing !== undefined) this.remove(key, existing);

    this.entries.set(key, { value, revision, pixels });
    this.pixelCount += pixels;
    this.evictWhileOverBudget();
  }

  clear(): void {
    for (const entry of this.entries.values()) this.options.dispose?.(entry.value);
    this.entries.clear();
    this.pixelCount = 0;
  }

  private evictWhileOverBudget(): void {
    while (this.entries.size > this.options.maxEntries || this.pixelCount > this.options.maxPixels) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) return;
      const entry = this.entries.get(oldest.value);
      if (entry === undefined) return;
      // Never evict the entry just inserted, or a single oversized bitmap would
      // spin here throwing itself away.
      if (this.entries.size === 1) return;
      this.remove(oldest.value, entry);
    }
  }

  private remove(key: number, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.pixelCount -= entry.pixels;
    this.options.dispose?.(entry.value);
  }
}

/**
 * Pack world-chunk coordinates and a zoom bucket into one numeric key.
 *
 * `chunkKey` already packs the coordinates into 22 bits and range-checks them;
 * the bucket fits in six. A `${cx},${cy},${b}` string would allocate once per
 * visible world chunk per frame for no benefit.
 */
function cacheKey(cx: number, cy: number, bucket: number): number {
  return chunkKey(cx, cy) * BUCKET_SLOTS + (bucket + BUCKET_OFFSET);
}

const BUCKET_SLOTS = 64;
const BUCKET_OFFSET = 32;

/* -------------------------------------------------------------------------- *
 * Offscreen surfaces
 * -------------------------------------------------------------------------- */

export interface TerrainSurface {
  readonly ctx: CanvasRenderingContext2D;
  readonly image: CanvasImageSource;
  readonly width: number;
  readonly height: number;
  /** Release the backing store. A canvas kept at its full size never shrinks. */
  release(): void;
}

export type SurfaceFactory = (width: number, height: number) => TerrainSurface;

/** The browser implementation. Injected, so the cache is testable without one. */
export function createDomSurface(width: number, height: number): TerrainSurface {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('IronFlow: could not acquire an offscreen 2D context.');
  return {
    ctx,
    image: canvas,
    width,
    height,
    release: () => {
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

/* -------------------------------------------------------------------------- *
 * The layer
 * -------------------------------------------------------------------------- */

/** Coarse ceiling on cached world chunks; the pixel budget usually binds first. */
const MAX_CACHE_ENTRIES = 96;

/** ~128 MB of backing store at four bytes a pixel. */
const MAX_CACHE_PIXELS = 32_000_000;

/**
 * Above this a world chunk's bitmap is not worth building.
 *
 * At zoom 2 a world chunk is 3072 square, and a 1080p viewport holds a fifth of
 * one — the cache would spend 36 MB to avoid drawing the ~200 tiles that are
 * actually on screen. Direct drawing is cheap at high zoom for exactly the
 * reason caching is necessary at low zoom: visible tile count scales with
 * `1 / zoom^2`.
 */
const MAX_SURFACE_PIXELS = 8_000_000;

/** Bitmaps built per frame. Arriving somewhere new should cost a frame, not a stall. */
const MAX_BUILDS_PER_FRAME = 8;

/**
 * Transparent margin around each bitmap, in bitmap pixels.
 *
 * The face outlines drawn by the atlas overhang the geometric edge of the world
 * chunk by half a line width, and blit positions are snapped to whole device
 * pixels (§5 hazard 3), which can move a bitmap by up to half a pixel relative
 * to its neighbour. Two pixels of slack absorbs both.
 *
 * C27A did not make this unnecessary, although it is tempting to think a
 * square grid would: the seam is an antialiasing artefact of adjacent fills
 * and a rounding artefact of the blit, and neither cares what shape the tiles
 * are.
 */
const SURFACE_PAD = 2;

export interface TerrainStats {
  /** Bitmaps currently cached. */
  readonly cached: number;
  /** Backing-store pixels currently held. */
  readonly pixels: number;
  /** Bitmaps built during the last frame. */
  readonly built: number;
  /** World chunks drawn without a bitmap during the last frame. */
  readonly direct: number;
  /** World chunks drawn at all during the last frame, either way (C28's overlay). */
  readonly visible: number;
}

export interface TerrainLayerOptions {
  readonly atlas: SpriteAtlas;
  readonly createSurface?: SurfaceFactory;
}

export class TerrainLayer {
  private readonly atlas: SpriteAtlas;
  private readonly createSurface: SurfaceFactory;
  private readonly cache: TerrainCache<TerrainSurface>;

  private built = 0;
  private direct = 0;
  private visible = 0;

  constructor(options: TerrainLayerOptions) {
    this.atlas = options.atlas;
    this.createSurface = options.createSurface ?? createDomSurface;
    this.cache = new TerrainCache<TerrainSurface>({
      maxEntries: MAX_CACHE_ENTRIES,
      maxPixels: MAX_CACHE_PIXELS,
      dispose: (surface) => surface.release(),
    });
  }

  getStats(): TerrainStats {
    return {
      cached: this.cache.size,
      pixels: this.cache.pixels,
      built: this.built,
      direct: this.direct,
      visible: this.visible,
    };
  }

  /**
   * Drop every cached bitmap (C25).
   *
   * Loading a save replaces the `World`, and a cache entry is keyed by
   * `(cx, cy, zoom bucket, revision)` — three of which the new world reuses
   * from tile one. A world chunk that has never been mined has revision 0 in
   * every world, so without this a loaded save would be drawn on the terrain
   * of the one it replaced until something happened to change a tile.
   */
  invalidate(): void {
    this.cache.clear();
  }

  destroy(): void {
    this.cache.clear();
  }

  /**
   * Draw every world chunk overlapping `bounds`.
   *
   * `bounds` is the padded cull rectangle, so this is also what pulls new world
   * chunks into existence as the player moves — see `WorldView`.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    world: WorldView,
    camera: Camera,
    bounds: TileBounds,
    dpr: number,
  ): void {
    this.built = 0;
    this.direct = 0;
    this.visible = 0;

    const zoom = camera.zoom;
    const bucket = zoomBucketIndex(zoom);
    const scale = zoomBucketScale(bucket);
    const surfaceSize = surfacePixels(scale);

    world.forEachChunkInBounds(bounds, (chunk) => {
      this.visible += 1;
      if (surfaceSize > MAX_SURFACE_PIXELS) {
        this.drawDirect(ctx, chunk, camera, bounds, zoom);
        return;
      }

      const cached = this.cache.get(chunk.cx, chunk.cy, bucket, chunk.revision);
      if (cached !== undefined) {
        this.blit(ctx, chunk, camera, cached, zoom / scale, dpr);
        return;
      }

      if (this.built >= MAX_BUILDS_PER_FRAME) {
        this.drawDirect(ctx, chunk, camera, bounds, zoom);
        return;
      }

      const surface = this.build(chunk, scale);
      this.cache.set(chunk.cx, chunk.cy, bucket, chunk.revision, surface, surface.width * surface.height);
      this.blit(ctx, chunk, camera, surface, zoom / scale, dpr);
    });
  }

  /** Render one world chunk's terrain into a fresh offscreen bitmap. */
  private build(chunk: ReadonlyWorldChunk, scale: number): TerrainSurface {
    const width = Math.ceil(CHUNK_SIZE * TILE_HALF_WIDTH * 2 * scale) + SURFACE_PAD * 2;
    const height = Math.ceil(CHUNK_SIZE * TILE_HALF_HEIGHT * 2 * scale) + SURFACE_PAD * 2;
    const surface = this.createSurface(width, height);

    const tileX0 = chunk.cx * CHUNK_SIZE;
    const tileY0 = chunk.cy * CHUNK_SIZE;
    // The bitmap's top-left corner in world-pixel space, which since C27A is
    // simply the world chunk's north-west tile: the projection is a scale, so
    // the block of tiles and the block of pixels have the same corners.
    const origin = tileToScreen(tileX0, tileY0);
    const originX = origin.x;
    const originY = origin.y;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const index = ly * CHUNK_SIZE + lx;
        const terrain = chunk.terrain[index];
        if (terrain === undefined) continue;
        const centre = tileToScreen(tileX0 + lx + 0.5, tileY0 + ly + 0.5);
        const sx = (centre.x - originX) * scale + SURFACE_PAD;
        const sy = (centre.y - originY) * scale + SURFACE_PAD;
        this.atlas.draw(surface.ctx, terrainVariantSprite(terrain, tileVariant(tileX0 + lx, tileY0 + ly)), sx, sy, scale);

        const ore = oreSprite(chunk, index);
        if (ore !== null) this.atlas.draw(surface.ctx, ore, sx, sy, scale);
      }
    }

    this.built += 1;
    return surface;
  }

  /**
   * Blit a cached bitmap, snapped to whole device pixels.
   *
   * §5 hazard 3: the camera position stays fractional, but the final translate
   * does not — a bitmap landing on a half pixel is resampled, and resampling a
   * tiling of faces puts a visible seam along every edge of it.
   */
  private blit(
    ctx: CanvasRenderingContext2D,
    chunk: ReadonlyWorldChunk,
    camera: Camera,
    surface: TerrainSurface,
    relativeScale: number,
    dpr: number,
  ): void {
    const tileX0 = chunk.cx * CHUNK_SIZE;
    const tileY0 = chunk.cy * CHUNK_SIZE;
    const corner = camera.worldToScreen(tileX0, tileY0);
    const far = camera.worldToScreen(tileX0 + CHUNK_SIZE, tileY0 + CHUNK_SIZE);

    // Both corners of the world chunk are snapped, and the scale is whatever
    // maps the one onto the other. Snapping the position and the size apart —
    // which is what this did until C29 — lets a scaled bitmap's content end up
    // to half a pixel short of where its neighbour's snapped content begins,
    // and the background showed through as a line along every world-chunk edge
    // at most zooms. Sharing the snapped corner makes the two edges one edge.
    const left = snapToDevicePixel(corner.x, dpr);
    const top = snapToDevicePixel(corner.y, dpr);
    // The world chunk's extent in bitmap pixels. Not the bitmap's width less
    // its padding: that was rounded up when the bitmap was made.
    const contentW = (far.x - corner.x) / relativeScale;
    const contentH = (far.y - corner.y) / relativeScale;
    const sx = contentW > 0 ? (snapToDevicePixel(far.x, dpr) - left) / contentW : relativeScale;
    const sy = contentH > 0 ? (snapToDevicePixel(far.y, dpr) - top) / contentH : relativeScale;

    ctx.drawImage(surface.image, left - SURFACE_PAD * sx, top - SURFACE_PAD * sy, surface.width * sx, surface.height * sy);
  }

  /**
   * Draw a world chunk's terrain tile by tile, clipped to the visible bounds.
   *
   * The fallback for a world chunk with no bitmap yet. Clipping is what keeps
   * it affordable: the cost is bounded by the viewport, not by the 1,024 tiles
   * the world chunk contains.
   */
  private drawDirect(
    ctx: CanvasRenderingContext2D,
    chunk: ReadonlyWorldChunk,
    camera: Camera,
    bounds: TileBounds,
    zoom: number,
  ): void {
    const tileX0 = chunk.cx * CHUNK_SIZE;
    const tileY0 = chunk.cy * CHUNK_SIZE;
    const minX = Math.max(tileX0, bounds.minX);
    const maxX = Math.min(tileX0 + CHUNK_SIZE - 1, bounds.maxX);
    const minY = Math.max(tileY0, bounds.minY);
    const maxY = Math.min(tileY0 + CHUNK_SIZE - 1, bounds.maxY);

    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const index = (ty - tileY0) * CHUNK_SIZE + (tx - tileX0);
        const terrain = chunk.terrain[index];
        if (terrain === undefined) continue;
        const centre = camera.worldToScreen(tx + 0.5, ty + 0.5);
        this.atlas.draw(ctx, terrainVariantSprite(terrain, tileVariant(tx, ty)), centre.x, centre.y, zoom);

        const ore = oreSprite(chunk, index);
        if (ore !== null) this.atlas.draw(ctx, ore, centre.x, centre.y, zoom);
      }
    }

    this.direct += 1;
  }
}

/**
 * Which texture variant a tile is drawn with (C29). A hash of its position,
 * so a tile is always the same picture — in the cache and out of it, and in
 * every screenshot — and a field of grass does not repeat on a grid.
 */
export function tileVariant(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return h & 3;
}

/**
 * What to draw on one tile's ore, or `null` for bare or exhausted ground.
 *
 * Read straight out of the world chunk's arrays rather than through
 * `World.getResource`: this runs 1,024 times per bitmap, and the accessor would
 * redo the world-chunk lookup and the local-index arithmetic the caller has
 * already done. Both halves are checked, because a missing entry means the
 * arrays disagree in length, which is a bug that should draw nothing rather
 * than throw inside a draw loop.
 */
function oreSprite(chunk: ReadonlyWorldChunk, index: number): SpriteId | null {
  const resource = chunk.resource[index];
  const amount = chunk.resourceAmount[index];
  if (resource === undefined || amount === undefined || resource === ResourceType.None) return null;
  return resourceSprite(resource, amount);
}

/** Backing-store pixels one world-chunk bitmap costs at a given scale. */
function surfacePixels(scale: number): number {
  const width = CHUNK_SIZE * TILE_HALF_WIDTH * 2 * scale + SURFACE_PAD * 2;
  const height = CHUNK_SIZE * TILE_HALF_HEIGHT * 2 * scale + SURFACE_PAD * 2;
  return width * height;
}

/**
 * Round a CSS-pixel coordinate to a whole device pixel.
 *
 * The canvas transform maps CSS pixels to device pixels by `dpr`, so a whole
 * device pixel is a multiple of `1 / dpr` here.
 */
export function snapToDevicePixel(value: number, dpr: number): number {
  if (!(dpr > 0)) return value;
  return Math.round(value * dpr) / dpr;
}
