import { describe, expect, it } from 'vitest';

import { initialBuildingState } from '../../src/game/entities/building-init.js';
import type { Entity } from '../../src/game/entities/entity.js';
import { asGenerator } from '../../src/game/entities/generator-entity.js';
import { asLab, type LabEntity } from '../../src/game/entities/lab-entity.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * **C22's acceptance chain**: plates → assembler → data cores → inserter →
 * lab → a technology, and a splitter that can be built at the end of it.
 *
 * ```text
 *   [assembler 3x3]--[inserter]-->[lab 3x3]        180 kW
 *    making data cores                 ^
 *    fed by hand                       |
 *                                  ·pole·
 *                                      |
 *                              [generator 3x3]     900 kW, coal in it
 * ```
 *
 * It is the first chain in the game whose *output is not an item*. What comes
 * out of the lab is a technology, and the thing that proves it arrived is a
 * placement the simulation refused a moment earlier and accepts now — which
 * is C22's second acceptance criterion measured from the far end.
 *
 * The rate it settles at is §15's sharpest new ratio and the reason
 * `make_data_core` is 2.5 s: at a tier-1 assembler's speed 0.5 that is five
 * seconds a core, a research unit is five seconds, and **one assembler feeds
 * exactly one lab**. The test asserts it by running long enough for the
 * assembler to be the thing setting the pace and finding the lab never idle
 * for want of science.
 *
 * Headless: no canvas and no DOM (§17).
 */

const ASSEMBLER = Object.freeze({ x: 0, y: 0 });
const INSERTER = Object.freeze({ x: 3, y: 1 });
const LAB = Object.freeze({ x: 4, y: 0 });
const POLE = Object.freeze({ x: 4, y: 4 });
const GENERATOR = Object.freeze({ x: 3, y: 6 });

function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

function place(simulation: Simulation, buildingId: string, x: number, y: number, rotation: Rotation): Entity {
  const definition = simulation.buildings.get(buildingId);
  return simulation.entities.create(
    initialBuildingState(definition, x, y, BuildingRegistry.normalizeRotation(definition, rotation)),
  );
}

interface Chain {
  readonly simulation: Simulation;
  readonly assembler: MachineEntity;
  readonly lab: LabEntity;
}

function build(): Chain {
  const simulation = new Simulation({ world: flatWorld() });

  const entity = place(simulation, 'assembler', ASSEMBLER.x, ASSEMBLER.y, NORTH);
  const assembler = asMachine(entity, simulation.buildings);
  if (assembler === null) throw new Error('the assembler is not a machine');
  assembler.recipe = simulation.recipes.get('make_data_core').recipeId;
  // Enough gears and copper plates for forty cores: this chain is about what
  // happens *after* the assembler, and a starved assembler would only be a
  // slower way of testing the furnace chains that already exist.
  // **Sorted by item id**, which is the invariant every `ItemSlots` array in
  // the game holds (C08): a buffer written out of order reads as empty.
  assembler.input = [
    [simulation.items.idOf('copper_plate'), 50],
    [simulation.items.idOf('gear'), 50],
  ];

  // An inserter takes from the tile behind it and puts into the tile in front
  // (C14): facing east at (3,1) it moves cores out of the assembler and into
  // the lab's west column.
  place(simulation, 'inserter', INSERTER.x, INSERTER.y, EAST);

  const labEntity = place(simulation, 'lab', LAB.x, LAB.y, NORTH);
  const lab = asLab(labEntity, simulation.buildings);
  if (lab === null) throw new Error('the lab is not a lab');

  // The pole's 5x5 square is centred on (4,4): x 2..6, y 2..6, which covers
  // the lab's south row and the generator's north row.
  place(simulation, 'power_pole', POLE.x, POLE.y, NORTH);
  const generator = place(simulation, 'generator', GENERATOR.x, GENERATOR.y, NORTH);
  const fuel = asGenerator(generator, simulation.buildings);
  if (fuel === null) throw new Error('the generator is not a generator');
  fuel.fuel = [[simulation.items.idOf('coal'), 50]];

  return { simulation, assembler, lab };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

describe('plates -> assembler -> data cores -> lab -> a technology', () => {
  it('researches unattended, and the unlock is buildable the moment it lands', () => {
    const { simulation, lab } = build();
    const logistics = simulation.technologies.get('logistics_1').technologyId;

    simulation.inventory.add('splitter', 1);
    simulation.player.setTilePosition(10, 10);
    // Refused now, and the only thing that will change that is the lab.
    expect(simulation.checkPlacement('splitter', 10, 12, NORTH)).toBe('locked');

    simulation.commands.enqueue({ type: 'startResearch', technologyId: 'logistics_1' });

    // Ten units at five seconds each is fifty seconds of lab time; the first
    // core has to be made and carried across first, so the budget is generous
    // — what is being asserted is that it happens at all, unattended.
    run(simulation, 120 * TPS);

    expect(simulation.research.isUnlocked(logistics)).toBe(true);
    expect(simulation.checkPlacement('splitter', 10, 12, NORTH)).toBeNull();
    expect(
      simulation.commands.enqueue({ type: 'build', buildingId: 'splitter', x: 10, y: 12, rotation: NORTH }),
    ).toBe(true);
    simulation.tick();
    expect(simulation.entities.at(10, 12)).toBeDefined();
    expect(simulation.commands.takeRejections()).toEqual([]);

    // And with the queue empty the lab stops rather than eating the science
    // that keeps arriving: `idle` is "nothing to do and nothing wrong", which
    // is exactly what a factory with no research queued is doing.
    expect(lab.status).toBe(MachineStatus.Idle);
  });

  it('settles at one assembler feeding one lab, with the lab never starved', () => {
    const { simulation, lab } = build();
    simulation.commands.enqueue({ type: 'startResearch', technologyId: 'logistics_1' });
    simulation.commands.enqueue({ type: 'startResearch', technologyId: 'smelting_2' });

    // Sixty seconds of steady state, sampled: a lab fed by exactly one
    // assembler should be working on all but the handful of ticks around each
    // delivery — §15's "one assembler feeds one lab" is a *ratio*, not a
    // promise of zero jitter, so what is asserted is that it is never idle
    // for long rather than never idle at all.
    run(simulation, 20 * TPS);

    let starved = 0;
    const samples = 60 * TPS;
    for (let i = 0; i < samples; i++) {
      simulation.tick();
      if (lab.status === MachineStatus.NoInput) starved += 1;
    }

    // A standard inserter moves one item a second and a core is wanted every
    // five, so the science line has four seconds of slack in every five: the
    // lab should be starved for a small fraction of the run, not a quarter of
    // it. A number this loose is deliberate — it is a *ratio* test, and the
    // exact tick counts belong in `tests/unit/research-system.test.ts`.
    expect(starved / samples).toBeLessThan(0.1);

    // Ten units of `logistics_1` plus a start on `smelting_2`, in eighty
    // seconds of a five-second unit: sixteen units is the ceiling and the
    // first few seconds go on the first core.
    const done =
      simulation.research.unitsOf(simulation.technologies.get('smelting_2').technologyId) + 10;
    expect(done).toBeGreaterThanOrEqual(12);
    expect(done).toBeLessThanOrEqual(16);
  });
});
