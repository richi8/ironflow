import { describe, expect, it } from 'vitest';

import { Profiler, RollingWindow } from '../../src/debug/profiler.js';
import { PHASE_COUNT, PHASE_NAMES, Phase, type PhaseTimer } from '../../src/game/phase-timer.js';
import { Simulation } from '../../src/game/simulation.js';
import { World } from '../../src/game/world/world.js';

import { hashState } from '../determinism/state-hash.js';
import { layReferenceFactory, oreEverywhere } from '../determinism/reference-factory.js';

/**
 * C28 task 1: the profiler, and the simulation's side of it.
 *
 * Timing against a real clock is `tests/perf/`'s job. These are the parts that
 * do not depend on the machine: that the simulation reports every phase, once,
 * in §8's order; that a profiler turns those reports into the right
 * durations; and that "disabled" means the simulation does nothing at all.
 */

/** A clock that advances by a scripted amount on every read. */
function scriptedClock(steps: readonly number[]): () => number {
  let now = 0;
  let index = 0;
  return () => {
    now += steps[index % steps.length] ?? 0;
    index += 1;
    return now;
  };
}

function factory(): Simulation {
  const simulation = new Simulation({ world: new World(oreEverywhere()) });
  layReferenceFactory(simulation);
  return simulation;
}

describe('RollingWindow', () => {
  it('keeps the most recent samples and forgets the oldest', () => {
    const window = new RollingWindow(3);
    for (const value of [100, 1, 2, 3]) window.push(value);
    expect(window.size).toBe(3);
    expect(window.mean()).toBe(2);
    expect(window.max()).toBe(3);
  });

  it('answers a quantile with a sample that actually happened', () => {
    const window = new RollingWindow(100);
    for (let i = 1; i <= 100; i++) window.push(i);
    expect(window.quantile(0.99)).toBe(99);
    expect(window.quantile(0.5)).toBe(50);
    expect(window.quantile(1)).toBe(100);
    expect(window.quantile(0)).toBe(1);
  });

  it('ignores samples above a ceiling when asked for the largest', () => {
    const window = new RollingWindow(4);
    for (const value of [16, 70, 5_000, 18]) window.push(value);
    expect(window.max()).toBe(5_000);
    expect(window.max(1_000)).toBe(70);
  });

  it('reports zeros, not NaN, when empty', () => {
    const window = new RollingWindow(4);
    expect([window.mean(), window.max(), window.quantile(0.99)]).toEqual([0, 0, 0]);
  });

  it('refuses a capacity that is not a whole positive number', () => {
    expect(() => new RollingWindow(0)).toThrow(RangeError);
    expect(() => new RollingWindow(2.5)).toThrow(RangeError);
  });
});

describe('Profiler', () => {
  it('attributes to each phase the time between its report and the one before', () => {
    // beginTick reads 0 + 1; then each phase advances the clock by its index + 1.
    const steps = [1, ...Array.from({ length: PHASE_COUNT }, (_, phase) => phase + 1)];
    const profiler = new Profiler(scriptedClock(steps), 10);

    profiler.beginTick();
    for (let phase = 0; phase < PHASE_COUNT; phase++) profiler.endPhase(phase as Phase);

    const snapshot = profiler.snapshot();
    expect(snapshot.ticks).toBe(1);
    expect(snapshot.phases.map((phase) => phase.mean)).toEqual(
      Array.from({ length: PHASE_COUNT }, (_, phase) => phase + 1),
    );
    // 1 + 2 + ... + 10: the tick is exactly the sum of its phases.
    expect(snapshot.tick.mean).toBe(55);
  });

  it('drops a tick that never finished rather than folding it into the next', () => {
    const profiler = new Profiler(scriptedClock([1]), 10);
    profiler.beginTick();
    profiler.endPhase(Phase.Commands);
    // A system threw: no Cleanup report. The next tick starts clean.
    profiler.beginTick();
    for (let phase = 0; phase < PHASE_COUNT; phase++) profiler.endPhase(phase as Phase);

    const snapshot = profiler.snapshot();
    expect(snapshot.ticks).toBe(1);
    expect(snapshot.tick.mean).toBe(PHASE_COUNT);
  });

  it('forgets everything on reset', () => {
    const profiler = new Profiler(scriptedClock([1]), 10);
    profiler.beginTick();
    for (let phase = 0; phase < PHASE_COUNT; phase++) profiler.endPhase(phase as Phase);
    profiler.reset();
    expect(profiler.snapshot().ticks).toBe(0);
  });
});

describe('Simulation with a phase timer', () => {
  it('reports every phase once per tick, in §8 order', () => {
    const calls: string[] = [];
    const timer: PhaseTimer = {
      beginTick: () => calls.push('begin'),
      endPhase: (phase) => calls.push(PHASE_NAMES[phase] ?? '?'),
    };
    const simulation = factory();
    simulation.setPhaseTimer(timer);
    simulation.tick();
    simulation.tick();

    const oneTick = ['begin', ...PHASE_NAMES];
    expect(calls).toEqual([...oneTick, ...oneTick]);
  });

  it('calls nothing and reads no clock once the timer is removed', () => {
    // C28: "0 when disabled". Zero cannot be measured, so it is asserted: a
    // disabled tick does not so much as look at the timer.
    let reads = 0;
    const profiler = new Profiler(() => {
      reads += 1;
      return reads;
    });
    const simulation = factory();
    simulation.setPhaseTimer(profiler);
    simulation.tick();
    expect(reads).toBe(PHASE_COUNT + 1);

    simulation.setPhaseTimer(null);
    for (let tick = 0; tick < 100; tick++) simulation.tick();
    expect(reads).toBe(PHASE_COUNT + 1);
  });

  it('changes nothing the simulation computes (§6)', () => {
    const timed = factory();
    timed.setPhaseTimer(new Profiler(scriptedClock([0.25, 3, 0.5])));
    const untimed = factory();
    for (let tick = 0; tick < 300; tick++) {
      timed.tick();
      untimed.tick();
    }
    expect(hashState(timed)).toBe(hashState(untimed));
  });
});
