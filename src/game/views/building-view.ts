/**
 * One placed building, as a panel may see it. See ironflow.md §13.
 *
 * §13 writes this interface out and C12's inspector is the panel that renders
 * it. The *view* is C07's because the controller's surface is C07's: task 1
 * names `getBuildingView(id)`, and a facade with a hole in it is a facade the
 * next chunk has to widen.
 *
 * **Status must always explain a stall** (§13, pillar 3) — never a bare
 * "idle" where "no_input" is the truth. C11 makes that real for the first
 * time: a miner reports `'running'`, `'output_full'` or `'no_resource'`, and a
 * building with no system behind it — a chest — is still honestly `'idle'`.
 * C15 gives furnaces the rest.
 */

import type { EntityId } from '../entities/entity.js';
import type { MachineStatusName } from '../entities/machine-status.js';
import type { ItemStack } from '../items/item-stack.js';
import type { Rotation } from '../world/coordinates.js';

/**
 * The status names, straight from the enum machines actually store.
 *
 * C07 wrote this union out by hand and C11 gave the simulation a stored
 * status, at which point two lists of the same words would be two lists to
 * keep in step — and the one that drifts is the one the player reads.
 * `entities/machine-status.ts` is the table; this is its name.
 */
export type MachineStatus = MachineStatusName;

export interface MachineView {
  readonly id: EntityId;
  /** The content id, for looking up a sprite or a description. */
  readonly buildingId: string;
  readonly name: string;
  readonly status: MachineStatus;
  /** 0..1, derived from progress ticks — never persisted (§10). */
  readonly progress: number;
  readonly inputs: readonly ItemStack[];
  readonly outputs: readonly ItemStack[];
  readonly ratePerMinute: number;
  /** The footprint's north-west tile. */
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}
