import { describe, expect, it } from 'vitest';

import { Profiler } from '../../src/debug/profiler.js';
import { PHASE_COUNT, Phase } from '../../src/game/phase-timer.js';

import { WARMUP_TICKS, loadReferenceFactory, now } from '../bench/reference-fixture.js';

/**
 * The profiler's own cost, and whether its numbers can be believed. C28:
 *
 * > The profiler costs < 0.1 ms/tick when enabled and 0 when disabled.
 * > The numbers are trustworthy (validated against manual `performance.now`
 * > measurement).
 *
 * "0 when disabled" is not measured here, because nothing can measure zero:
 * it is a property of the code — a disabled tick reads no clock and calls
 * nothing — and `tests/unit/profiler.test.ts` asserts it directly.
 */

/** Ticks of profiler work timed at once, so the clock's own resolution vanishes. */
const OVERHEAD_TICKS = 20_000;

/** C28's ceiling. */
const MAX_OVERHEAD_MS = 0.1;

/** How far the profiler's tick may sit from a stopwatch around `tick()`. */
const MAX_DISAGREEMENT = 0.05;

describe('the profiler', () => {
  it('costs well under 0.1 ms a tick when enabled', () => {
    const profiler = new Profiler(now);
    const run = (): void => {
      for (let tick = 0; tick < OVERHEAD_TICKS; tick++) {
        profiler.beginTick();
        for (let phase = 0; phase < PHASE_COUNT; phase++) profiler.endPhase(phase as Phase);
      }
    };
    run(); // compiled before it is timed

    const started = now();
    run();
    const perTick = (now() - started) / OVERHEAD_TICKS;
    console.log(`profiler overhead: ${(perTick * 1000).toFixed(2)} µs a tick`);
    expect(perTick).toBeLessThan(MAX_OVERHEAD_MS);
  });

  it('agrees with a stopwatch around tick() to within 5%', async () => {
    const simulation = await loadReferenceFactory();
    const ticks = 600;
    const profiler = new Profiler(now, ticks);
    simulation.setPhaseTimer(profiler);
    for (let tick = 0; tick < WARMUP_TICKS; tick++) simulation.tick();
    profiler.reset();

    // The manual measurement: `performance.now` either side of every call,
    // which is what the profiler claims to be doing more finely.
    let stopwatch = 0;
    for (let tick = 0; tick < ticks; tick++) {
      const started = now();
      simulation.tick();
      stopwatch += now() - started;
    }
    simulation.setPhaseTimer(null);

    const snapshot = profiler.snapshot();
    const manual = stopwatch / ticks;
    console.log(`tick mean: profiler ${snapshot.tick.mean.toFixed(4)} ms, stopwatch ${manual.toFixed(4)} ms`);

    expect(snapshot.ticks).toBe(ticks);
    expect(Math.abs(snapshot.tick.mean - manual) / manual).toBeLessThan(MAX_DISAGREEMENT);

    // And the parts add up to the whole: every microsecond of the tick is in
    // some phase, so there is nowhere for a cost to hide from the table.
    const phases = snapshot.phases.reduce((sum, phase) => sum + phase.mean, 0);
    expect(phases).toBeCloseTo(snapshot.tick.mean, 9);
  });
});
