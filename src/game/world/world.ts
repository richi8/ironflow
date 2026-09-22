/**
 * The sparse, unbounded world. See ironflow.md C02 task 3.
 *
 * The world is a `Map` of lazily created 32×32 world chunks. Nothing exists
 * until something asks about it: an unvisited region costs zero bytes, which is
 * what makes "unbounded" affordable and what makes §14's seed-plus-deltas save
 * possible in the first place.
 *
 * Authoritative state (§10), and the only mutable terrain in the game.
 */

import type { TileBounds } from './coordinates.js';
import {
  CHUNK_AREA,
  MAX_RESOURCE_AMOUNT,
  chunkKey,
  localIndex,
  toChunkCoord,
  toLocalCoord,
  type WorldChunk,
} from './chunk.js';
import { ExploredChunks } from './explored.js';
import { ResourceType, isResourceType } from './resource.js';
import { TileType, isTileType } from './tile.js';

/**
 * Produces the initial contents of a world chunk.
 *
 * Injected rather than owned, because the world must not care whether its
 * terrain comes from C19's noise, a test's fixed pattern, or a save being
 * rehydrated. C19 requires implementations to be **pure and positional**:
 * `generate(5, 5)` gives the same result whether it is the first world chunk
 * asked for or the thousandth. `World` cannot enforce that — but every bug it
 * causes looks like "the world changed when I walked away and came back".
 */
export type ChunkGenerator = (cx: number, cy: number) => WorldChunk;

/** Called for each world chunk overlapping a rectangle. */
export type ChunkVisitor = (chunk: WorldChunk) => void;

/**
 * Read a typed-array slot that is provably in range.
 *
 * `noUncheckedIndexedAccess` types every typed-array read as possibly
 * `undefined`, and `no-non-null-assertion` is a lint error, so the check is
 * written out. The branch is unreachable while `toLocalCoord` and `localIndex`
 * are correct — which is exactly why it throws instead of substituting a
 * default: a silent fallback here would turn an indexing bug into a world
 * quietly made of grass.
 */
function at(array: Uint8Array | Uint16Array, index: number): number {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`World: local index ${index} is outside [0, ${CHUNK_AREA}).`);
  }
  return value;
}

/**
 * Record that a world chunk's contents diverged from generator output.
 *
 * Two flags, one event, and they must never be set apart: `dirty` says "this
 * must be saved" (§14) and latches forever, `revision` says "this changed"
 * and keeps counting for the renderer's terrain cache. Every mutation below
 * goes through here so a future one cannot set one and forget the other.
 */
function markChanged(chunk: WorldChunk): void {
  chunk.dirty = true;
  chunk.revision += 1;
}

export class World {
  /**
   * World chunks by packed coordinate.
   *
   * Never iterated by a simulation system (§6 R4): `Map` iterates in insertion
   * order, which after a load is the order world chunks were deserialized, not
   * the order they were first touched. Every traversal in this file walks a
   * coordinate range instead.
   */
  private readonly chunks = new Map<number, WorldChunk>();

  /**
   * Which world chunks the player has seen (C23 task 5).
   *
   * Authoritative and persisted (§10, §14), and owned here because it is a
   * fact about the *world* rather than about any entity: a radar writes to it
   * and so do the player's own legs, and neither of those is where it could
   * live. It is deliberately not a flag on `WorldChunk` — see
   * `explored.ts`, which is also why revealing ground generates nothing.
   */
  readonly explored = new ExploredChunks();

  private readonly generate: ChunkGenerator;

  constructor(generate: ChunkGenerator) {
    this.generate = generate;
  }

  /** How many world chunks currently exist. Derived; useful for tests and §12. */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /**
   * The world chunk at `(cx, cy)`, generating it if this is the first touch.
   *
   * Every accessor below funnels through here, which is what makes "reading one
   * tile creates exactly one world chunk" true by construction rather than by
   * discipline.
   */
  getChunk(cx: number, cy: number): WorldChunk {
    const key = chunkKey(cx, cy);
    const existing = this.chunks.get(key);
    if (existing !== undefined) return existing;

    const created = this.generate(cx, cy);
    if (created.cx !== cx || created.cy !== cy) {
      throw new Error(
        `World: generator returned world chunk (${created.cx}, ${created.cy}) when asked for (${cx}, ${cy}).`,
      );
    }
    if (
      created.terrain.length !== CHUNK_AREA ||
      created.resource.length !== CHUNK_AREA ||
      created.resourceAmount.length !== CHUNK_AREA
    ) {
      throw new Error(`World: generator returned world chunk (${cx}, ${cy}) with wrong array lengths.`);
    }

    this.chunks.set(key, created);
    return created;
  }

  /**
   * The world chunk at `(cx, cy)` if it already exists, without creating it.
   *
   * For anything that must not have side effects on the world: the debug
   * readout, tests that count creations, and later the save serializer, which
   * would otherwise generate the entire explored map while trying to write it.
   */
  peekChunk(cx: number, cy: number): WorldChunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
  }

  /**
   * What the generator would produce for `(cx, cy)`, without storing it. C24.
   *
   * §14 saves the seed and the deltas, so the serializer has to answer "how
   * does this world chunk differ from the one the generator would make?" — and
   * the only thing that knows how to make that world chunk is the generator
   * this world was constructed with. Handing the generator to the serializer
   * instead would put a second reference to it in the composition root, and a
   * save written against a *different* generator than the world is running on
   * is the one bug this whole file cannot survive.
   *
   * The result is deliberately **not** cached and **not** inserted: it is a
   * throwaway reference copy, and a world chunk that exists only because
   * something asked what it used to look like would change `chunkCount` — and
   * therefore what the next save writes — by the act of saving.
   */
  pristineChunk(cx: number, cy: number): WorldChunk {
    const created = this.generate(cx, cy);
    if (created.cx !== cx || created.cy !== cy) {
      throw new Error(
        `World: generator returned world chunk (${created.cx}, ${created.cy}) when asked for (${cx}, ${cy}).`,
      );
    }
    return created;
  }

  /**
   * Record that a world chunk diverges from generator output, without saying
   * how. C24's loader only.
   *
   * `dirty` is authoritative in the sense that matters — it decides what the
   * *next* save writes (§14) — and it latches, so it cannot be re-derived from
   * the tiles: a world chunk mined and then restored to its generated amounts
   * is still one the save has to carry. The loader therefore sets it from the
   * save rather than inferring it from the deltas it applies.
   */
  markDirty(cx: number, cy: number): void {
    markChanged(this.getChunk(cx, cy));
  }

  getTile(x: number, y: number): TileType {
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    return at(chunk.terrain, localIndex(toLocalCoord(x), toLocalCoord(y)));
  }

  /**
   * Set the terrain at a tile.
   *
   * Writing the value already there is not a divergence and does not dirty the
   * world chunk — otherwise any code that re-asserts terrain in a loop would
   * push the entire explored map into the save file (§14).
   */
  setTile(x: number, y: number, type: TileType): void {
    if (!isTileType(type)) {
      throw new RangeError(`World.setTile: ${type} is not a TileType.`);
    }
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    const index = localIndex(toLocalCoord(x), toLocalCoord(y));
    if (at(chunk.terrain, index) === type) return;
    chunk.terrain[index] = type;
    markChanged(chunk);
  }

  /** The resource type at a tile, or `ResourceType.None`. */
  getResource(x: number, y: number): ResourceType {
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    return at(chunk.resource, localIndex(toLocalCoord(x), toLocalCoord(y)));
  }

  /**
   * Units of ore left at a tile. `0` on an exhausted or resourceless tile.
   *
   * Depletion leaves the resource *type* in place and drops the amount to zero,
   * rather than clearing the type. That keeps a world-chunk delta lossless —
   * §14 records changed amounts, and a restored zero must not need a second
   * field to explain what used to be there. "Is this tile mineable?" is
   * `getResourceAmount(x, y) > 0`.
   */
  getResourceAmount(x: number, y: number): number {
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    return at(chunk.resourceAmount, localIndex(toLocalCoord(x), toLocalCoord(y)));
  }

  /**
   * Take up to `amount` units of ore from a tile; return how many were taken.
   *
   * Clamped rather than refused, so a miner asking for more than remains gets
   * the remainder and the patch ends exactly at zero. Taking nothing changes
   * nothing, including the dirty flag.
   */
  consumeResource(x: number, y: number, amount: number): number {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new RangeError(`World.consumeResource: amount must be a non-negative integer, got ${amount}.`);
    }
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    const index = localIndex(toLocalCoord(x), toLocalCoord(y));

    if (at(chunk.resource, index) === ResourceType.None) return 0;

    const remaining = at(chunk.resourceAmount, index);
    const taken = Math.min(remaining, amount);
    if (taken === 0) return 0;

    chunk.resourceAmount[index] = remaining - taken;
    markChanged(chunk);
    return taken;
  }

  /**
   * Place a resource patch tile. Used by generators through `World` and by the
   * save loader when replaying deltas.
   */
  setResource(x: number, y: number, type: ResourceType, amount: number): void {
    if (!isResourceType(type)) {
      throw new RangeError(`World.setResource: ${type} is not a ResourceType.`);
    }
    if (!Number.isInteger(amount) || amount < 0 || amount > MAX_RESOURCE_AMOUNT) {
      throw new RangeError(
        `World.setResource: amount must be an integer in [0, ${MAX_RESOURCE_AMOUNT}], got ${amount}.`,
      );
    }
    const chunk = this.getChunk(toChunkCoord(x), toChunkCoord(y));
    const index = localIndex(toLocalCoord(x), toLocalCoord(y));
    if (at(chunk.resource, index) === type && at(chunk.resourceAmount, index) === amount) return;
    chunk.resource[index] = type;
    chunk.resourceAmount[index] = amount;
    markChanged(chunk);
  }

  /**
   * Visit every world chunk overlapping an inclusive tile rectangle.
   *
   * **This generates.** Bounds iteration is how the renderer asks for the
   * terrain it is about to draw, and terrain that does not exist yet is exactly
   * what needs generating — lazy creation driven by the viewport is the design,
   * not a leak. Use `peekChunk` where that is not wanted.
   *
   * Row-major, `cy` outer: a fixed, coordinate-driven order, so two runs visit
   * the same world chunks in the same sequence regardless of what the `Map`
   * happens to hold (§6 R4).
   */
  /**
   * Visit every world chunk that has actually been generated, in a fixed order.
   *
   * The counterpart to `forEachChunkInBounds`: that one is driven by a
   * rectangle and **generates**, this one is driven by what exists and creates
   * nothing. Two callers want exactly that — C18's determinism hash, which has
   * to fold the world into a number without inventing terrain by looking at
   * it, and §14's save, which writes the world chunks that diverge from what
   * the generator would produce and regenerates the rest.
   *
   * **Ascending by packed key**, sorted rather than taken in the `Map`'s
   * order. §6 R4 is the whole reason this method exists: a `Map` iterates in
   * *insertion* order, so a world explored westward and the same world loaded
   * from a save would hand out their chunks in different sequences, and
   * anything that hashed or serialized them would disagree with itself across
   * a reload. `chunkKey` packs `(cx, cy)` into one integer, so sorting the
   * keys is a coordinate order and not an arbitrary one.
   *
   * The sort is why this is not a hot path and is not meant to be: it is for
   * saving and for hashing, both of which happen between ticks.
   */
  forEachLoadedChunk(visit: ChunkVisitor): void {
    const keys = [...this.chunks.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const chunk = this.chunks.get(key);
      if (chunk !== undefined) visit(chunk);
    }
  }

  forEachChunkInBounds(bounds: TileBounds, visit: ChunkVisitor): void {
    // An empty rectangle, per the `TileBounds` convention. Without this, a
    // zero-size viewport would still generate the world chunk under the origin.
    if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return;

    const minCx = toChunkCoord(bounds.minX);
    const maxCx = toChunkCoord(bounds.maxX);
    const minCy = toChunkCoord(bounds.minY);
    const maxCy = toChunkCoord(bounds.maxY);

    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        visit(this.getChunk(cx, cy));
      }
    }
  }
}
