/**
 * The belt, and the items riding it. See ironflow.md §9 and C13 tasks 1–2.
 *
 * §9 is decided up front because it ripples through inserters, throughput,
 * balance and the renderer, and this file is §9's table turned into types:
 *
 * ```text
 * one lane per belt          there is no `lane` field, now or ever in v1
 * 4 slots per tile           BELT_SLOT_SPACING is 256 / 4
 * fixed-point positions      0..255 across a tile, integers (§6 R3)
 * items are NOT entities     no id, no EntityStore, no place in the draw list
 * curves are a render guess  direction is per tile; the renderer infers the art
 * ```
 *
 * ## Why an item is not an entity
 *
 * §9 says it in one line and the consequence is the whole chunk: §12's
 * reference factory carries thousands of items, and giving each one an id, a
 * store slot, an occupancy entry and a place in the depth-sorted draw list
 * would cost more than moving them does. An item is two numbers living in the
 * array of the tile it is on, and it ceases to exist the moment it is handed
 * to the next tile — where a *different* two numbers take its place.
 *
 * ## The list is front-first, and that is an invariant
 *
 * `items[0]` is the item nearest the belt's output end (the largest `pos`) and
 * each entry after it is at least `BELT_SLOT_SPACING` behind. Every function
 * here and in `belt-system.ts` depends on it: the system advances items in
 * that order so an item can never pass the one in front of it (§9's blocking
 * requirement), and `beltAccept` puts an arriving item on the end because
 * arriving is what happens at the *back*.
 *
 * ## What is not here
 *
 * C13 task 2 names a `direction` and a `speedTier` field. Neither is stored.
 * `Entity.rotation` is already the direction — a second copy is a second thing
 * to keep in step, and the one that drifts is the one the simulation reads —
 * and the speed is content on `BuildingDefinition.belt`, exactly as C11 put a
 * miner's rate on `BuildingDefinition.mining` rather than on every miner. See
 * C13's decisions in the plan.
 */

import type { ItemId } from '../registries/item-registry.js';
import type { Rotation } from '../world/coordinates.js';

import type { Entity } from './entity.js';
import { EntityType } from './entity-types.js';

/**
 * Fixed-point positions across one tile: `0` at the entry edge, `255` at the
 * exit edge. §9's "0…255", and integers because §6 R3 forbids a float that
 * would drift differently on either side of a save.
 */
export const BELT_TILE_UNITS = 256;

/** §9: four items to a tile, dense enough to look like flow. */
export const BELT_SLOTS_PER_TILE = 4;

/** The closest two items may ever be. `256 / 4`, and therefore exact. */
export const BELT_SLOT_SPACING = BELT_TILE_UNITS / BELT_SLOTS_PER_TILE;

/** The furthest along a tile an item can sit without having left it. */
export const BELT_MAX_POSITION = BELT_TILE_UNITS - 1;

/**
 * One item on one belt tile. §9's `{ itemId: number; pos: number }`.
 *
 * Mutable, because moving an item *is* writing `pos` — the alternative
 * allocates a replacement object per item per tick, which at §12's eight
 * thousand items is a quarter of a million allocations a second.
 */
export interface BeltItem {
  readonly itemId: ItemId;
  /** `0..BELT_MAX_POSITION`, measured along `rotation`. */
  pos: number;
}

export interface BeltEntity extends Entity {
  /** Front-first: `items[0]` is nearest the output end. See the file header. */
  items: BeltItem[];
}

/** A belt as `EntityStore.create` wants it: everything but the id. */
export type BeltInit = Omit<BeltEntity, 'id'>;

/** The state a freshly placed belt starts in: a direction and nothing on it. */
export function newBelt(x: number, y: number, rotation: Rotation): BeltInit {
  return { type: EntityType.Belt, x, y, rotation, items: [] };
}

/** This entity as a belt, or null if it is something else. */
export function asBelt(entity: Entity): BeltEntity | null {
  return entity.type === EntityType.Belt ? (entity as BeltEntity) : null;
}

/**
 * Where an item entering this belt would actually land, or `-1` for no room.
 *
 * `desired` is where the caller would *like* it — the position it carried over
 * the tile boundary for a hand-off, or the exit edge for a machine dropping
 * onto an empty belt. The answer is never further forward than that and never
 * closer than `BELT_SLOT_SPACING` to the item already at the back, which is
 * the one rule that keeps a tile to four items and stops an arriving item
 * materialising on top of one that is already there.
 */
export function beltEntryPosition(belt: BeltEntity, desired: number): number {
  const last = belt.items[belt.items.length - 1];
  const room = last === undefined ? BELT_MAX_POSITION : last.pos - BELT_SLOT_SPACING;
  const pos = Math.min(desired, room);
  return pos < 0 ? -1 : pos;
}

/**
 * Put an item on the back of a belt if it fits. Returns whether it did.
 *
 * The single way anything enters a belt — a hand-off from the tile behind
 * (C13 task 4) and a machine unloading onto it both come through here — so
 * "four to a tile" and "front-first order" are properties of one function
 * rather than of every caller's care.
 */
export function beltAccept(belt: BeltEntity, itemId: ItemId, desired: number): boolean {
  const pos = beltEntryPosition(belt, desired);
  if (pos < 0) return false;
  belt.items.push({ itemId, pos });
  return true;
}

/** How many items are on this belt tile. `0..BELT_SLOTS_PER_TILE`. */
export function beltItemCount(belt: BeltEntity): number {
  return belt.items.length;
}

/**
 * Does `to` face straight back at `from`?
 *
 * Two belts pointing at each other are not a hand-off in either direction:
 * without this an item would be passed across the seam and back again every
 * tick, which looks like a belt that has jammed for no visible reason. Facing
 * anything else — including sideways, which is §9's curve — is an ordinary
 * hand-off, and what the corner *looks* like is the renderer's guess.
 */
export function facesBack(from: Rotation, to: Rotation): boolean {
  return to === ((from + 2) % 4);
}
