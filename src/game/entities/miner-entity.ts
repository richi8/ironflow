/**
 * The miner. See ironflow.md C11 task 1.
 *
 * The first of the "parallel interfaces that extend `Entity`" the entity file
 * header promises, and the first entity with state of its own: a resource, a
 * progress count, an output buffer and a status. Everything about it obeys
 * `entity.ts`'s rule — plain numbers, no classes, no `Map`, no reference to
 * another entity — because C24 serializes this object with `JSON.stringify`
 * and `assertSerializable` refuses anything that would not survive it.
 *
 * ## Five fields, and the two that are not here
 *
 * The buffer is a count, not a `BufferInventory`: the class is not plain data
 * (C08), and a miner's buffer holds exactly one kind of item, so the item id
 * would be a second copy of `resourceType`. `resourceItemId(resourceType)` is
 * the item in the buffer, always, and that is an invariant rather than a
 * coincidence — see `adoptResource` in `mining-system.ts`, which only ever
 * changes the resource while the buffer is empty.
 *
 * The rate and the capacity are not here either. They are content (§15's
 * building table), they live on `BuildingDefinition.mining`, and storing them
 * per entity would freeze C20's balance pass into every existing save.
 */

import type { ItemStack } from '../items/item-stack.js';
import type { Rotation } from '../world/coordinates.js';
import { ResourceType, resourceItemId } from '../world/resource.js';

import type { Entity } from './entity.js';
import { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

export interface MinerEntity extends Entity {
  /**
   * What this miner is currently extracting, and — by `resourceItemId` — what
   * is in its buffer. `None` before its first tick, and on a miner standing on
   * ground it cannot mine at all.
   */
  resourceType: ResourceType;
  /** Integer ticks toward the next item (§6 R3). Never a float. */
  progressTicks: number;
  /** How many items are waiting to be taken. Capped by the building's content. */
  outputCount: number;
  /**
   * Which covered tile to try next, as an index into the footprint's tiles in
   * row-major order (`footprintTileAt`).
   *
   * C11 task 1 asks for round-robin "by tile index for determinism": the
   * cursor advances past the tile an item came from, so a 2x2 miner takes one
   * unit from each of its four tiles in turn and a patch under it thins
   * evenly. Storing the index rather than a coordinate keeps it a small
   * integer that cannot point outside the footprint after a rotation.
   */
  tileCursor: number;
  status: MachineStatus;
}

/** A miner as `EntityStore.create` wants it: everything but the id. */
export type MinerInit = Omit<MinerEntity, 'id'>;

/**
 * The state a freshly placed miner starts in.
 *
 * `Idle` rather than `Running`, and the resource is left to the mining system
 * to adopt on its first tick: placement happens in phase 1 and mining runs in
 * phase 3 of the *same* tick (§8), so a miner is never visible to anything in
 * this state — and having one place that decides what a miner may mine beats
 * having two that must agree.
 */
export function newMiner(x: number, y: number, rotation: Rotation): MinerInit {
  return {
    type: EntityType.Miner,
    x,
    y,
    rotation,
    resourceType: ResourceType.None,
    progressTicks: 0,
    outputCount: 0,
    tileCursor: 0,
    status: MachineStatus.Idle,
  };
}

/**
 * This entity as a miner, or null if it is something else.
 *
 * The cast is the assertion the store's `create<T>` already is: nothing but
 * the type tag distinguishes a miner from any other entity at runtime, and
 * every miner in the store was created by `newMiner` above.
 */
export function asMiner(entity: Entity): MinerEntity | null {
  return entity.type === EntityType.Miner ? (entity as MinerEntity) : null;
}
/**
 * What is waiting in a miner's buffer, or null when it is empty.
 *
 * The item is `resourceType`'s yield rather than a stored field — see the file
 * header on why a miner's buffer needs no item id of its own. C12's inspector
 * and C14's inserter are the callers; both want a stack, and this is the one
 * place that knows the buffer's contents are implied rather than named.
 */
export function minerOutput(miner: MinerEntity): ItemStack | null {
  if (miner.outputCount <= 0) return null;
  const itemId = resourceItemId(miner.resourceType);
  return itemId === null ? null : { itemId, count: miner.outputCount };
}

/**
 * Take up to `amount` items out of a miner's buffer. Returns what was taken.
 *
 * The one place that *writes* the buffer from outside the mining system, and
 * it exists because C13 gave the buffer a second reader: the player's hand
 * (C12) and a belt running past the miner's output side both empty it, and
 * `outputCount -= n` written out twice is two chances to forget that the
 * number may not go below zero. Partial and honest, like every other transfer
 * in the game (C08).
 */
export function takeMinerOutput(miner: MinerEntity, amount: number): number {
  if (!Number.isInteger(amount) || amount <= 0) return 0;
  const taken = Math.min(miner.outputCount, amount);
  miner.outputCount -= taken;
  return taken;
}
