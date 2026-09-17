import { existsSync } from 'node:fs';

import { describe, test } from 'vitest';

import { createStartingWorld } from '../../src/game/world/starting-area.js';
import { createWorldGenerator } from '../../src/game/world/world-generator.js';

/**
 * World generation cost. C19's fourth acceptance criterion.
 *
 * ```text
 * npm run bench            run them against the committed baseline
 * npm run bench:baseline   overwrite that baseline, deliberately
 * ```
 *
 * The criterion is "generating 40×40 world chunks takes < 500 ms", so the
 * headline case generates exactly that and nothing else — no `World`, no map
 * bookkeeping, just the generator, because that is the number the budget names.
 *
 * The other two cases are what makes a regression *locatable*. `one world
 * chunk` is the cost the renderer pays when the player walks over a boundary,
 * which is a frame-time question rather than a loading one; `starting world`
 * is the cost of a new game, which includes however many perturbed seeds
 * validation had to reject.
 *
 * Nothing here asserts, for the reason `systems.bench.ts` gives at length: a
 * benchmark's result is a property of the machine it ran on, and `npm test`
 * must not fail because a laptop was on battery.
 */

/** The world the criterion names: 1,600 world chunks, 1.6 M tiles. */
const BUDGET_CHUNKS = 40;

/** A seed that is not the one the game boots into, so neither case is special. */
const SEED = 0x5eed;

function generateSquare(seed: number, chunks: number): void {
  const generate = createWorldGenerator(seed);
  const first = 0 - Math.floor(chunks / 2);
  for (let cy = first; cy < first + chunks; cy++) {
    for (let cx = first; cx < first + chunks; cx++) {
      generate(cx, cy);
    }
  }
}

function baselinePath(slug: string): string {
  return `tests/bench/baseline/${slug}.json`;
}

const WRITING_BASELINE = process.env['IRONFLOW_BENCH_BASELINE'] === '1';

/**
 * How long a case is allowed to run for, when the default would be absurd.
 *
 * Tinybench's default is "keep going for a second and then some", which for a
 * case that allocates eight megabytes of typed arrays an iteration means
 * hundreds of iterations, gigabytes of garbage and a run that timed out at ten
 * minutes the first time this file existed. The reported mean was then a
 * measure of the garbage collector rather than of the generator: 312 ms at the
 * minimum and 947 *seconds* at the maximum.
 *
 * A handful of iterations is the honest measurement here. The number the
 * criterion asks about is what generating a 40×40 world costs once, from a
 * cold generator, which is what a player waits for — not what it costs on the
 * two hundredth consecutive one.
 */
const HEAVY: { iterations: number; time: number; warmupIterations: number; warmupTime: number } = {
  iterations: 5,
  time: 0,
  warmupIterations: 1,
  warmupTime: 0,
};

interface Case {
  readonly slug: string;
  readonly label: string;
  readonly run: () => void;
  readonly options?: Readonly<Record<string, number>>;
}

const CASES: readonly Case[] = [
  {
    slug: 'worldgen-chunk',
    label: 'one world chunk',
    run: () => {
      generateSquare(SEED, 1);
    },
  },
  {
    slug: 'worldgen-40x40',
    label: `${String(BUDGET_CHUNKS)}x${String(BUDGET_CHUNKS)} world chunks (C19 budget: < 500 ms)`,
    options: HEAVY,
    run: () => {
      generateSquare(SEED, BUDGET_CHUNKS);
    },
  },
  {
    slug: 'worldgen-start',
    label: 'starting world, including seed retries',
    run: (() => {
      let seed = 0;
      return () => {
        // A different seed each iteration, because the whole cost being
        // measured is how many seeds validation rejects before one passes.
        seed = (seed + 2654435761) >>> 0;
        createStartingWorld(seed);
      };
    })(),
  },
];

describe('world generation', () => {
  test('generator throughput', async ({ bench }) => {
    const registrations = [];

    for (const { slug, label, run, options } of CASES) {
      registrations.push(
        bench(
          label,
          { ...options, ...(WRITING_BASELINE ? { writeResult: baselinePath(slug) } : {}) },
          run,
        ),
      );

      if (!WRITING_BASELINE && existsSync(baselinePath(slug))) {
        registrations.push(bench.from(`${label} (baseline)`, baselinePath(slug)));
      }
    }

    await bench.compare(...registrations);
  }, 600_000);
});
