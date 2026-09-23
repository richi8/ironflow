/**
 * The chest. See ironflow.md §15 (24 slots) and C13 task 6.
 *
 * A chest existed from C06 as a building with no insides — the building with
 * none of the placement rules, there to prove the pipeline. C13 is the chunk
 * that has to give it an inventory, because "the chest fills" is an acceptance
 * criterion and a belt has to have somewhere to put an item.
 *
 * ## How a plain-data entity holds an inventory
 *
 * C12 left this decision here in as many words. An entity is plain data that
 * must survive `JSON.stringify` (C05), and `SlotInventory` is a class, so the
 * class cannot go on the entity. C11 answered the same question for a miner by
 * storing a bare count — which works because a miner's buffer holds exactly
 * one kind of item and `resourceType` names it. A chest holds anything, so a
 * count is not enough.
 *
 * The answer is to store what the container *is*: an `ItemSlots`, the plain
 * `[itemId, count]` array `inventory.ts` now keeps its contents in. A system
 * that wants the five verbs builds a `SlotInventory` over that array by
 * reference, uses it, and drops it. The entity owns the data; the container is
 * a view. Nothing is copied, nothing has to be written back, and there is one
 * implementation of stack packing rather than two.
 *
 * **Since 2026-09-23 the array is a grid**, like the player's bag: a
 * `GridEntry` per occupied slot, `[slot, itemId, count]`, ascending by slot.
 * Each stack has a position the player can rearrange, and a system builds a
 * `GridInventory` over it the way it used to build a `SlotInventory`.
 *
 * The slot count is **not** here: 24 slots is content (§15's building table),
 * it lives on `BuildingDefinition.storage`, and storing it per chest would
 * freeze C20's balance pass into every existing save — the same reason C11
 * kept a miner's rate off `MinerEntity`.
 */

import type { GridEntry } from '../items/inventory.js';
import type { Rotation } from '../world/coordinates.js';

import type { Entity } from './entity.js';
import { EntityType } from './entity-types.js';

export interface ChestEntity extends Entity {
  /** Authoritative (§10). One entry per occupied slot, ascending by slot (§6 R4). */
  contents: GridEntry[];
}

/** A chest as `EntityStore.create` wants it: everything but the id. */
export type ChestInit = Omit<ChestEntity, 'id'>;

/** The state a freshly placed chest starts in: empty. */
export function newChest(x: number, y: number, rotation: Rotation): ChestInit {
  return { type: EntityType.Chest, x, y, rotation, contents: [] };
}

/** This entity as a chest, or null if it is something else. */
export function asChest(entity: Entity): ChestEntity | null {
  return entity.type === EntityType.Chest ? (entity as ChestEntity) : null;
}
