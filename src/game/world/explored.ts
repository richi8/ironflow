/**
 * Which world chunks the player has seen. See ironflow.md §14 and C23 task 5.
 *
 * §14's persisted list is "the set of world chunks the player has explored
 * (for map/fog)", and §10 puts it in the **authoritative** column: it is not
 * recomputable from anything else, because "I walked past here an hour ago"
 * leaves no other trace. A world chunk full of grass the player has crossed
 * and one they have never approached are byte-identical; only this says which
 * is which.
 *
 * ## Why it is a set of keys and not a flag on the world chunk
 *
 * A flag would be simpler and would be wrong in both directions. Reading a
 * tile **generates** a world chunk (`world.ts`), and the renderer reads every
 * tile it is about to draw — so a flag living on `WorldChunk` would be set by
 * the act of looking at the map, and a radar would have to generate the
 * hundred world chunks it reveals in order to mark them. This set holds
 * `chunkKey`s and nothing else: revealing ground costs one integer and does
 * not bring a world chunk into existence.
 *
 * ## Iteration order
 *
 * §6 R4: a `Set` iterates in insertion order, which after a load is the order
 * the save happened to list keys in rather than the order the player walked.
 * So `forEach` sorts, exactly as `World.forEachLoadedChunk` does and for the
 * same reason — the map panel and C24's serializer must both see one order.
 * Sorting is why this is not a hot path and is not meant to be: it is asked
 * once when a panel opens, not once a tick.
 */

import { CHUNK_MAX, CHUNK_MIN, chunkKey, toChunkCoord } from './chunk.js';

/** Inclusive world-chunk bounds. `maxCx < minCx` means nothing is explored. */
export interface ChunkBounds {
  readonly minCx: number;
  readonly minCy: number;
  readonly maxCx: number;
  readonly maxCy: number;
}

/** The bounds of an empty set: deliberately inverted, so nothing loops. */
export const NO_CHUNK_BOUNDS: ChunkBounds = Object.freeze({ minCx: 0, minCy: 0, maxCx: -1, maxCy: -1 });

export class ExploredChunks {
  private readonly keys = new Set<number>();

  /** Tracked as the set grows, so the map panel need not scan to find them. */
  private minCx = 0;
  private minCy = 0;
  private maxCx = -1;
  private maxCy = -1;

  /** How many world chunks have been explored. */
  get size(): number {
    return this.keys.size;
  }

  /**
   * Mark a world chunk explored. Returns whether this was the first time.
   *
   * The answer matters to the caller: an exploration step that reveals nothing
   * new is one that need not touch anything else, and it is how a test says
   * "the radar has finished its coverage".
   */
  reveal(cx: number, cy: number): boolean {
    const key = chunkKey(cx, cy);
    if (this.keys.has(key)) return false;
    this.keys.add(key);

    if (this.keys.size === 1) {
      this.minCx = cx;
      this.maxCx = cx;
      this.minCy = cy;
      this.maxCy = cy;
      return true;
    }
    if (cx < this.minCx) this.minCx = cx;
    if (cx > this.maxCx) this.maxCx = cx;
    if (cy < this.minCy) this.minCy = cy;
    if (cy > this.maxCy) this.maxCy = cy;
    return true;
  }

  /**
   * Mark every world chunk in a square of `radius` around `(cx, cy)`.
   * Returns how many were new.
   *
   * A square rather than a disc, because the map is drawn as a grid of world
   * chunks and a square edge is the only one whose coverage a player can judge
   * by eye — the argument `PoleProperties.supplyArea` already makes one
   * building over. Coordinates outside the packable range are skipped rather
   * than clamped: the edge of the world is not explorable ground.
   */
  revealSquare(cx: number, cy: number, radius: number): number {
    let revealed = 0;
    for (let y = cy - radius; y <= cy + radius; y++) {
      if (y < CHUNK_MIN || y > CHUNK_MAX) continue;
      for (let x = cx - radius; x <= cx + radius; x++) {
        if (x < CHUNK_MIN || x > CHUNK_MAX) continue;
        if (this.reveal(x, y)) revealed += 1;
      }
    }
    return revealed;
  }

  /** Has this world chunk been explored? */
  has(cx: number, cy: number): boolean {
    return this.keys.has(chunkKey(cx, cy));
  }

  /** Has the world chunk containing this tile been explored? */
  hasTile(x: number, y: number): boolean {
    return this.has(toChunkCoord(x), toChunkCoord(y));
  }

  /** The rectangle of world chunks the set spans. Inverted while it is empty. */
  bounds(): ChunkBounds {
    if (this.keys.size === 0) return NO_CHUNK_BOUNDS;
    return { minCx: this.minCx, minCy: this.minCy, maxCx: this.maxCx, maxCy: this.maxCy };
  }

  /** Every explored world chunk's packed key, ascending. See the file header. */
  keysAscending(): readonly number[] {
    return [...this.keys].sort((a, b) => a - b);
  }

  /**
   * Replace the whole set. For C24's load, and for a test that wants a world
   * already explored.
   *
   * Every key is validated, because this is one of the two doors untrusted
   * data comes through (§14): a key outside the packable range would alias a
   * world chunk somewhere else entirely, and a non-integer would make the map
   * panel draw at a fractional cell for ever.
   */
  restore(keys: Iterable<number>): void {
    this.keys.clear();
    this.minCx = 0;
    this.minCy = 0;
    this.maxCx = -1;
    this.maxCy = -1;

    for (const key of keys) {
      const coords = unpackChunkKey(key);
      if (coords === null) {
        throw new RangeError(`ExploredChunks.restore: ${key} is not a world-chunk key.`);
      }
      this.reveal(coords.cx, coords.cy);
    }
  }
}

/** Bias and shift mirroring `chunkKey`. See `chunk.ts` for why it packs at all. */
const CHUNK_KEY_BIAS = 0 - CHUNK_MIN;
const CHUNK_KEY_SHIFT = 11;
const CHUNK_KEY_MASK = (1 << CHUNK_KEY_SHIFT) - 1;

/**
 * The world-chunk coordinates a packed key names, or null if it names none.
 *
 * The inverse of `chunkKey`, and it lives here rather than in `chunk.ts`
 * because this is the only thing that ever has a key without the coordinates
 * that made it: everything else packs one and throws it away.
 */
export function unpackChunkKey(key: number): { readonly cx: number; readonly cy: number } | null {
  if (!Number.isInteger(key) || key < 0) return null;
  const cx = (key >> CHUNK_KEY_SHIFT) - CHUNK_KEY_BIAS;
  const cy = (key & CHUNK_KEY_MASK) - CHUNK_KEY_BIAS;
  if (cx < CHUNK_MIN || cx > CHUNK_MAX || cy < CHUNK_MIN || cy > CHUNK_MAX) return null;
  // A key with bits above the two fields is not one `chunkKey` could produce.
  return chunkKey(cx, cy) === key ? { cx, cy } : null;
}
