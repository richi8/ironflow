/**
 * What a machine's state is called on screen. Shared by the inspector (C12)
 * and the world tooltip (C32), so the two cannot word a stall differently.
 */

import type { MachinePowerView, MachineStatus } from '../game/views/building-view.js';

import type { Tone } from './icons.js';

/**
 * What each status is called on screen.
 *
 * `Record<MachineStatus, …>` rather than a function with a default, for the
 * reason the rejection table in `notifications.ts` is one: a status added in
 * C15 or C21 must be a type error today, not the word "undefined" in front of
 * a player three chunks from now.
 *
 * `'idle'` reads "Nothing to do", which is C12's "never a bare idle" taken at
 * its word. The criterion is about machines that *could* run and are not; a
 * chest has no work to be stalled on, and saying so is the honest version of
 * the same sentence.
 */
export const STATUS_TEXT: Readonly<Record<MachineStatus, string>> = Object.freeze({
  idle: 'Nothing to do',
  running: 'Running',
  output_full: 'Output full — nothing is taking from it',
  no_resource: 'No ore left under it',
  no_power: 'Not connected to a power network',
  no_input: 'Missing ingredients',
  no_recipe: 'No recipe set',
  no_fuel: 'Out of fuel — progress is paused, not lost',
  no_destination: 'Nowhere to put anything — it is not pointed at a belt, a chest or a machine',
  low_power: 'Low power — the network cannot keep up',
});

/**
 * Which of §11's status tokens each one is painted in. Each tone has its own
 * shape as well (`TONE_ICONS`, C30), so the row reads in greyscale.
 */
export type StatusTone = Exclude<Tone, 'info'>;

export const STATUS_TONE: Readonly<Record<MachineStatus, StatusTone>> = Object.freeze({
  idle: 'idle',
  running: 'ok',
  // Stalled, and the player can fix it: take the ore out, feed it, choose a
  // recipe. Amber is "this needs you".
  output_full: 'warn',
  no_input: 'warn',
  no_recipe: 'warn',
  // Stopped for a reason that will not fix itself without moving something.
  no_fuel: 'warn',
  // C21: the factory works, it is just stretched. Amber for the same reason
  // `output_full` is — it is a number to grow, not a thing that is broken.
  low_power: 'warn',
  no_resource: 'danger',
  no_power: 'danger',
  // Misconfigured rather than stalled: nothing will ever come of it, and it
  // will not announce itself again (C20).
  no_destination: 'danger',
});

/**
 * The POWER line: what this building does to the grid, then how the grid is
 * doing (C21).
 *
 * A generator reads "900 kW supplied", a machine "150 kW drawn", and both then
 * carry the network's own state — because the useful sentence is not "this
 * machine wants 150 kW", it is "it wants 150 kW and its network is at 62%".
 */
export function describePower(power: MachinePowerView): string {
  const role =
    power.productionKw > 0 ? `${power.productionKw} kW supplied` : `${power.consumptionKw} kW drawn`;
  if (!power.connected) return `${role} — no network`;
  return `${role}, network at ${power.satisfactionPercent}%`;
}
