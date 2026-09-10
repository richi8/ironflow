import { describe, expect, it } from 'vitest';

import { GameLoop } from '../../src/game/game-loop.js';
import { MAX_FRAME_US, MAX_STEPS_PER_FRAME, SimulationClock, TPS } from '../../src/game/simulation-clock.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

function makeLoop(): { loop: GameLoop; scheduler: FakeScheduler; ticks: () => number } {
  const scheduler = new FakeScheduler();
  let ticks = 0;
  const loop = new GameLoop(scheduler, {
    tick: () => {
      ticks += 1;
    },
    render: () => {},
  });
  return { loop, scheduler, ticks: () => ticks };
}

/** Deterministic jitter, so a failure is always the same failure. */
function makeJitter(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('SimulationClock', () => {
  it('runs no ticks on the very first frame', () => {
    const clock = new SimulationClock();
    expect(clock.advance(0).steps).toBe(0);
  });

  it('turns 100 ms of frames into exactly 3 ticks', () => {
    const clock = new SimulationClock();
    clock.reset(0);

    // As one frame...
    expect(clock.advance(100_000).steps).toBe(3);

    // ...and as ten, which must agree.
    const split = new SimulationClock();
    split.reset(0);
    let total = 0;
    for (let i = 1; i <= 10; i++) total += split.advance(i * 10_000).steps;
    expect(total).toBe(3);
  });

  it('caps a long stall at MAX_STEPS_PER_FRAME and sheds the remaining debt', () => {
    const clock = new SimulationClock();
    clock.reset(0);

    const budget = clock.advance(5_000_000); // five seconds in one frame

    expect(budget.steps).toBe(MAX_STEPS_PER_FRAME);
    expect(budget.shed).toBe(true);
    expect(budget.alpha).toBe(0);
    expect(clock.getShedCount()).toBe(1);
  });

  it('clamps a single frame to MAX_FRAME_US before it can accumulate', () => {
    const clock = new SimulationClock();
    clock.reset(0);
    clock.advance(MAX_FRAME_US * 100);
    // Everything beyond the clamp is discarded, so the next frame starts clean.
    expect(clock.advance(MAX_FRAME_US * 100 + 33_334).steps).toBe(1);
  });

  it('never runs a tick backwards when the clock is not monotonic', () => {
    const clock = new SimulationClock();
    clock.reset(1_000_000);
    expect(clock.advance(500_000).steps).toBe(0);
    expect(clock.advance(533_334).steps).toBe(1);
  });

  it('credits no elapsed time across a reset', () => {
    const clock = new SimulationClock();
    clock.reset(0);
    clock.reset(60_000_000); // sixty seconds hidden
    expect(clock.advance(60_000_000).steps).toBe(0);
  });

  it('produces the same tick count for regular and irregular frame timing', () => {
    const TOTAL_US = 10_000_000; // ten seconds
    const EXPECTED_TICKS = (TOTAL_US / 1_000_000) * TPS;

    const regular = new SimulationClock();
    regular.reset(0);
    let regularTicks = 0;
    for (let t = 16_000; t <= TOTAL_US; t += 16_000) {
      regularTicks += regular.advance(t).steps;
    }

    const irregular = new SimulationClock();
    irregular.reset(0);
    const jitter = makeJitter(0xc0ffee);
    let irregularTicks = 0;
    let now = 0;
    while (now < TOTAL_US) {
      // 5..120 ms: jittery, but never long enough to trip the step cap.
      const dt = Math.min(5_000 + Math.floor(jitter() * 115_000), TOTAL_US - now);
      now += dt;
      irregularTicks += irregular.advance(now).steps;
    }

    expect(regularTicks).toBe(EXPECTED_TICKS);
    expect(irregularTicks).toBe(EXPECTED_TICKS);
  });
});

describe('GameLoop', () => {
  it('does not tick before it is started', () => {
    const { scheduler, ticks } = makeLoop();
    scheduler.runFrame(100_000);
    expect(ticks()).toBe(0);
  });

  it('ticks at TPS regardless of frame rate', () => {
    for (const frameUs of [4_000, 16_000, 33_333, 50_000]) {
      const { loop, scheduler, ticks } = makeLoop();
      loop.start();
      for (let elapsed = 0; elapsed < 3_000_000; elapsed += frameUs) {
        scheduler.runFrame(frameUs);
      }
      // Three seconds of simulated time at 30 TPS, allowing one tick of
      // rounding where the frame size does not divide the interval evenly.
      expect(ticks()).toBeGreaterThanOrEqual(89);
      expect(ticks()).toBeLessThanOrEqual(90);
    }
  });

  it('survives a long background stall without a catch-up burst', () => {
    const { loop, scheduler, ticks } = makeLoop();
    loop.start();
    scheduler.runFrame(60_000_000); // one minute hidden
    expect(ticks()).toBe(MAX_STEPS_PER_FRAME);
    expect(loop.getStats().shedCount).toBe(1);
  });

  it('credits nothing for the gap when resynced after the tab was hidden', () => {
    const { loop, scheduler, ticks } = makeLoop();
    loop.start();
    scheduler.runFrame(16_000);
    const before = ticks();

    scheduler.advance(60_000_000); // hidden: time passes, no frames fire
    loop.resync();
    scheduler.runFrame(16_000); // first frame back, shorter than one tick

    expect(ticks()).toBe(before);
  });

  it('would otherwise lurch on return, which is what resync prevents', () => {
    // The same sequence without the resync, to prove the previous test is
    // testing something. The clamp still bounds the damage to five ticks.
    const { loop, scheduler, ticks } = makeLoop();
    loop.start();
    scheduler.runFrame(16_000);

    scheduler.advance(60_000_000);
    scheduler.runFrame(16_000);

    expect(ticks()).toBe(MAX_STEPS_PER_FRAME);
  });

  it('keeps scheduling frames while running and stops when stopped', () => {
    const { loop, scheduler } = makeLoop();
    loop.start();
    expect(scheduler.hasPendingFrame()).toBe(true);

    scheduler.runFrame(16_000);
    expect(scheduler.hasPendingFrame()).toBe(true);

    loop.stop();
    expect(loop.isRunning()).toBe(false);
    expect(scheduler.hasPendingFrame()).toBe(false);
  });

  it('is idempotent on repeated start', () => {
    const { loop, scheduler, ticks } = makeLoop();
    loop.start();
    loop.start();
    scheduler.runFrame(100_000);
    expect(ticks()).toBe(3);
  });

  it('reports the steps and alpha of the most recent frame', () => {
    const { loop, scheduler } = makeLoop();
    loop.start();
    scheduler.runFrame(50_000); // 1.5 ticks

    const stats = loop.getStats();
    expect(stats.steps).toBe(1);
    expect(stats.alpha).toBeCloseTo(0.5, 6);
    expect(stats.frameCount).toBe(1);
  });
});
