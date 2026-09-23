import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { Phase } from '../../src/game/phase-timer.js';

import {
  findRegressions,
  formatProfile,
  loadReferenceFactory,
  measurePhases,
  slowedPhase,
  type PhaseProfile,
} from '../bench/reference-fixture.js';

/**
 * Per-phase cost of the reference factory against a committed baseline. C28
 * task 4 and the acceptance criteria that go with it:
 *
 * > Baselines are committed; a deliberate 2× slowdown in one system is
 * > detected.
 * > Benchmark harness reproducibility (< 5% variance across runs).
 *
 * ```sh
 * npm run perf             compare against tests/bench/baseline/reference-fixture-phases.json
 * npm run perf:baseline    overwrite it — a deliberate act and a reviewable diff
 * ```
 *
 * A phase is a regression when it got slower **than the rest of the tick
 * did** (`findRegressions` says why), so a baseline written on one laptop is
 * still a fair judge on another. It is not a judge of the tick as a whole:
 * that is `budgets.perf.test.ts`, against §12's absolute lines.
 */

const BASELINE = new URL('../bench/baseline/reference-fixture-phases.json', import.meta.url);

/** Set by `npm run perf:baseline` and nothing else; see `systems.bench.ts`. */
const WRITING_BASELINE = process.env['IRONFLOW_BENCH_BASELINE'] === '1';

/** Runs per reproducibility check. Each on a freshly loaded factory. */
const RUNS = 5;

/** §17: "< 5% variance across runs", read as a coefficient of variation. */
const MAX_VARIATION = 0.05;

/** One run of the harness on a fresh load, as a benchmark run would be. */
async function freshRun(wrap?: Parameters<typeof measurePhases>[2]): Promise<PhaseProfile> {
  return measurePhases(await loadReferenceFactory(), undefined, wrap);
}

describe('the reference factory, phase by phase', () => {
  it('reproduces within 5% across runs', async () => {
    // The first run in a process pays for compiling every system; it is the
    // JIT's number, not the factory's, so it is run and thrown away.
    await freshRun();

    const means: number[] = [];
    for (let run = 0; run < RUNS; run++) means.push((await freshRun()).tickMean);

    const mean = means.reduce((a, b) => a + b, 0) / means.length;
    const deviation = Math.sqrt(means.reduce((a, b) => a + (b - mean) ** 2, 0) / means.length);
    console.log(`tick mean over ${RUNS} runs: ${means.map((m) => m.toFixed(3)).join(', ')} ms`);
    expect(deviation / mean).toBeLessThan(MAX_VARIATION);
  });

  it('has not regressed against the committed baseline', async () => {
    const current = await freshRun();

    if (WRITING_BASELINE) {
      writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      console.log(formatProfile('new baseline', current));
      return;
    }

    expect(existsSync(BASELINE), 'no committed baseline: run `npm run perf:baseline`').toBe(true);
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as PhaseProfile;
    console.log(formatProfile('reference factory', current, baseline));
    expect(findRegressions(baseline, current)).toEqual([]);
  });

  it('detects one system running twice as slow, and blames that one', async () => {
    const before = await freshRun();

    // Every phase big enough to be judged, doubled in turn. A detector that
    // only noticed the biggest phase would pass a test of belts alone.
    for (const phase of [Phase.Mining, Phase.Production, Phase.Belts, Phase.Inserters]) {
      const after = await freshRun(slowedPhase(phase));
      const found = findRegressions(before, after).map((regression) => regression.phase);
      expect(found, `doubling phase ${Phase[phase]}`).toEqual([Phase[phase].toLowerCase()]);
    }
  });
});
