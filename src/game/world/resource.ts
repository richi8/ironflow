/**
 * Resource types, what they yield, and how full a tile reads. See ironflow.md
 * C09 tasks 1-3 and §15.
 *
 * Resources are **not entities** (C09 task 1). A patch is two bytes and a
 * `Uint16` per tile inside the world chunk that already exists, because the
 * twenty thousand ore tiles of a mid-game map would otherwise be twenty
 * thousand objects in the entity store, each with an id, a position and a
 * removal flag, none of which a lump of iron has any use for.
 *
 * This file is to `WorldChunk.resource` exactly what `tile.ts` is to
 * `WorldChunk.terrain`: the enum stored in the bytes, plus the one table that
 * says what each value means. It is deliberately *not* in `data/`, for the
 * same reason terrain is not — a resource type is a number persisted inside
 * world-chunk deltas (§14), so it is storage vocabulary first and content
 * second, and the two facts are too small to live apart.
 *
 * Tile space only. Nothing here knows what ore looks like; the tint colours in
 * §11 are the renderer's business, and it finds them through `name`.
 */

/**
 * A resource type, stored as one byte per tile in `WorldChunk.resource`.
 *
 * `None = 0` on purpose, so a zero-filled `Uint8Array` is a valid, resourceless
 * world chunk — the same bargain `TileType.Grass = 0` makes, and what
 * `createChunk` relies on. Values are persisted inside world-chunk deltas
 * (§14), so **existing numbers may never be reassigned**: a new resource takes
 * the next free number, and a deleted one's number stays retired.
 */
export enum ResourceType {
  None = 0,
  Iron = 1,
  Copper = 2,
  Coal = 3,
  Stone = 4,
}

/** What the simulation is allowed to ask about a resource type. */
export interface ResourceProperties {
  /**
   * Stable identifier, and the one word three things share.
   *
   * It is the §11 palette token (`--if-iron`), the sprite id the renderer
   * builds (`resource:iron:2`) and the name a debug readout prints. One word,
   * three uses, no translation table — the arrangement `tileProperties.name`
   * already uses for terrain.
   */
  readonly name: string;
  /**
   * The item one unit of this yields when mined, by string id, or `null` for
   * `None` — nothing is mined from nothing.
   *
   * A string rather than a numeric `ItemId` because this is content and
   * numeric ids are assigned at registration (C08); the registry resolves it.
   * Nothing reads it yet: C10's manual mining and C11's miner are the two
   * callers, and a resource that does not say what it yields is an incomplete
   * definition rather than a field held back for them. A test checks every
   * entry against `data/items.ts`, which is what keeps it from rotting.
   */
  readonly itemId: string | null;
}

/**
 * Indexed by `ResourceType`. Frozen, because every system that asks a question
 * about ore shares this table and none of them owns it.
 *
 * Index 0 is the *absence* of a resource. It is in the table rather than a
 * hole in it so that every lookup is total — a readout can print "none" — and
 * its `itemId` is `null` because mining a tile with no ore on it yields
 * nothing, which is a fact worth being unable to forget.
 */
const RESOURCE_PROPERTIES: readonly ResourceProperties[] = Object.freeze([
  Object.freeze({ name: 'none', itemId: null }),
  Object.freeze({ name: 'iron', itemId: 'iron_ore' }),
  Object.freeze({ name: 'copper', itemId: 'copper_ore' }),
  Object.freeze({ name: 'coal', itemId: 'coal' }),
  Object.freeze({ name: 'stone', itemId: 'stone' }),
]);

/** How many resource values exist, `None` included. In step with the table. */
export const RESOURCE_TYPE_COUNT = RESOURCE_PROPERTIES.length;

/**
 * Every resource a tile can actually hold, in enum order. `None` is not one.
 *
 * What a generator picks from and what a content test iterates. Derived from
 * the table so C19 cannot add a resource the map generator never places.
 */
export const RESOURCE_TYPES: readonly ResourceType[] = Object.freeze(
  Array.from({ length: RESOURCE_TYPE_COUNT - 1 }, (_unused, index) => (index + 1) as ResourceType),
);

/** Is `value` a byte the resource array may legitimately hold? */
export function isResourceType(value: number): value is ResourceType {
  return Number.isInteger(value) && value >= 0 && value < RESOURCE_TYPE_COUNT;
}

/** Properties of a resource type. Throws on a value outside the enum. */
export function resourceProperties(type: ResourceType): ResourceProperties {
  const properties = RESOURCE_PROPERTIES[type];
  if (properties === undefined) {
    throw new RangeError(`resourceProperties: ${type} is not a ResourceType.`);
  }
  return properties;
}

/** The stable name of a resource type: palette token, sprite id, readout. */
export function resourceName(type: ResourceType): string {
  return resourceProperties(type).name;
}

/** The item a unit of this resource yields, or `null` if it yields nothing. */
export function resourceItemId(type: ResourceType): string | null {
  return resourceProperties(type).itemId;
}

/* -------------------------------------------------------------------------- *
 * Fullness buckets
 * -------------------------------------------------------------------------- */

/**
 * What this file calls a full tile, in units of ore.
 *
 * The stub generator (C09 task 4) fills a patch centre to this, and the bucket
 * thresholds below are quarters of it. It is a **balance number** and belongs
 * to C20's tuning pass: at the §15 miner rate of 0.5 items/s one full tile is
 * a thousand seconds, so a 2x2 miner standing on four of them runs about an
 * hour before it has to move — long enough that depletion is a real cost, short
 * enough that a play session sees it happen.
 */
export const NOMINAL_RESOURCE_AMOUNT = 500;

/** How many fullness buckets a non-empty tile can be in. C09 task 3 says four. */
export const RESOURCE_BUCKET_COUNT = 4;

/** What `resourceBucket` returns for a tile with nothing left on it. */
export const NO_BUCKET = -1;

/**
 * Which quarter of a full tile an amount falls in: `0` thinnest, `3` fullest.
 *
 * C09 task 3 wants a depleting patch readable at a glance without a number, so
 * the renderer picks one of four ore-pile sprites from this. An empty tile is
 * not in a bucket at all and gets `NO_BUCKET` — it draws nothing, which is the
 * chunk's second acceptance criterion, and a sentinel is the only honest answer
 * because "thinnest visible pile" and "no pile" are different pictures.
 *
 * The scale is **absolute**, against `NOMINAL_RESOURCE_AMOUNT`, not relative to
 * what the tile started with. Relative would need a second `Uint16` per tile
 * recording the original amount — 2 KB more per world chunk and another field
 * in every save — to answer a question that is only ever asked about a pixel.
 * The cost is that a richer-than-nominal tile from C19 sits at bucket 3 until
 * it drops below a full tile's worth; the plan's C09 section records that as
 * C19's to revisit if patch richness ends up varying much.
 */
export function resourceBucket(amount: number): number {
  if (!(amount > 0)) return NO_BUCKET;
  const perBucket = NOMINAL_RESOURCE_AMOUNT / RESOURCE_BUCKET_COUNT;
  const bucket = Math.ceil(amount / perBucket) - 1;
  return Math.min(RESOURCE_BUCKET_COUNT - 1, Math.max(0, bucket));
}
