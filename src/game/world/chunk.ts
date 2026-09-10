/**
 * World-chunk storage. See ironflow.md C02 task 2.
 *
 * A world chunk is a 32×32 block of tiles held in flat typed arrays. It is
 * storage, not behaviour: it has no methods, and `World` is the only thing that
 * reads or writes it. Three parallel arrays rather than an array of tile
 * objects, because 1,600 world chunks of 1,024 tile objects is 1.6 M objects
 * for the garbage collector to walk, and this way it is 4,800 buffers.
 *
 * "Chunk" here always means a world chunk. Build chunks are `C00`–`C30`.
 */

import { TILE_MAX, TILE_MIN } from './coordinates.js';

/** Tiles along one edge of a world chunk. */
export const CHUNK_SIZE = 32;

/** Tiles in a world chunk. The length of every one of its arrays. */
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

/** The `resource` value meaning "this tile holds no ore". */
export const NO_RESOURCE = 0;

/** Largest remaining amount a resource tile can hold, from `Uint16Array`. */
export const MAX_RESOURCE_AMOUNT = 65535;

/**
 * A 32×32 block of world storage.
 *
 * The arrays are `readonly` as *references* — their contents are mutable, and
 * mutating them is the whole point. What is forbidden is swapping an array out
 * from under a renderer that cached it.
 */
export interface WorldChunk {
  readonly cx: number;
  readonly cy: number;
  /** `TileType` per tile, row-major. `CHUNK_AREA` bytes. */
  readonly terrain: Uint8Array;
  /** Resource type id per tile, `NO_RESOURCE` for none. `CHUNK_AREA` bytes. */
  readonly resource: Uint8Array;
  /** Remaining units on each resource tile. `CHUNK_AREA` entries. */
  readonly resourceAmount: Uint16Array;
  /**
   * Has anything in this world chunk diverged from what the generator produced?
   *
   * §14 saves the seed plus deltas, so a clean world chunk is regenerated on
   * load and never written to disk. Setting this wrongly is a save-corruption
   * bug in both directions: never set, and the player's mined-out patch comes
   * back full; always set, and the save is tens of megabytes.
   */
  dirty: boolean;
  /**
   * Bumped on every change to this world chunk's contents. Never persisted.
   *
   * `dirty` cannot answer "has this changed since I last drew it?": it latches
   * on the first divergence and never clears, because §14 needs it to mean
   * "must this world chunk be saved?". A cache keyed on `dirty` would therefore
   * go stale the moment a second tile changed. This counter is the separate
   * signal C02's closing note said C03 would need — the renderer's terrain
   * cache stores the revision it drew and rebuilds when the two differ.
   *
   * Derived, presentation-facing, and owned by `World`: nothing in `game/`
   * reads it, and the world chunk is still the only thing that knows when its
   * own bytes moved. Wrapping is not a concern — at one change per tick it
   * would take three million years to reach `Number.MAX_SAFE_INTEGER`.
   */
  revision: number;
}

/**
 * The world-chunk coordinate range, derived from the tile range `tileKey` packs.
 *
 * `Math.floor`, not truncation: the negative half of the world is the point of
 * this whole module.
 */
export const CHUNK_MIN = Math.floor(TILE_MIN / CHUNK_SIZE);
export const CHUNK_MAX = Math.floor(TILE_MAX / CHUNK_SIZE);

/** Bias mapping [CHUNK_MIN, CHUNK_MAX] onto [0, 2047], one 11-bit field. */
const CHUNK_KEY_BIAS = 0 - CHUNK_MIN;
const CHUNK_KEY_SHIFT = 11;

/**
 * Which world chunk a tile coordinate falls in, on one axis.
 *
 * `Math.floor(t / 32)`, never `t / 32 | 0`. Truncation rounds toward zero, so
 * tiles −1 through −31 would report world chunk 0 and collide with tiles 0..31
 * — the single most common bug in chunked worlds (C02 task 4), and one that
 * looks like "the world is mirrored across the origin" rather than like a
 * division bug. Tested directly.
 */
export function toChunkCoord(tile: number): number {
  return Math.floor(tile / CHUNK_SIZE);
}

/**
 * Where a tile sits inside its world chunk, on one axis. Always `[0, 31]`.
 *
 * `((t % 32) + 32) % 32`, because `%` in JavaScript keeps the sign of the
 * dividend: `-1 % 32` is `-1`, not `31`.
 */
export function toLocalCoord(tile: number): number {
  return ((tile % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/** Row-major index of a local tile position within a world chunk's arrays. */
export function localIndex(lx: number, ly: number): number {
  return ly * CHUNK_SIZE + lx;
}

/**
 * Pack a world-chunk coordinate into a `Map` key.
 *
 * Same reasoning as `tileKey` (see `coordinates.ts`): a small integer key stays
 * a tagged smi in V8 where a `${cx},${cy}` string would allocate, and the range
 * check is here because an out-of-range coordinate does not throw on its own —
 * it silently aliases a *different* world chunk and corrupts two places at once.
 */
export function chunkKey(cx: number, cy: number): number {
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    throw new RangeError(`chunkKey: world-chunk coordinates must be integers, got (${cx}, ${cy}).`);
  }
  if (cx < CHUNK_MIN || cx > CHUNK_MAX || cy < CHUNK_MIN || cy > CHUNK_MAX) {
    throw new RangeError(
      `chunkKey: (${cx}, ${cy}) is outside the packable range [${CHUNK_MIN}, ${CHUNK_MAX}].`,
    );
  }
  return (((cx + CHUNK_KEY_BIAS) << CHUNK_KEY_SHIFT) | (cy + CHUNK_KEY_BIAS)) | 0;
}

/**
 * An empty world chunk: all grass, no resources, clean.
 *
 * Generators build on this rather than allocating their own arrays, so the
 * array lengths are stated in exactly one place. Zero-filled is meaningful
 * here — `TileType.Grass` and `NO_RESOURCE` are both `0`.
 */
export function createChunk(cx: number, cy: number): WorldChunk {
  chunkKey(cx, cy); // range check; the key itself is the caller's business
  return {
    cx,
    cy,
    terrain: new Uint8Array(CHUNK_AREA),
    resource: new Uint8Array(CHUNK_AREA),
    resourceAmount: new Uint16Array(CHUNK_AREA),
    dirty: false,
    revision: 0,
  };
}
