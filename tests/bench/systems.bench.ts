import { existsSync } from 'node:fs';

import { describe, test } from 'vitest';

import { newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newInserter, type InserterEntity } from '../../src/game/entities/inserter-entity.js';
import { newMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { newSplitter, type SplitterEntity } from '../../src/game/entities/splitter-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST } from '../../src/game/world/coordinates.js';

import { layReferenceFactory, oreEverywhere, referenceWorld } from '../determinism/reference-factory.js';
import { loadReferenceFactory } from './reference-fixture.js';
import { World } from '../../src/game/world/world.js';
import { stacked } from '../fixtures/chest.js';

/**
 * Per-system tick cost. C18 task 7, and the baseline §12 is measured against.
 *
 * ```text
 * npm run bench            run them, and print each against the committed
 *                          baseline in tests/bench/baseline/ (the table only
 *                          appears under the verbose reporter, which is why
 *                          the script asks for it)
 * npm run bench:baseline   overwrite that baseline — a deliberate act, and a
 *                          reviewable diff, because it is the moment a
 *                          regression stops being visible
 * ```
 *
 * ## Why "per system" is a factory made of one thing
 *
 * The systems are private to `Simulation` and should stay that way: exposing
 * them so a benchmark could call one directly would widen the public surface
 * for the sake of a measurement, and would measure a system running *outside*
 * the phase order it actually runs in. So each case below is a whole
 * simulation tick over a factory made almost entirely of one kind of building,
 * and the number it reports is that system's marginal cost at that scale. The
 * `reference factory` case is the mixture, and is the one that maps onto §12's
 * "simulation tick, mean" budget.
 *
 * Every case holds **1,000 entities** so the numbers are comparable to each
 * other — except the last, which is §12's real reference factory, twenty
 * times that, loaded from the save fixture C28 built
 * (`tests/fixtures/reference-factory.ifsave`). Its per-*phase* cost, which
 * this file cannot see, is `npm run perf`'s: `tests/perf/regression.perf.test.ts`.
 *
 * ## Why nothing here asserts
 *
 * A benchmark's result is a property of the machine it ran on. `npm test` must
 * not fail because a laptop was on battery, so these run under their own
 * command and the committed baseline is there to make a regression *visible*
 * to a person, which is exactly what C18 task 7 asks for. §16 says not to
 * optimise before the profiler says so; this is what would say so.
 */

/** Entities per case, so the numbers can be compared with one another. */
const SIZE = 1_000;

/** Ticks per measured iteration. Enough that per-call overhead disappears. */
const TICKS = 50;

/** Run the simulation forward; the body of every case below. */
function run(simulation: Simulation, ticks = TICKS): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** A simulation on an ore field, with nothing built. */
function empty(): Simulation {
  return new Simulation({ world: new World(oreEverywhere()) });
}

/**
 * Warm a factory into steady state before it is measured.
 *
 * A belt line that is still filling costs less per tick than a full one, and a
 * benchmark that measured the first fifty ticks of a cold factory would report
 * a number no running game ever sees.
 */
function warm(simulation: Simulation): Simulation {
  run(simulation, 600);
  return simulation;
}

/** `SIZE` belt tiles in long straight lines, each ending in a chest. */
function belts(): Simulation {
  const simulation = empty();
  const lineLength = 48;
  for (let line = 0; line * lineLength < SIZE; line++) {
    const y = line * 2;
    for (let i = 0; i < lineLength; i++) {
      simulation.entities.create<BeltEntity>(newBelt(i, y, EAST));
    }
    // A miner at the head keeps items flowing, and a chest at the tail keeps
    // the line from backing up into a row of stationary items.
    simulation.entities.create<MinerEntity>(newMiner(0 - 2, y, EAST));
    simulation.entities.create<ChestEntity>(newChest(lineLength, y, EAST));
  }
  return warm(simulation);
}

/** `SIZE / 13` cells of the mixed reference factory. */
function referenceFactory(): Simulation {
  const simulation = new Simulation({ world: referenceWorld() });
  layReferenceFactory(simulation);
  return warm(simulation);
}

/** `SIZE` miners on ore, each with a chest to fill. */
function miners(): Simulation {
  const simulation = empty();
  for (let i = 0; i < SIZE / 2; i++) {
    const x = (i % 32) * 3;
    const y = Math.floor(i / 32) * 3;
    simulation.entities.create<MinerEntity>(newMiner(x, y, EAST));
    simulation.entities.create<ChestEntity>(newChest(x + 2, y, EAST));
  }
  return warm(simulation);
}

/** `SIZE` inserters moving items between pairs of chests. */
function inserters(): Simulation {
  const simulation = empty();
  for (let i = 0; i < SIZE / 3; i++) {
    const x = (i % 32) * 4;
    const y = Math.floor(i / 32) * 2;
    const source = simulation.entities.create<ChestEntity>(newChest(x, y, EAST));
    // A full source, so every inserter is swinging rather than idling.
    source.contents = stacked(simulation, [[simulation.items.idOf('iron_ore'), 500]]);
    simulation.entities.create<InserterEntity>(newInserter(x + 1, y, EAST));
    simulation.entities.create<ChestEntity>(newChest(x + 2, y, EAST));
  }
  return warm(simulation);
}

/** `SIZE` splitters, each fed by a belt and emptying into two chests. */
function splitters(): Simulation {
  const simulation = empty();
  for (let i = 0; i < SIZE / 5; i++) {
    const x = (i % 24) * 6;
    const y = Math.floor(i / 24) * 3;
    simulation.entities.create<MinerEntity>(newMiner(x - 2, y, EAST));
    simulation.entities.create<BeltEntity>(newBelt(x, y, EAST));
    simulation.entities.create<SplitterEntity>(newSplitter(x + 1, y, EAST));
    simulation.entities.create<ChestEntity>(newChest(x + 2, y, EAST));
    simulation.entities.create<ChestEntity>(newChest(x + 2, y + 1, EAST));
  }
  return warm(simulation);
}

/** `SIZE` furnaces, each stocked with ore and coal and left to smelt. */
function furnaces(): Simulation {
  const simulation = empty();
  const ore = simulation.items.idOf('iron_ore');
  const coal = simulation.items.idOf('coal');
  for (let i = 0; i < SIZE; i++) {
    const x = (i % 32) * 3;
    const y = Math.floor(i / 32) * 3;
    const furnace = simulation.entities.create<MachineEntity>(newMachine(EntityType.Furnace, x, y, EAST));
    furnace.input = [[ore, 50]];
    furnace.fuel = [[coal, 50]];
  }
  return warm(simulation);
}

/**
 * §12's reference factory, as the save fixture has it (C28). Already at steady
 * state — the fixture was saved after a warm-up — so it is not warmed again:
 * its furnaces carry a few minutes of coal, and a benchmark should spend it
 * measuring rather than waiting.
 */
async function referenceFixture(): Promise<Simulation> {
  return loadReferenceFactory();
}

/** An empty world, so the cost of a tick with nothing in it is on the record. */
function idle(): Simulation {
  return warm(empty());
}

/** Where a committed baseline for one case lives. */
function baselinePath(slug: string): string {
  return `tests/bench/baseline/${slug}.json`;
}

/**
 * Is this the run that *replaces* the baseline?
 *
 * Set by `npm run bench:baseline` and by nothing else. An ordinary `npm run
 * bench` must never overwrite the file it is comparing against, or a
 * regression would silently become the new normal on the first run after it
 * landed — which is the one failure mode a committed baseline exists to
 * prevent.
 */
const WRITING_BASELINE = process.env['IRONFLOW_BENCH_BASELINE'] === '1';

const CASES: readonly { slug: string; label: string; build: () => Simulation | Promise<Simulation> }[] = [
  { slug: 'idle', label: 'idle (no entities)', build: idle },
  { slug: 'belts', label: 'belts', build: belts },
  { slug: 'miners', label: 'miners', build: miners },
  { slug: 'inserters', label: 'inserters', build: inserters },
  { slug: 'splitters', label: 'splitters', build: splitters },
  { slug: 'furnaces', label: 'furnaces', build: furnaces },
  { slug: 'reference-factory', label: 'reference factory (mixed)', build: referenceFactory },
  { slug: 'reference-fixture', label: 'reference factory, §12 fixture (20,000)', build: referenceFixture },
];

describe('simulation tick, by system', () => {
  test(`${String(SIZE)} entities, ${String(TICKS)} ticks an iteration`, async ({ bench }) => {
    const registrations = [];

    for (const { slug, label, build } of CASES) {
      // Built once, outside the measured body: a benchmark that rebuilt a
      // thousand entities per iteration would be timing `EntityStore.create`.
      const simulation = await build();
      registrations.push(
        bench(
          label,
          WRITING_BASELINE ? { writeResult: baselinePath(slug) } : {},
          () => {
            run(simulation);
          },
        ),
      );

      // The committed number beside the fresh one, so a regression is a row in
      // the table rather than something a person has to remember.
      if (!WRITING_BASELINE && existsSync(baselinePath(slug))) {
        registrations.push(bench.from(`${label} (baseline)`, baselinePath(slug)));
      }
    }

    await bench.compare(...registrations);
  }, 600_000);
});
