import { describe, expect, it } from 'vitest';

import {
  MAX_RATE_WINDOW_TICKS,
  ProductionCounters,
  ProductionRate,
  RATE_WINDOW_ITEMS,
  RATE_WINDOW_TICKS,
} from '../../src/game/production.js';
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
 *
 * **C20 made the window a range** rather than a number: 300 ticks at least,
 * `MAX_RATE_WINDOW_TICKS` at most, and as long in between as it takes to hold
 * `RATE_WINDOW_ITEMS` items. Slow machines were the complaint C15 and C16 both
 * filed and both deferred here — a plate furnace had three items in its window
 * and a readout that swung by a third while it did nothing unusual. The tests
 * below are stated against the range.
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
  it('reads a steady miner at its content rate', () => {
    const rate = new ProductionRate();
    // Four windows' worth, so the reading is over real history and not over
    // whatever the warm-up left behind.
    const perMinute = runProduction(rate, 1, RATE_WINDOW_TICKS * 4, MINER_TICKS_PER_ITEM);
    expect(perMinute).toBeCloseTo(MINER_PER_MINUTE, 10);
  });

  it('grows the window for a slow machine, until it holds enough items', () => {
    // §15's plate furnace: 0.3125 items/s, which is one item every 96 ticks
    // and **three** in C12's ten-second window. That is the reading C15 and
    // C16 called useless, and the fix is that the window keeps the samples it
    // needs rather than the seconds it was told.
    const rate = new ProductionRate();
    runProduction(rate, 1, MAX_RATE_WINDOW_TICKS * 2, 96);

    expect(rate.windowTicks).toBe(MAX_RATE_WINDOW_TICKS);
    // The whole point: enough items in the reading to divide by, where C12's
    // window had three.
    expect(rate.itemsInWindow).toBeGreaterThanOrEqual(RATE_WINDOW_ITEMS);
    // Within 5% of 18.75/min. Not exact, because the window's edge falls where
    // a sample is and the items inside it are whole.
    const expected = (30 * 60) / 96;
    expect(rate.perMinuteFor(1)).toBeGreaterThan(expected * 0.95);
    expect(rate.perMinuteFor(1)).toBeLessThan(expected * 1.05);
  });

  it('keeps a fast machine on the ten-second window C12 gave it', () => {
    // Two items a second: eight of them fit in well under 300 ticks, so the
    // reading stays on the narrow window and the responsiveness C12 tuned for
    // is untouched.
    const rate = new ProductionRate();
    runProduction(rate, 1, MAX_RATE_WINDOW_TICKS * 2, 15);
    expect(rate.windowTicks).toBe(RATE_WINDOW_TICKS);
    expect(rate.perMinuteFor(1)).toBeCloseTo((30 * 60) / 15, 10);
  });

  it('is a rolling window: a machine that stops falls to zero', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, RATE_WINDOW_TICKS, MINER_TICKS_PER_ITEM);
    expect(rate.perMinuteFor(1)).toBeGreaterThan(0);

    // A full ceiling of nothing. The producing samples are now all outside the
    // window, so the reading is the truth rather than a fading memory. It
    // takes longer than C12's ten seconds, and that is the price of the
    // paragraph above — the machine's *status* is what says "stopped" at once.
    let tick = RATE_WINDOW_TICKS;
    for (let i = 0; i <= MAX_RATE_WINDOW_TICKS; i++) rate.sample(1, ++tick, 5);
    expect(rate.perMinuteFor(1)).toBe(0);
  });

  it('never keeps more than the widest window of samples', () => {
    const rate = new ProductionRate();
    runProduction(rate, 1, MAX_RATE_WINDOW_TICKS * 4, MINER_TICKS_PER_ITEM);
    expect(rate.sampleCount).toBeLessThanOrEqual(MAX_RATE_WINDOW_TICKS + 1);
    // A miner puts exactly `RATE_WINDOW_ITEMS` items in the narrow window,
    // which is the line C12 drew when it chose ten seconds. The rest of the
    // history is kept so that a machine which *slows down* has something to be
    // read over rather than having to build a new window first.
    expect(rate.windowTicks).toBe(RATE_WINDOW_TICKS);
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
