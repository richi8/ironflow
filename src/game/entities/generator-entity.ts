/**
 * The generator: a fuel buffer that becomes kilowatts. See ironflow.md C21
 * task 2 and §15's building table.
 *
 * Three fields, and it is worth saying what is *not* among them. A generator
 * has no recipe, no progress and no output buffer, which is why it is not a
 * `MachineEntity` with an empty half: `production-system.ts` is written around
 * "ingredients in, product out" and a machine whose product is a number on a
 * network would need a branch in every step of that loop. What the two shapes
 * genuinely share — a fuel buffer that burns down a tick at a time — is
 * `items/item-port.ts`'s to hand out and `power-system.ts`'s to count.
 *
 * ## How long one item lasts
 *
 * `burnTicksRemaining` is set when an item is lit and counts down while the
 * generator is supplying. It is **not** the item's `fuelSeconds`: that is the
 * burn time at `FUEL_REFERENCE_KW` (see `GeneratorProperties`), and a
 * generator drawing 900 kW out of a 150 kW-second item gets through it six
 * times faster. The arithmetic is `power-system.ts`'s, done once per item lit
 * and stored here as the integer tick count §6 R3 requires.
 *
 * ## Why the status is stored
 *
 * The same reason every other machine's is (`machine-status.ts`): the
 * *transition* is the event. A generator that has just run out of coal earns
 * one alert, not one per tick, and "did this differ from last tick" is a
 * question only a remembered value can answer.
 */

import type { ItemSlots } from '../items/inventory.js';
import type { BuildingRegistry } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';

import type { Entity } from './entity.js';
import type { EntityType } from './entity-types.js';
import { MachineStatus } from './machine-status.js';

export interface GeneratorEntity extends Entity {
  /** What it has to burn. Plain `ItemSlots`, sorted by item id, as a machine's. */
  fuel: ItemSlots;
  /** Ticks left of the item currently burning. Zero when nothing is lit. */
  burnTicksRemaining: number;
  status: MachineStatus;
}

export type GeneratorInit = Omit<GeneratorEntity, 'id'>;

export function newGenerator(type: EntityType, x: number, y: number, rotation: Rotation): GeneratorInit {
  return {
    type,
    x,
    y,
    rotation,
    fuel: [],
    burnTicksRemaining: 0,
    status: MachineStatus.Idle,
  };
}

/**
 * The entity as a generator, or `null` if it is not one.
 *
 * Asks the *registry* rather than the entity type, exactly as `asMachine`
 * does: "is a generator" means "the content table gave this building a
 * generator config", so a second tier of generator is a row in
 * `data/buildings.ts` and no change here (§19 rule 17).
 */
export function asGenerator(entity: Entity, buildings: BuildingRegistry): GeneratorEntity | null {
  return buildings.generatorFor(entity.type) === null ? null : (entity as GeneratorEntity);
}
