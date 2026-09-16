/**
 * The serializable entity shape. See ironflow.md C05 task 1.
 *
 * Everything the player builds is one of these: a plain object, four fields
 * wide, with type-specific data added by parallel interfaces that extend it
 * (`MinerEntity`, `BeltEntity`, …, each introduced by the chunk that needs it).
 *
 * ## The rule that makes persistence cheap
 *
 * An entity is **plain data and nothing else**. No classes, no methods, no
 * getters, no `Map` or `Set` fields, no references to other entities — store an
 * `EntityId` and look it up. Concretely, both of these must hold:
 *
 * ```text
 * deepEqual(structuredClone(e), e)
 * deepEqual(JSON.parse(JSON.stringify(e)), e)
 * ```
 *
 * The second is the strict one, and it is the reason `undefined`, `NaN`,
 * `Infinity`, `-0` and typed arrays are refused below: each survives
 * `structuredClone` and is silently altered or dropped by `JSON.stringify`.
 * C24's serializer then writes a save that loads into a *subtly different*
 * world, which is the most expensive bug shape this project can produce —
 * found by a player weeks later, with no reproduction. `assertSerializable`
 * turns it into a throw at the moment the bad field is written.
 *
 * ## Why the base fields are readonly
 *
 * `id`, `type`, `x`, `y` and `rotation` are the keys of the store's occupancy
 * index (§10 lists that index as derived state, rebuilt on load). A system
 * that assigned `entity.x = 5` would move the building and leave the index
 * pointing at the old tiles — a corruption that shows up much later as a
 * building you cannot remove standing on a tile you cannot build on. Making
 * them readonly means the only way to change one is through a store method
 * that re-indexes. Subtype fields — progress, buffers, item positions — stay
 * mutable; they are what systems are for.
 */

import { tileKey, type Rotation, type TileCoord } from '../world/coordinates.js';

import type { EntityType } from './entity-types.js';

/** A stable handle to an entity. Monotonic, never reused (§6 R5). */
export type EntityId = number;

/**
 * "No entity". Ids start at 1 so that `0` can mean this.
 *
 * A falsy valid id is a bug generator: `if (entity.inputId)` reads correctly
 * and silently skips entity 0. Giving up one id buys immunity from a whole
 * family of them, and the store's first id is the only place it costs anything.
 */
export const NO_ENTITY: EntityId = 0;

/** The first id a fresh store hands out. */
export const FIRST_ENTITY_ID: EntityId = 1;

/** Is this a value the store could ever have handed out? */
export function isEntityId(value: number): boolean {
  return Number.isInteger(value) && value >= FIRST_ENTITY_ID && value <= Number.MAX_SAFE_INTEGER;
}

/** Everything the player has built. See the file header before adding a field. */
export interface Entity {
  readonly id: EntityId;
  /** Numeric, persisted, and the `byType` bucket index. */
  readonly type: EntityType;
  /** North-west tile of the footprint — not its centre. */
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

/** An entity as handed to `EntityStore.create`: everything but the id. */
export type EntityInit<T extends Entity = Entity> = Omit<T, 'id'>;

/**
 * A footprint size in tiles, in the entity's **unrotated** orientation.
 *
 * Size belongs to the building *type*, not to the entity (§10: it is content,
 * and content is never persisted per instance). C06's `BuildingDefinition.size`
 * is the real source; until then the store is told where to ask.
 */
export interface Footprint {
  readonly width: number;
  readonly height: number;
}

/** The size of everything that occupies a single tile. */
export const UNIT_FOOTPRINT: Footprint = Object.freeze({ width: 1, height: 1 });

/**
 * The tiles a footprint actually covers once rotated.
 *
 * A quarter-turn swaps the extent and keeps the north-west tile as the anchor:
 * a 3×2 at `(10, 4)` facing north covers `x 10..12, y 4..5`, and facing east
 * covers `x 10..11, y 4..6`. C06 task 5 words this as "footprint dimensions
 * swap for odd rotations", and this is that sentence.
 *
 * Anchoring rather than rotating about the centre is a deliberate choice:
 * rotating a 3×2 about its centre lands its corners on half-tiles, and every
 * scheme that fixes that has to pick a rounding rule that the ghost preview,
 * the occupancy index and the renderer must all agree on. Keeping the anchor
 * fixed means the tile under the cursor is the tile the building starts at, at
 * every rotation, with no rule to remember.
 */
export function footprintExtent(footprint: Footprint, rotation: Rotation): Footprint {
  return rotation === 1 || rotation === 3
    ? { width: footprint.height, height: footprint.width }
    : { width: footprint.width, height: footprint.height };
}

/**
 * Visit every tile a placement covers, in row-major order.
 *
 * Takes loose coordinates rather than an `Entity` so C06's ghost preview —
 * which has a position and a size but no entity yet — walks exactly the same
 * tiles the placement will claim. Two functions here would be two chances to
 * disagree about what "occupied" means.
 */
export function forEachFootprintTile(
  x: number,
  y: number,
  footprint: Footprint,
  rotation: Rotation,
  visit: (tileX: number, tileY: number) => void,
): void {
  assertFootprint(footprint);
  const extent = footprintExtent(footprint, rotation);
  for (let dy = 0; dy < extent.height; dy++) {
    for (let dx = 0; dx < extent.width; dx++) {
      visit(x + dx, y + dy);
    }
  }
}

/**
 * The `index`th tile of a placement, in the same row-major order
 * `forEachFootprintTile` visits.
 *
 * The random-access half of the walk above, and it exists because C11's miner
 * round-robins over its covered tiles: it needs *one* tile per item, chosen by
 * a stored index, and building an array of four coordinates per miner per tick
 * to pick one of them is allocation in a simulation phase. Sharing the order
 * with the walk is the point — a cursor that disagreed with the iteration
 * order would mine tiles in an order nothing else in the game could predict.
 *
 * `index` is taken modulo the tile count, so a cursor may be advanced without
 * being wrapped by its owner and a rotation that shrinks nothing still lands
 * inside the footprint.
 */
export function footprintTileAt(
  x: number,
  y: number,
  footprint: Footprint,
  rotation: Rotation,
  index: number,
): TileCoord {
  assertFootprint(footprint);
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`footprintTileAt: index must be a non-negative integer, got ${index}.`);
  }
  const extent = footprintExtent(footprint, rotation);
  const wrapped = index % (extent.width * extent.height);
  return { x: x + (wrapped % extent.width), y: y + Math.floor(wrapped / extent.width) };
}

/**
 * Visit the tiles just *outside* a placement, on the side its rotation faces.
 *
 * A building's rotation is its output side (C11: "a miner that cannot be
 * turned towards the belt is a miner that dictates the factory's layout"), and
 * a 2x2 miner facing north has two tiles in front of it rather than one. This
 * walks them, in the same row-major order `forEachFootprintTile` uses, so the
 * tile a machine tries first is a fact anyone can read off the footprint
 * rather than an accident of how the loop was written (§6 R4).
 *
 * Tiles outside the packable range are visited like any other — the caller
 * decides what a coordinate at the edge of the world means, because the store
 * and the world answer that question differently.
 */
export function forEachOutputTile(
  x: number,
  y: number,
  footprint: Footprint,
  rotation: Rotation,
  visit: (tileX: number, tileY: number) => void,
): void {
  assertFootprint(footprint);
  const extent = footprintExtent(footprint, rotation);
  switch (rotation) {
    case 0:
      for (let dx = 0; dx < extent.width; dx++) visit(x + dx, y - 1);
      return;
    case 1:
      for (let dy = 0; dy < extent.height; dy++) visit(x + extent.width, y + dy);
      return;
    case 2:
      for (let dx = 0; dx < extent.width; dx++) visit(x + dx, y + extent.height);
      return;
    case 3:
      for (let dy = 0; dy < extent.height; dy++) visit(x - 1, y + dy);
      return;
  }
}

/** How many tiles a placement covers. */
export function footprintTileCount(footprint: Footprint, rotation: Rotation): number {
  assertFootprint(footprint);
  const extent = footprintExtent(footprint, rotation);
  return extent.width * extent.height;
}

/** The tiles a placement covers, as coordinates. For tests and the inspector. */
export function footprintTiles(
  x: number,
  y: number,
  footprint: Footprint,
  rotation: Rotation,
): TileCoord[] {
  const tiles: TileCoord[] = [];
  forEachFootprintTile(x, y, footprint, rotation, (tileX, tileY) => tiles.push({ x: tileX, y: tileY }));
  return tiles;
}

/** A footprint must be a positive whole number of tiles on both axes. */
export function assertFootprint(footprint: Footprint): void {
  const { width, height } = footprint;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`Footprint must be whole tiles, at least 1×1; got ${width}×${height}.`);
  }
}

/**
 * Does every tile of this placement have a packable key? Throws if not.
 *
 * Placement validation (bounds, terrain, occupancy) is C06's; this is only the
 * storage precondition, and it is here so the store can check a whole
 * footprint before claiming any of it.
 */
export function assertPlaceable(x: number, y: number, footprint: Footprint, rotation: Rotation): void {
  forEachFootprintTile(x, y, footprint, rotation, (tileX, tileY) => {
    tileKey(tileX, tileY);
  });
}

/* -------------------------------------------------------------------------- *
 * Serializability
 * -------------------------------------------------------------------------- */

/** Values `JSON.stringify` and `structuredClone` agree on, recursively. */
const PLAIN_PROTOTYPES: readonly (object | null)[] = Object.freeze([Object.prototype, null]);

/**
 * Throw unless `value` is data that survives both round trips unchanged.
 *
 * Runs on every `create`, for the same reason `tileKey` validates on every
 * call: there is no dev-build flag available inside `game/` (§4), the check is
 * a few comparisons over an object that is about to be allocated anyway, and
 * the bug it catches is invisible until a save is loaded. If C28's profiler
 * ever disagrees, that is the moment to gate it — not before (§16).
 */
export function assertSerializable(value: unknown, label = 'entity'): void {
  checkPlain(value, label, new Set<object>());
}

function checkPlain(value: unknown, path: string, seen: Set<object>): void {
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return;
    case 'number':
      // §6 R7. `-0` is the quiet one: it clones as `-0` and stringifies as `0`,
      // so it is the difference that a save round trip invents out of nothing.
      if (!Number.isFinite(value)) {
        throw new TypeError(`${path} is ${String(value)}; entity fields must be finite (§6 R7).`);
      }
      if (Object.is(value, -0)) {
        throw new TypeError(`${path} is -0, which JSON normalises to 0 (§6 R7). Write "0 - v", not "-v".`);
      }
      return;
    case 'undefined':
      throw new TypeError(`${path} is undefined, which JSON.stringify drops. Use null.`);
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new TypeError(`${path} is a ${typeof value}; entities are plain data (C05 task 1).`);
  }

  if (value === null) return;

  const object = value as object;
  if (seen.has(object)) {
    throw new TypeError(`${path} is part of a reference cycle; entities are trees of plain data.`);
  }
  seen.add(object);

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      checkPlain(object[i], `${path}[${i}]`, seen);
    }
  } else if (PLAIN_PROTOTYPES.includes(Object.getPrototypeOf(object) as object | null)) {
    // Own enumerable keys only, which is exactly what JSON.stringify writes.
    for (const key of Object.keys(object)) {
      checkPlain((object as Record<string, unknown>)[key], `${path}.${key}`, seen);
    }
  } else {
    // A Map, Set, Date, typed array or class instance. Every one of these
    // clones fine and stringifies into something else — a `{}`, a string, an
    // index-keyed object — so the round trip is lossy in a way no type catches.
    const kind = (Object.getPrototypeOf(object) as { constructor?: { name?: string } } | null)?.constructor?.name;
    throw new TypeError(
      `${path} is a ${kind ?? 'non-plain object'}; entities hold only plain objects, arrays and primitives (C05 task 1).`,
    );
  }

  seen.delete(object);
}
