import { describe, expect, it } from 'vitest';

import { initialBuildingState } from '../../src/game/entities/building-init.js';
import type { Entity } from '../../src/game/entities/entity.js';
import { asGenerator } from '../../src/game/entities/generator-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';

/**
 * **coal → belt → generator → poles → electric furnace → plates** (C21).
 *
 * The chain C21 exists to make possible, and the one that shows what the
 * chunk actually buys a player. C15's chain ran a coal belt *into the
 * furnace*; this one runs it into a generator and sends the energy on through
 * wire, which is task 6's "fuel logistics vs. power infrastructure" as a
 * factory rather than as a sentence:
 *
 * ```text
 *   [coal miner 2x2] -> belt -> belt -> [inserter] -> [generator 3x3]
 *                                          ·p·                          y=4
 *                                          ·p·                          y=8
 *   [iron miner 2x2] -> belt -> belt -> [inserter] -> [electric furnace 2x2]
 * ```
 *
 * One coal miner is enough, and that is the thing to notice. A generator
 * asked for 150 kW of its 900 burns a sixth of 0.75 coal/s — the same
 * 0.125 coal/s a burner furnace would have eaten — so the trade C21 offers is
 * logistical rather than a tax: one coal line to one generator instead of one
 * to every furnace, and one inserter per furnace instead of two.
 *
 * Nobody touches anything after the layout is down. The assertions are the two
 * that matter: plates come out of a furnace with no fuel buffer at all, and
 * they stop coming out the moment the wire is cut.
 *
 * The layout is created rather than built through commands, for
 * `tests/determinism/reference-factory.ts`'s reason — it is wider than the
 * player can reach, and walking them along it would be a test of `movePlayer`.
 * C13's, C14's and C15's chains cover the command path.
 */

const COAL_MINER = Object.freeze({ x: 0, y: 0 });
const IRON_MINER = Object.freeze({ x: 0, y: 10 });

/** Coal under the top miner, iron under the bottom one, grass everywhere else. */
function oreWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        const patch = patchAt(x, y);
        if (patch === null) continue;
        const index = localIndex(lx, ly);
        chunk.resource[index] = patch;
        chunk.resourceAmount[index] = 10_000;
      }
    }
    return chunk;
  });
}

function patchAt(x: number, y: number): ResourceType | null {
  const inCoal = x >= COAL_MINER.x && x <= COAL_MINER.x + 1 && y >= COAL_MINER.y && y <= COAL_MINER.y + 1;
  if (inCoal) return ResourceType.Coal;
  const inIron = x >= IRON_MINER.x && x <= IRON_MINER.x + 1 && y >= IRON_MINER.y && y <= IRON_MINER.y + 1;
  return inIron ? ResourceType.Iron : null;
}

function place(simulation: Simulation, buildingId: string, x: number, y: number, rotation: Rotation): Entity {
  const definition = simulation.buildings.get(buildingId);
  return simulation.entities.create(
    initialBuildingState(definition, x, y, BuildingRegistry.normalizeRotation(definition, rotation)),
  );
}

interface Factory {
  readonly simulation: Simulation;
  readonly generator: Entity;
  readonly furnace: MachineEntity;
  readonly poles: readonly Entity[];
}

function build(): Factory {
  const simulation = new Simulation({ world: oreWorld() });
  const poles: Entity[] = [];

  // Coal: a miner facing east onto a two-tile belt, then an inserter into the
  // generator's west face.
  place(simulation, 'miner', COAL_MINER.x, COAL_MINER.y, EAST);
  place(simulation, 'belt', 2, 0, EAST);
  place(simulation, 'belt', 3, 0, EAST);
  // An inserter takes from the tile behind it and puts into the tile in front
  // (C14), so one facing east at (4,0) moves coal from the belt into (5,0).
  place(simulation, 'inserter', 4, 0, EAST);
  const generator = place(simulation, 'generator', 5, 0, NORTH);

  // Wire: two poles between the generator and the furnace. The generator
  // covers (5..7, 0..2) and the first pole's square reaches x 2..6, y 2..6;
  // the two poles are four apart, which is inside a wire reach of eight.
  poles.push(place(simulation, 'power_pole', 4, 4, NORTH));
  poles.push(place(simulation, 'power_pole', 4, 8, NORTH));

  // Iron: the same shape again, into an electric furnace with no fuel buffer.
  place(simulation, 'miner', IRON_MINER.x, IRON_MINER.y, EAST);
  place(simulation, 'belt', 2, 10, EAST);
  place(simulation, 'belt', 3, 10, EAST);
  place(simulation, 'inserter', 4, 10, EAST);
  const entity = place(simulation, 'electric_furnace', 5, 10, EAST);
  const furnace = asMachine(entity, simulation.buildings);
  if (furnace === null) throw new Error('the electric furnace is not a machine');

  return { simulation, generator, furnace, poles };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function plates(simulation: Simulation, furnace: MachineEntity): number {
  const plate = simulation.items.idOf('iron_plate');
  return furnace.output.find((entry) => entry[0] === plate)?.[1] ?? 0;
}

describe('coal -> belt -> generator -> poles -> electric furnace', () => {
  it('smelts on power delivered by wire, with no fuel buffer anywhere near the furnace', () => {
    const { simulation, generator, furnace } = build();
    // Thirty seconds: past the belt's travel time, past the generator's first
    // few coal, and long enough for a 3.2 s smelt to complete several times.
    run(simulation, 30 * 30);

    expect(asGenerator(generator, simulation.buildings)?.status).toBe(MachineStatus.Running);
    expect(simulation.power.summary()?.satisfactionPercent).toBe(100);
    expect(furnace.status).toBe(MachineStatus.Running);
    expect(furnace.fuel).toEqual([]);
    expect(plates(simulation, furnace)).toBeGreaterThan(0);
  });

  it('stops the furnace when the wire is cut, and says it is the wire', () => {
    const { simulation, furnace, poles } = build();
    run(simulation, 30 * 30);
    const before = plates(simulation, furnace);

    // Pull the pole beside the furnace. The removal lands in phase 9 (§8), so
    // the tick it is ordered in still has power; the next one does not.
    simulation.entities.remove((poles[1] as Entity).id);
    run(simulation, 2);
    expect(furnace.status).toBe(MachineStatus.NoPower);

    run(simulation, 30 * 10);
    expect(plates(simulation, furnace)).toBe(before);
    expect(simulation.alerts.take().map((alert) => alert.type)).toContain('no_power_network');
  });

  it('runs the generator dry and stalls the furnace when the coal stops arriving', () => {
    const { simulation, generator, furnace } = build();
    run(simulation, 30 * 30);
    expect(plates(simulation, furnace)).toBeGreaterThan(0);

    // Take the coal belt away. Backpressure (§9) is the miner's problem; what
    // this asserts is the other end — a generator with nothing to burn, and a
    // machine that reports no power rather than no input.
    const belt = simulation.entities.at(3, 0);
    simulation.entities.remove(belt?.id ?? 0);
    const inserter = simulation.entities.at(4, 0);
    simulation.entities.remove(inserter?.id ?? 0);

    // One coal is 40 ticks at a full load and 240 at this one; two minutes is
    // past whatever was left in the buffer and on the belt.
    run(simulation, 120 * 30);
    expect(asGenerator(generator, simulation.buildings)?.status).toBe(MachineStatus.NoFuel);
    expect(furnace.status).toBe(MachineStatus.NoPower);
  });
});
