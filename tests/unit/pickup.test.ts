import { describe, expect, it } from 'vitest';

import type { BeltEntity } from '../../src/game/entities/belt-entity.js';
import { BELT_TILE_UNITS } from '../../src/game/entities/belt-entity.js';
import type { SplitterEntity } from '../../src/game/entities/splitter-entity.js';
import { asUnderground, undergroundLaneUnits } from '../../src/game/entities/underground-belt-entity.js';
import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * F: pick items up off the belts around the player (2026-09-23), as Factorio
 * does. Held, one item a tick, the nearest first, within one tile of the
 * player's centre along each axis, and only what the bag has room for.
 */

function newGame(): Simulation {
  const simulation = new Simulation({ world: new World((cx, cy) => createChunk(cx, cy)) });
  simulation.researchSystem.grant('logistics_1');
  return simulation;
}

function build(simulation: Simulation, id: string, x: number, y: number, rotation: Rotation = EAST): void {
  simulation.inventory.add(id, 1);
  simulation.player.setTilePosition(x, y);
  simulation.commands.enqueue({ type: 'build', buildingId: id, x, y, rotation });
  simulation.tick();
  expect(simulation.commands.takeRejections()).toEqual([]);
}

function plates(simulation: Simulation, count: number): { itemId: number; pos: number }[] {
  const itemId = simulation.items.idOf('iron_plate');
  // Front-first, a slot apart, as a lane keeps them.
  return Array.from({ length: count }, (_, i) => ({ itemId, pos: 255 - i * 64 }));
}

function hold(simulation: Simulation, held: boolean): void {
  simulation.commands.enqueue({ type: 'pickUp', held });
}

describe('picking up with F', () => {
  it('takes one item a tick off the belt underfoot while held, and stops on release', () => {
    const simulation = newGame();
    build(simulation, 'belt', 0, 0, NORTH);
    const belt = simulation.entities.at(0, 0) as BeltEntity;
    belt.items.push(...plates(simulation, 4));
    simulation.player.setTilePosition(0, 0);

    hold(simulation, true);
    simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(1);
    simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(2);

    hold(simulation, false);
    simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(2);
    expect(belt.items).toHaveLength(2);
  });

  it('reaches one tile, not two', () => {
    const simulation = newGame();
    build(simulation, 'belt', 1, 0, NORTH);
    build(simulation, 'belt', 3, 0, NORTH);
    (simulation.entities.at(1, 0) as BeltEntity).items.push(...plates(simulation, 1));
    (simulation.entities.at(3, 0) as BeltEntity).items.push(...plates(simulation, 1));
    simulation.player.setTilePosition(0, 0);

    hold(simulation, true);
    for (let i = 0; i < 5; i++) simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(1);
    expect((simulation.entities.at(3, 0) as BeltEntity).items).toHaveLength(1);
  });

  it('takes from a splitter', () => {
    const simulation = newGame();
    build(simulation, 'splitter', 0, 0, NORTH);
    const splitter = simulation.entities.at(0, 0) as SplitterEntity;
    splitter.lanes[0].push(...plates(simulation, 1));
    splitter.lanes[1].push(...plates(simulation, 1));
    simulation.player.setTilePosition(0, 0);

    hold(simulation, true);
    for (let i = 0; i < 3; i++) simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(2);
  });

  it('takes from the exit end of an underground run, but not from inside it', () => {
    const simulation = newGame();
    build(simulation, 'underground_belt', 0, 0, EAST);
    build(simulation, 'underground_belt', 4, 0, EAST);
    const entrance = asUnderground(simulation.entities.at(0, 0) as BeltEntity, simulation.buildings);
    if (entrance === null) throw new Error('no entrance');
    const units = undergroundLaneUnits(entrance, simulation.entities.get(entrance.link));
    const itemId = simulation.items.idOf('iron_plate');
    // One at the exit edge, one in the middle of the tunnel.
    entrance.items.push({ itemId, pos: units - 1 }, { itemId, pos: 2 * BELT_TILE_UNITS });
    simulation.player.setTilePosition(4, 0);

    hold(simulation, true);
    simulation.tick();
    expect(simulation.inventory.count('iron_plate')).toBe(1);
    expect(entrance.items).toHaveLength(1);
  });

  it('leaves what the bag has no room for', () => {
    const simulation = newGame();
    build(simulation, 'belt', 0, 0, NORTH);
    const belt = simulation.entities.at(0, 0) as BeltEntity;
    belt.items.push(...plates(simulation, 1));
    while (simulation.inventory.add('stone', 1000) > 0);
    simulation.player.setTilePosition(0, 0);

    hold(simulation, true);
    simulation.tick();
    expect(belt.items).toHaveLength(1);
  });

  it('survives a save while held', () => {
    const simulation = newGame();
    hold(simulation, true);
    simulation.tick();
    expect(simulation.player.pickingUp).toBe(true);
    expect(deserialize(serialize(simulation)).player.pickingUp).toBe(true);
  });
});
