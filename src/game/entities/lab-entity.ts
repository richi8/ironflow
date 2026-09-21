/**
 * A lab: the building that turns science items into progress. See ironflow.md
 * C22 task 2.
 *
 * It is deliberately **not** a `MachineEntity`. A machine's shape is built
 * around a recipe — what it is making, what it has to make it with, what it
 * has made — and a lab has none of those: it makes no item, so it has no
 * output buffer and nothing to hold when one is full; it burns nothing, so it
 * has no fuel; and what it is working on is not its own, it is the
 * *technology the player queued*, which lives in `ResearchState` where one
 * copy of it can serve a hundred labs.
 *
 * What is left is three fields:
 *
 * ```text
 *   input           the science items an inserter or a hand has put in it
 *   progressTicks   integer ticks into the research unit it is working on
 *   status          why it is or is not turning over (§13, pillar 3)
 * ```
 *
 * ## A research unit is anonymous
 *
 * `progressTicks` does not say *which* technology it is progress toward, and
 * that is a decision rather than an omission. A lab is doing a unit of
 * research work; the unit lands on whatever is at the head of the queue when
 * it finishes. So switching research mid-unit costs nothing and loses no
 * science, and a lab left running with an empty queue simply parks its
 * part-finished unit until there is something to spend it on. A field naming
 * the technology would make both of those into stalls that had to be
 * explained.
 */

import type { ItemSlots } from '../items/inventory.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';
import type { Entity } from './entity.js';
import type { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

export interface LabEntity extends Entity {
  /** Integer ticks into the current research unit (§6 R3). */
  progressTicks: number;
  /** Science items waiting to be consumed, sorted by item id like every buffer. */
  input: ItemSlots;
  status: MachineStatus;
}

export type LabInit = Omit<LabEntity, 'id'>;

export function newLab(type: EntityType, x: number, y: number, rotation: Rotation): LabInit {
  return {
    type,
    x,
    y,
    rotation,
    progressTicks: 0,
    input: [],
    status: MachineStatus.Idle,
  };
}

/**
 * The entity as a lab, or `null` if it is not one.
 *
 * It asks the *registry*, exactly as `asMachine` does: "is a lab" means "the
 * content table gave this building a research config", so a second tier of lab
 * is a table entry and this file does not change (§19 rule 17).
 */
export function asLab(entity: Entity, buildings: BuildingRegistry): LabEntity | null {
  return buildings.researchFor(entity.type) === null ? null : (entity as LabEntity);
}
