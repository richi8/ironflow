import { describe, expect, it } from 'vitest';

import { ProductionCounters, ProductionRate, RATE_WINDOW_TICKS } from '../../src/game/production.js';
import { TPS } from '../../src/game/simulation-clock.js';

/**
 * The measured rate. See ironflow.md C12 task 2.
 *
 * > Rate is measured as a **derived** rolling average over the last 300 ticks
 * > (10 s), stored in the controller's derived state, never persisted.
 *
 * This file carries "rate-average correctness over a known production
 * sequence" from the chunk's test list. The sequence is driven by hand rather
 * than by a simulation, because what is under test is the arithmetic of a
 * sliding window — a real miner would only ever exercise one rate, and the
 * cases that matter are the ones a miner cannot easily be made to produce: a
 * window shorter than 300 ticks, a machine that stops, and a switch between
 * two machines.
 */

/** §15's tier-1 miner: 0.5 items/s, which is 30 a minute and 60 ticks each. */
const MINER_TICKS_PER_ITEM = 60;
const MINER_PER_MINUTE = 30;

/**
 * Sample `rate` once a tick for `ticks` ticks, producing one item every
 * `ticksPerItem`, and return the window's reading at the end.
 */
function runProduction(rate: ProductionRate, entityId: number, ticks: number, ticksPerItem: number): number {
  let total = 0;
  for (let tick = 1; tick <= ticks; tick++) {
    if (tick % ticksPerItem === 0) total += 1;
    rate.sample(entityId, tick, total);
  }
  return rate.perMinuteFor(entityId);
}

describe('ProductionCounters', () => {
  it('only ever rises, so two samples give the items produced between them', () => {
    const counters = new ProductionCounters();
    expect(counters.totalFor(1)).toBe(0);

    counters.record(1, 1);
    counters.record(1, 2);
    expect(counters.totalFor(1)).toBe(3);

    // Nothing here knows or cares that a buffer was emptied: the counter is
    // about what a machine made, not about what it is holding.
    counters.record(1, 0);
    expect(counters.totalFor(1)).toBe(3);
  });

  it('keeps machines apart and forgets the ones that are gone', () => {
    const counters = new ProductionCounters();
    counters.record(1, 5);
    counters.record(2, 7);
    expect(counters.size).toBe(2);

    counters.forget([1]);
    expect(counters.totalFor(1)).toBe(0);
    expect(counters.totalFor(2)).toBe(7);
    expect(counters.size).toBe(1);
  });
});

describe('ProductionRate', () => {
  it('reads a steady miner at exactly its content rate', () => {
    const rate = new ProductionRate();
    // Two full windows, so the reading is over 300 ticks of real history and
    // not over whatever the warm-up left behind.
    const perMinute = runProduction(rate, 1, RATE_WINDOW_TICKS * 2, MINER_TICKS_PER_ITEM);
    expect(perMinute).toBeCloseTo(MINER_PER_MINUTE, 10);
  });

  it('is a rolling window: a machine that stops falls to zero within 300 ticks', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS, MINER_TICKS_PER_ITEM);
    expect(rate.perMinuteFor(1)).toBeGreaterThan(0);

    // Ten more seconds of nothing. The producing samples are now all outside
    // the window, so the reading is the truth rather than a fading memory.
    let tick = RATE_WINDOW_TICKS;
    for (let i = 0; i < RATE_WINDOW_TICKS; i++) rate.sample(1, ++tick, 5);
    expect(rate.perMinuteFor(1)).toBe(0);
  });

  it('never keeps more than a window of samples', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS * 4, MINER_TICKS_PER_ITEM);
    expect(rate.sampleCount).toBeLessThanOrEqual(RATE_WINDOW_TICKS + 1);
  });

  it('reads over the history it has when the window has only just opened', () => {
    const rate = new ProductionRate();
    // Half a window, at twice the miner's rate. Reporting 0 until 300 ticks
    // had passed would be a panel telling the player a running machine
    // produces nothing, which is the bug pillar 3 exists to prevent.
    const perMinute = runProduction(rate, 1, RATE_WINDOW_TICKS / 2, MINER_TICKS_PER_ITEM / 2);
    // Close rather than exact: the window spans the 149 ticks between its
    // first and last sample, and five items over 149 ticks is 60.4 a minute
    // rather than 60. The error is one sample's worth and shrinks as the
    // window fills, which is the price of reading early instead of not at all.
    expect(perMinute).toBeGreaterThan(MINER_PER_MINUTE * 2 - 1);
    expect(perMinute).toBeLessThan(MINER_PER_MINUTE * 2 + 1);
  });

  it('has nothing to say about a machine it is not measuring', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS, MINER_TICKS_PER_ITEM);

    // A number measured for one miner under another miner's name is worse
    // than no number at all.
    expect(rate.perMinuteFor(2)).toBe(0);
  });

  it('starts again when the subject changes, rather than carrying a rate over', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS, MINER_TICKS_PER_ITEM);

    rate.sample(2, RATE_WINDOW_TICKS + 1, 900);
    expect(rate.sampleCount).toBe(1);
    // One sample has no span to divide by, so there is no rate yet.
    expect(rate.perMinuteFor(2)).toBe(0);
  });

  it('ignores a second sample in the same tick', () => {
    const rate = new ProductionRate();
    // 60 fps against 30 TPS is two `pump()`s per tick; the second carries no
    // information and must not halve the window's length in ticks.
    rate.sample(1, 1, 0);
    rate.sample(1, 1, 0);
    rate.sample(1, 2, 1);
    rate.sample(1, 2, 1);

    expect(rate.sampleCount).toBe(2);
    // One item in one tick is TPS items a second, which is 60 x TPS a minute.
    expect(rate.perMinuteFor(1)).toBeCloseTo(TPS * 60, 10);
  });

  it('forgets everything on reset', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS, MINER_TICKS_PER_ITEM);
    rate.reset();

    expect(rate.sampleCount).toBe(0);
    expect(rate.perMinuteFor(1)).toBe(0);
  });
});
