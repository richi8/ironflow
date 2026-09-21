/**
 * A radar: the building that turns power into map. See ironflow.md C23 task 3.
 *
 * It is the first building in the game whose product is neither an item nor a
 * technology — what it makes is an entry in the explored set (§14), which is
 * world state rather than anything that can sit in a buffer. So it has no
 * input, no output and no recipe, and what is left is three fields:
 *
 * ```text
 *   sweepTicks   integer ticks into the current sweep step (§6 R3)
 *   cursor       which world chunk of its coverage the next step reveals
 *   status       why it is or is not sweeping (§13, pillar 3)
 * ```
 *
 * ## Why there is a cursor at all
 *
 * Revealing is idempotent — a world chunk already explored stays explored — so
 * a radar could simply mark its whole coverage every tick and nothing
 * observable would change. The cursor exists for two reasons that are not
 * about correctness:
 *
 * - **Cost.** A radius of five is 121 world chunks. Marking all of them every
 *   tick, per radar, is work §12 would eventually notice; one a step is a
 *   constant.
 * - **It is what the player sees.** C23 task 3 asks for "a low-rate refresh",
 *   and a radar that fills the map in over a minute is a building doing
 *   something. One that completes the instant it is powered is a switch.
 *
 * The cursor wraps, so a radar that has finished its coverage keeps sweeping
 * it — which costs nothing and is what makes the refresh a refresh.
 */

import type { Rotation } from '../world/coordinates.js';

import type { Entity } from './entity.js';
import type { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

export interface RadarEntity extends Entity {
  /** Integer ticks into the current sweep step (§6 R3). */
  sweepTicks: number;
  /** Index into the coverage square, row-major. `0..coverage - 1`. */
  cursor: number;
  status: MachineStatus;
}

export type RadarInit = Omit<RadarEntity, 'id'>;

export function newRadar(type: EntityType, x: number, y: number, rotation: Rotation): RadarInit {
  return { type, x, y, rotation, sweepTicks: 0, cursor: 0, status: MachineStatus.Idle };
}

/**
 * The entity as a radar, or `null` if it is not one.
 *
 * It asks the *registry*, exactly as `asLab` does: "is a radar" means "the
 * content table gave this building a radar config", so a longer-ranged second
 * tier is a table entry and this file does not change (§19 rule 17).
 */
export function asRadar(
  entity: Entity,
  buildings: { radarFor(type: EntityType): unknown },
): RadarEntity | null {
  return buildings.radarFor(entity.type) === null ? null : (entity as RadarEntity);
}
