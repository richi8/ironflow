import { gzipSync } from 'node:zlib';

import { afterAll, describe, expect, it } from 'vitest';

import { BUDGETS, judge, type Budget, type Verdict } from '../../src/debug/budgets.js';
import { serialize } from '../../src/game/save/save-serializer.js';
import type { Simulation } from '../../src/game/simulation.js';
import { createWorldGenerator } from '../../src/game/world/world-generator.js';

import { formatProfile, loadReferenceFactory, measurePhases, now } from '../bench/reference-fixture.js';

/**
 * §12's budgets against the reference factory. C28 task 5: "the benchmark
 * fails CI if a hard-fail threshold is crossed."
 *
 * ```sh
 * npm run perf
 * ```
 *
 * Every metric §12 lists that a Node process can measure is measured here,
 * and a **hard fail** fails the run. Crossing a *target* does not — §12 says
 * targets define "done" for C29, not a reason for today's build to go red —
 * but it is printed, so the table at the end of the run is §12's table with
 * this machine's numbers in it.
 *
 * The four §12 rows this cannot measure are the browser's: render frame,
 * sustained FPS, entities on screen and cold start. The F3 overlay reports
 * those against the same `BUDGETS`, and dropping the fixture on the game
 * window is how to read them for the reference factory.
 *
 * ## Why this is not in `npm test`
 *
 * A timing depends on the machine, and `npm test` must not fail because a
 * laptop was busy. The hard-fail lines sit a long way above what the factory
 * costs — at C28 the tick is about 2.5 ms against a 20 ms line — so a failure
 * here is a change in kind, not noise; but the `perf` project also runs its
 * files one at a time, so no measurement shares the CPU with another.
 */

interface Row {
  readonly budget: Budget;
  readonly value: number;
  readonly verdict: Verdict;
}

const rows: Row[] = [];

/** Record a measurement for the closing table, and fail on a hard fail. */
function check(budget: Budget, value: number): void {
  const verdict = judge(budget, value);
  rows.push({ budget, value, verdict });
  expect(verdict, `${budget.label}: ${value.toFixed(2)} ${budget.unit}, hard fail at ${String(budget.hard)}`).not.toBe(
    'hard_fail',
  );
}

afterAll(() => {
  const lines = rows.map(({ budget, value, verdict }) => {
    const mark = verdict === 'ok' ? '  ok  ' : verdict === 'over_target' ? 'TARGET' : ' FAIL ';
    return `  [${mark}] ${budget.label.padEnd(46)} ${value.toFixed(2).padStart(9)} ${budget.unit.padEnd(3)}  target ${budget.target}, hard ${String(budget.hard)}`;
  });
  console.log(`§12 budgets, reference factory:\n${lines.join('\n')}`);
});

/** Time a function once, in milliseconds. */
function time<T>(run: () => T): { readonly value: T; readonly ms: number } {
  const started = now();
  const value = run();
  return { value, ms: now() - started };
}

describe('§12: the reference factory against its budgets', () => {
  let simulation: Simulation;

  it('loads, with rebuildDerived, inside the budget', async () => {
    const started = now();
    simulation = await loadReferenceFactory();
    check(BUDGETS.load, now() - started);

    // What was loaded is the factory §12 describes, not a smaller one.
    expect(simulation.entities.size).toBe(20_000);
  });

  it('holds the JS heap inside the budget', () => {
    // The whole process's heap, test runner included, so this overstates the
    // factory's share; a pass is a pass with room to spare.
    check(BUDGETS.heap, process.memoryUsage().heapUsed / (1024 * 1024));
  });

  it('ticks inside the mean and p99 budgets', () => {
    const profile = measurePhases(simulation);
    console.log(formatProfile('reference factory', profile));
    check(BUDGETS.tickMean, profile.tickMean);
    check(BUDGETS.tickP99, profile.tickP99);
  });

  it('serializes inside the budget, into a file inside the size budget', () => {
    const { value: state, ms } = time(() => serialize(simulation));
    check(BUDGETS.serialize, ms);
    // gzip, as the save codec writes it (C25), so the size is the size on disk.
    const bytes = gzipSync(Buffer.from(JSON.stringify(state))).length;
    check(BUDGETS.saveSize, bytes / (1024 * 1024));
  });

  it('generates 40 x 40 world chunks inside the budget', () => {
    const generate = createWorldGenerator(0x5eed);
    const { ms } = time(() => {
      for (let cy = -20; cy < 20; cy++) for (let cx = -20; cx < 20; cx++) generate(cx, cy);
    });
    check(BUDGETS.worldgen, ms);
  });
});
