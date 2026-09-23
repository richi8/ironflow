import { describe, expect, it } from 'vitest';

import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * `moveStack` between grids (2026-09-23): the bag and a chest are both
 * `GridInventory`s, and a stack moves, merges or swaps between them by the
 * same rules it follows inside one.
 */
function setup(): { simulation: Simulation; chest: ChestEntity; ore: number; coal: number } {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  simulation.player.setTilePosition(10, 10);
  const chest = simulation.entities.create<ChestEntity>(newChest(11, 10, NORTH));
  return { simulation, chest, ore: simulation.items.idOf('iron_ore'), coal: simulation.items.idOf('coal') };
}

function move(simulation: Simulation, fromEntity: number | null, from: number, toEntity: number | null, to: number | null): string[] {
  simulation.commands.enqueue({ type: 'moveStack', fromEntity, from, toEntity, to });
  simulation.tick();
  return simulation.commands.takeRejections().map((rejection) => rejection.reason);
}

describe('moving stacks between the bag and a chest', () => {
  it('drops a bag stack into a chosen chest slot, and a click sends it back', () => {
    const { simulation, chest, ore } = setup();
    simulation.player.inventory.add(ore, 30);

    expect(move(simulation, null, 0, chest.id, 5)).toEqual([]);
    expect(chest.contents).toEqual([[5, ore, 30]]);
    expect(simulation.player.inventory.count(ore)).toBe(0);

    // `to: null` is "wherever it fits": the bag's own fill order.
    expect(move(simulation, chest.id, 5, null, null)).toEqual([]);
    expect(chest.contents).toEqual([]);
    expect(simulation.player.inventory.cellAt(0)).toEqual([ore, 30]);
  });

  it('merges onto the same item up to a stack, and swaps different items', () => {
    const { simulation, chest, ore, coal } = setup();
    chest.contents = [[0, ore, 40]];
    simulation.player.inventory.add(ore, 30);
    expect(move(simulation, null, 0, chest.id, 0)).toEqual([]);
    expect(chest.contents).toEqual([[0, ore, 50]]);
    expect(simulation.player.inventory.cellAt(0)).toEqual([ore, 20]);

    simulation.player.inventory.add(coal, 7); // slot 1
    expect(move(simulation, null, 1, chest.id, 0)).toEqual([]);
    expect(chest.contents).toEqual([[0, coal, 7]]);
    expect(simulation.player.inventory.cellAt(1)).toEqual([ore, 50]);
  });

  it('rearranges inside the chest', () => {
    const { simulation, chest, ore } = setup();
    chest.contents = [[0, ore, 10]];
    expect(move(simulation, chest.id, 0, chest.id, 23)).toEqual([]);
    expect(chest.contents).toEqual([[23, ore, 10]]);
  });

  it('refuses what cannot happen, and changes nothing', () => {
    const { simulation, chest, ore } = setup();
    expect(move(simulation, null, 0, chest.id, 0)).toEqual(['empty_slot']);

    chest.contents = [[0, ore, 10]];
    simulation.player.setTilePosition(60, 60);
    expect(move(simulation, chest.id, 0, null, null)).toEqual(['out_of_reach']);
    expect(chest.contents).toEqual([[0, ore, 10]]);

    expect(move(simulation, 9999, 0, null, null)).toEqual(['unknown_entity']);
  });
});
