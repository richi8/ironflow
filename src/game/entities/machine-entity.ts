/**
 * A machine that runs a recipe: C15's furnace, and C16's assembler after it.
 * See ironflow.md C15 tasks 3–6.
 *
 * One shape, not one per building. What separates a furnace from an assembler
 * is entirely in `data/buildings.ts` — which recipe category it can run, how
 * big its buffers are, and whether it burns fuel — so `production-system.ts`
 * never asks what kind of machine it is holding, which is task 2's "no
 * per-recipe special cases, ever" taken one step further to buildings.
 *
 * ## The four numbers
 *
 * - `recipe` — what it is making, as a `RecipeId` with `NO_RECIPE` for none.
 *   A furnace picks it from what it is fed; C16's assembler is told.
 * - `progressTicks` — integer ticks into the current craft (§6 R3). It reaches
 *   `durationTicks` and *stays* there when the output has no room: that is how
 *   task 6's "hold the finished item" is stored, without a field for it.
 * - `fuelTicksRemaining` — what is left of the item currently burning. Ticks
 *   down only while the machine is working, so an idle furnace wastes nothing.
 * - the three buffers — plain `ItemSlots`, sorted by item id, same as a
 *   chest's `contents`. `fuel` stays empty for ever in a machine without a
 *   fuel buffer, which costs one empty array and no branches.
 *
 * Progress **pauses** rather than resetting when the fuel runs out (task 4),
 * which is why `fuelTicksRemaining` and `progressTicks` are independent: one
 * gates the other, neither clears it.
 */

import type { ItemSlots } from '../items/inventory.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import { NO_RECIPE, type RecipeId } from '../registries/recipe-registry.js';
import type { Rotation } from '../world/coordinates.js';
import type { Entity } from './entity.js';
import type { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

export interface MachineEntity extends Entity {
  recipe: RecipeId;
  progressTicks: number;
  fuelTicksRemaining: number;
  input: ItemSlots;
  fuel: ItemSlots;
  output: ItemSlots;
  status: MachineStatus;
}

export type MachineInit = Omit<MachineEntity, 'id'>;

export function newMachine(type: EntityType, x: number, y: number, rotation: Rotation): MachineInit {
  return {
    type,
    x,
    y,
    rotation,
    recipe: NO_RECIPE,
    progressTicks: 0,
    fuelTicksRemaining: 0,
    input: [],
    fuel: [],
    output: [],
    status: MachineStatus.Idle,
  };
}

/**
 * The entity as a machine, or `null` if it is not one.
 *
 * Unlike `asMiner` and `asBelt` this asks the *registry*, not the entity type:
 * "is a machine" means "the content table gave this building a production
 * config", so C16 adds the assembler without editing this file.
 */
export function asMachine(entity: Entity, buildings: BuildingRegistry): MachineEntity | null {
  return buildings.productionFor(entity.type) === null ? null : (entity as MachineEntity);
}
