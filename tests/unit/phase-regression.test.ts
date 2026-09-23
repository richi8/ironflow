import { describe, expect, it } from 'vitest';

import { PHASE_NAMES } from '../../src/game/phase-timer.js';

import { findRegressions, type PhaseProfile } from '../bench/reference-fixture.js';

/**
 * The regression detector the perf suite fails on (C28), with made-up numbers.
 *
 * `tests/perf/regression.perf.test.ts` checks it against a real slowdown on
 * the real factory; this checks the arithmetic with none of the noise, so a
 * failure there can be told apart from a bug here.
 */

function profile(phases: Readonly<Record<string, number>>): PhaseProfile {
  const all: Record<string, number> = {};
  for (const name of PHASE_NAMES) all[name] = phases[name] ?? 0.001;
  const tickMean = Object.values(all).reduce((a, b) => a + b, 0);
  return { ticks: 600, tickMean, tickP99: tickMean, phases: all };
}

const BASELINE = profile({ power: 0.1, mining: 0.2, production: 0.2, belts: 1.0, inserters: 1.0 });

function scaled(by: number, only?: string, onlyBy = by): PhaseProfile {
  const phases: Record<string, number> = {};
  for (const name of PHASE_NAMES) phases[name] = (BASELINE.phases[name] ?? 0) * (name === only ? onlyBy : by);
  return profile(phases);
}

describe('findRegressions', () => {
  it('finds nothing when the factory runs as it did', () => {
    expect(findRegressions(BASELINE, BASELINE)).toEqual([]);
  });

  it('finds nothing on a machine that is uniformly slower, or faster', () => {
    expect(findRegressions(BASELINE, scaled(1.6))).toEqual([]);
    expect(findRegressions(BASELINE, scaled(0.5))).toEqual([]);
  });

  it('blames the one phase that doubled, and only it', () => {
    for (const phase of ['mining', 'production', 'belts', 'inserters']) {
      const found = findRegressions(BASELINE, scaled(1, phase, 2));
      expect(found.map((regression) => regression.phase)).toEqual([phase]);
      expect(found[0]?.ratio).toBeCloseTo(2, 5);
    }
  });

  it('still blames it on a slower machine', () => {
    // Everything 30% slower, and belts twice as slow on top of that.
    const found = findRegressions(BASELINE, scaled(1.3, 'belts', 2.6));
    expect(found.map((regression) => regression.phase)).toEqual(['belts']);
  });

  it('does not judge a phase too small to measure', () => {
    // Research is a microsecond; a microsecond doubles on noise.
    expect(findRegressions(BASELINE, scaled(1, 'research', 10))).toEqual([]);
  });

  it('lets a phase get a little slower without calling it a regression', () => {
    expect(findRegressions(BASELINE, scaled(1, 'belts', 1.3))).toEqual([]);
  });
});
