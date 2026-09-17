/**
 * Why a machine is or is not running. See ironflow.md C11 task 1 and §13.
 *
 * Pillar 3 is "legible mechanics: the player can always see why something is
 * stalled", and this enum is the machine's half of that sentence — C12's
 * inspector renders it, and `views/building-view.ts` takes its player-facing
 * names from the table below so there is one vocabulary rather than two.
 *
 * A numeric enum for the same reason `EntityType` is one: the value is written
 * into every machine in the save file (§14) and compared once per machine per
 * tick, so **existing numbers may never be reassigned**. The list is complete
 * on day one rather than growing a member per chunk, which is the arrangement
 * §7's command union and `entity-types.ts` already use: a type that gains a
 * member per chunk is a type every save migration has to re-learn. C11 uses
 * four of the seven; C15 and C21 supply the producers for the rest.
 *
 * ## Why it is stored rather than derived
 *
 * Every value here is recomputable from the machine's own state, so §10 would
 * normally call it derived. It is stored because the *transition* is the
 * interesting event: C11 task 5 asks for one alert when a miner runs dry, not
 * one per tick, and "did this differ from last tick" is a question only a
 * remembered value can answer. Being recomputed every tick is also what keeps
 * it honest across a save: a loaded machine's status is corrected on the first
 * tick, whatever was written.
 */

import type { Entity } from './entity.js';

/** What a machine is doing, or the reason it is not. See the file header. */
export enum MachineStatus {
  /** Nothing to do, and nothing wrong. A chest; a machine that has not ticked. */
  Idle = 0,
  Running = 1,
  /** Backpressure: the output buffer is full and nothing is taking from it. */
  OutputFull = 2,
  /** A miner whose covered tiles are exhausted (C11 task 5). */
  NoResource = 3,
  /** C21. */
  NoPower = 4,
  /** C15: a recipe is set, the ingredients are not there. */
  NoInput = 5,
  /** C15: a machine that could run if the player chose what it should make. */
  NoRecipe = 6,
  NoFuel = 7,
}

/**
 * Indexed by `MachineStatus`. These strings are the UI's vocabulary — see
 * `views/building-view.ts`, which types its `status` field from this table.
 */
const MACHINE_STATUS_NAMES = Object.freeze([
  'idle',
  'running',
  'output_full',
  'no_resource',
  'no_power',
  'no_input',
  'no_recipe',
  'no_fuel',
] as const);

/** The name of a status, as a view model spells it. */
export type MachineStatusName = (typeof MACHINE_STATUS_NAMES)[number];

/** How many statuses exist. Kept in step with the table, not hand-written. */
export const MACHINE_STATUS_COUNT = MACHINE_STATUS_NAMES.length;

/** Is `value` a number the `status` field may legitimately hold? */
export function isMachineStatus(value: number): value is MachineStatus {
  return Number.isInteger(value) && value >= 0 && value < MACHINE_STATUS_COUNT;
}

/** The name of a status. Throws on a value outside the enum. */
export function machineStatusName(status: MachineStatus): MachineStatusName {
  const name = MACHINE_STATUS_NAMES[status];
  if (name === undefined) {
    throw new RangeError(`machineStatusName: ${status} is not a MachineStatus.`);
  }
  return name;
}

/**
 * The status an entity is remembering, or `Idle` for one that remembers none.
 *
 * Not every entity has a status field: a chest has nothing to be stalled on,
 * and `Idle` — which the inspector renders as "Nothing to do" — is the honest
 * answer for it. Everything that *can* stall stores one, and this is the one
 * place that knows the field is optional, so the controller does not grow a
 * branch per machine type as C15 and C21 add theirs.
 */
export function statusOf(entity: Entity): MachineStatus {
  const status = (entity as Partial<{ status: MachineStatus }>).status;
  return status !== undefined && isMachineStatus(status) ? status : MachineStatus.Idle;
}
