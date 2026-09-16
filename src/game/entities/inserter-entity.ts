/**
 * The inserter. See ironflow.md C14 tasks 1–2.
 *
 * The connective tissue: the one building whose whole job is to move an item
 * from the thing behind it to the thing in front of it. A belt carries items
 * *along* itself; an inserter is how an item gets *onto* one, and off again.
 *
 * ## The cycle, and the fifth state
 *
 * C14 task 1 writes the machine as `Idle -> Pickup -> Carrying -> Drop ->
 * Idle`. That list is four states and an arm that teleports home: after the
 * drop the hand is over the *destination*, and something has to bring it back
 * before the next pickup. `Returning` is that something, and it is a state
 * rather than a fudge inside `Idle` because the player can see it — an
 * inserter running flat out spends half its cycle swinging back, and an arm
 * that snapped home instantly would read as a machine running at twice its
 * rate.
 *
 * ```text
 *   Idle ──(source has an item, destination has room)──> Pickup
 *   Pickup ──(pickupTicks; take the item)──> Carrying        └─(source empty)─> Idle
 *   Carrying ──(carryTicks)──> Drop
 *   Drop ──(dropTicks; put the item in)──> Returning         └─(no room)─> waits, holding
 *   Returning ──(returnTicks)──> Idle, and straight on to the next Pickup
 * ```
 *
 * `Idle` is the only state with no duration: it is *outside* the cycle, which
 * is what makes the rate exact. The four timed stages add up to
 * `InserterConfig.ticksPerItem`, and a saturated inserter never passes through
 * `Idle` for a tick — `Returning` completing begins the next `Pickup` in the
 * same tick — so it delivers exactly one item every `ticksPerItem` ticks, for
 * ever (§15: 1.0 items/s standard).
 *
 * ## The item is taken once and only ever put down in the destination
 *
 * The hand is loaded at the *end* of `Pickup` and emptied at the *end* of
 * `Drop`. Between those two moments the item exists nowhere else: it is out of
 * the belt and not yet in the chest, and `heldItem` is the only record of it.
 * That is what makes "removing the source or destination mid-swing does not
 * throw" (C14 acceptance 3) a property rather than a hope — a vanished source
 * cannot un-take an item that was never taken, and a vanished destination
 * leaves the inserter holding one, which is the only answer that does not
 * destroy it. See `inserter-system.ts` on why holding beats dropping.
 *
 * ## Plain data, like everything else
 *
 * Four fields, all numbers, all `JSON.stringify`-safe (C05). The rate is
 * **not** here: it is content on `BuildingDefinition.inserter`, exactly as a
 * miner's rate and a belt's speed are, so C22's fast inserter is a table entry
 * and C20's balance pass does not have to migrate every save.
 */

import { NO_ITEM, type ItemId } from '../registries/item-registry.js';
import type { InserterConfig } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';

import type { Entity } from './entity.js';
import { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

/**
 * Where an inserter is in its cycle. See the file header.
 *
 * A numeric enum for the reason `EntityType` and `MachineStatus` are: the
 * value is written into every inserter in the save file (§14), so an existing
 * number may never be reassigned.
 */
export enum InserterState {
  /** Hand empty, arm parked over the source. The only state with no duration. */
  Idle = 0,
  /** Reaching into the source. The item is taken when this stage completes. */
  Pickup = 1,
  /** Item in hand, swinging across to the destination. */
  Carrying = 2,
  /** Releasing into the destination. The item goes in when this completes. */
  Drop = 3,
  /** Hand empty, arm swinging back to the source. */
  Returning = 4,
}

export interface InserterEntity extends Entity {
  state: InserterState;
  /** Integer ticks into the current stage (§6 R3). Never a float. */
  stateTicks: number;
  /** What is in the hand, or `NO_ITEM` for an empty one. */
  heldItem: ItemId;
  status: MachineStatus;
}

/** An inserter as `EntityStore.create` wants it: everything but the id. */
export type InserterInit = Omit<InserterEntity, 'id'>;

/** The state a freshly placed inserter starts in: idle, empty-handed. */
export function newInserter(x: number, y: number, rotation: Rotation): InserterInit {
  return {
    type: EntityType.Inserter,
    x,
    y,
    rotation,
    state: InserterState.Idle,
    stateTicks: 0,
    heldItem: NO_ITEM,
    status: MachineStatus.Idle,
  };
}

/** This entity as an inserter, or null if it is something else. */
export function asInserter(entity: Entity): InserterEntity | null {
  return entity.type === EntityType.Inserter ? (entity as InserterEntity) : null;
}

/** Is there an item in the hand? */
export function inserterHolding(inserter: InserterEntity): boolean {
  return inserter.heldItem !== NO_ITEM;
}

/**
 * How long the current stage lasts, in ticks. `0` for `Idle`, which has no
 * duration — see the file header.
 */
export function inserterStageTicks(state: InserterState, config: InserterConfig): number {
  switch (state) {
    case InserterState.Pickup:
      return config.pickupTicks;
    case InserterState.Carrying:
      return config.carryTicks;
    case InserterState.Drop:
      return config.dropTicks;
    case InserterState.Returning:
      return config.returnTicks;
    case InserterState.Idle:
      return 0;
  }
}

/**
 * How many ticks of the cycle are behind this inserter, `0..ticksPerItem`.
 *
 * Idle counts as zero rather than as "not applicable", because the inspector
 * draws a bar and a bar needs a number. Derived, never stored (§10).
 */
function elapsedTicks(inserter: InserterEntity, config: InserterConfig): number {
  const done = inserter.stateTicks;
  switch (inserter.state) {
    case InserterState.Idle:
      return 0;
    case InserterState.Pickup:
      return done;
    case InserterState.Carrying:
      return config.pickupTicks + done;
    case InserterState.Drop:
      return config.pickupTicks + config.carryTicks + done;
    case InserterState.Returning:
      return config.pickupTicks + config.carryTicks + config.dropTicks + done;
  }
}

/**
 * How far through one full cycle this inserter is, `0..1`.
 *
 * What the inspector's progress bar reads. Derived from integers and divided
 * by a denominator the registry guarantees is at least four (§6 R7).
 */
export function inserterCycleProgress(inserter: InserterEntity, config: InserterConfig): number {
  return elapsedTicks(inserter, config) / config.ticksPerItem;
}

/**
 * Where the arm is, `0` over the source and `1` over the destination.
 *
 * Simulation state, not presentation: the renderer turns this into an angle
 * and a sprite id (C14 task 7), but *which way round the arm is* is a fact
 * about the cycle and belongs beside the cycle. The two swings are the only
 * stages that move it; a pickup and a drop are the hand working at one end.
 */
export function inserterArmPosition(inserter: InserterEntity, config: InserterConfig): number {
  switch (inserter.state) {
    case InserterState.Idle:
    case InserterState.Pickup:
      return 0;
    case InserterState.Carrying:
      return inserter.stateTicks / config.carryTicks;
    case InserterState.Drop:
      return 1;
    case InserterState.Returning:
      return 1 - inserter.stateTicks / config.returnTicks;
  }
}
