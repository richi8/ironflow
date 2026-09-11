/**
 * One placed building, as a panel may see it. See ironflow.md §13.
 *
 * §13 writes this interface out and C12's inspector is the panel that renders
 * it. The *view* is C07's because the controller's surface is C07's: task 1
 * names `getBuildingView(id)`, and a facade with a hole in it is a facade the
 * next chunk has to widen.
 *
 * **Status must always explain a stall** (§13, pillar 3) — never a bare
 * "idle" where "no_input" is the truth. In C07 nothing can run at all: no
 * machine has a recipe, a buffer or a power connection, so every building is
 * genuinely idle and `'idle'` is the honest answer. C11 gives miners
 * `'running'` and `'output_full'`, C15 gives furnaces the rest.
 */

import type { EntityId } from '../entities/entity.js';
import type { ItemStack } from '../items/item-stack.js';
import type { Rotation } from '../world/coordinates.js';

export type MachineStatus = 'running' | 'no_power' | 'no_input' | 'output_full' | 'no_recipe' | 'idle';

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
