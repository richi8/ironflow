/**
 * How much a machine has made, and how fast. See ironflow.md C12 task 2.
 *
 * ```text
 * mining-system (phase 3) -> ProductionCounters -> controller.pump() -> ProductionRate
 *   "this miner made one"      lifetime total       one sample a tick     items/minute
 * ```
 *
 * Two halves of one measurement, kept in one file because neither is worth
 * reading without the other.
 *
 * ## Why neither half is authoritative state
 *
 * §10 lists "production rate per minute" as derived and never persisted, and
 * C12 task 2 repeats it. The *counter* is the interesting case: it cannot be
 * recomputed from the world either, because it is history rather than a
 * function of the present. So it is the same third thing `AlertLog` is —
 * a measurement the simulation writes and never reads back. Nothing in
 * `game/` branches on it, no system consults it, and a save that omitted it
 * loads into an identical world with a rate readout that fills in over the
 * next ten seconds.
 *
 * Keeping it out of the entity is what makes that true by construction: a
 * `producedTotal` field on `MinerEntity` would be written into every save by
 * C24 and would then have to be migrated, validated and kept honest forever —
 * a permanent cost for a number the player looks at for a few seconds.
 *
 * ## Why a monotone counter rather than a stream of events
 *
 * The rate is an average over a window, so the only thing it needs from the
 * past is *the total as it stood then*. With a counter that only rises, two
 * samples taken any distance apart give the exact number of items produced
 * between them — which means the sampler can run at frame rate and still be
 * exactly right about a machine that produced something between two frames.
 * A per-item event would have to be recorded inside a tick, allocated, and
 * drained before the next frame or lost.
 */

import type { EntityId } from './entities/entity.js';
import { NO_ENTITY } from './entities/entity.js';
import { TPS } from './simulation-clock.js';

/**
 * The **shortest** the rolling average may be, in ticks. C12 task 2's ten
 * seconds, and still the whole window for any machine fast enough.
 *
 * Long enough that a miner's 60-tick item does not make the number jump
 * between 0 and 60/min, short enough that stopping shows up while the player
 * is still looking at the panel.
 */
export const RATE_WINDOW_TICKS = 300;

/**
 * How many items the window tries to cover before it stops growing. C20.
 *
 * C15 and C16 both filed the same complaint and both deferred it here: at ten
 * seconds a plate furnace producing 0.3125 items/s has **three items** in the
 * window, so the panel reads 12/min, then 24, then 18, while the furnace does
 * exactly the same thing throughout. The number is honest and useless — a
 * player watching it cannot tell a healthy furnace from a struggling one,
 * which is pillar 3 failing on the one screen that exists to serve it.
 *
 * The fix is to let a *slow* machine have a longer window rather than to make
 * every window longer, and **five is exactly where C12 drew the line without
 * saying so**: its ten seconds were chosen so "a miner's 60-tick item does not
 * make the number jump", and a miner puts five items in them. So a miner, an
 * inserter, a belt and C16's assembler all keep C12's window and C12's
 * responsiveness untouched, and the machines that widen are the ones the
 * complaint was about — a plate furnace with three, a steel furnace with one.
 *
 * This is a **threshold, not a target**: a machine that cannot hold five items
 * in ten seconds is read over the whole thirty instead. See
 * `ProductionRate.windowStart` on why it is two fixed spans rather than one
 * span sized to the items, which reads systematically high.
 */
export const RATE_WINDOW_ITEMS = 5;

/**
 * The **longest** the window may grow, in ticks. Thirty seconds.
 *
 * The price of a longer window is that a machine which stops keeps reporting a
 * decaying rate for as long as the window is. Thirty seconds is the most that
 * is tolerable, and it is why a slow machine's window is bounded by time as
 * well as by items: a steel furnace at one item per sixteen seconds will never
 * reach eight of them in the window, and reads two items' worth rather than
 * freezing the panel for two minutes to get eight.
 *
 * The machine's **status** is what answers "has it stopped" immediately; the
 * rate answers "how fast is it going", and those are different questions asked
 * of the same panel (§13, pillar 3).
 */
export const MAX_RATE_WINDOW_TICKS = 900;

/** Ticks to a minute. The whole of the items/tick -> items/minute conversion. */
const TICKS_PER_MINUTE = TPS * 60;

/**
 * Lifetime output per machine. Written by systems inside a tick, read by the
 * controller after one. See the file header on why it is not persisted.
 *
 * A `Map`, which §6 R4 permits here for the reason `ItemCounts` documents:
 * nothing iterates it. Every question is about one entity id, and `forget`
 * is handed the ids the store has already decided on.
 */
export class ProductionCounters {
  private readonly totals = new Map<EntityId, number>();

  /** Add to a machine's lifetime output. Called once per item produced. */
  record(entityId: EntityId, amount: number): void {
    if (amount <= 0) return;
    this.totals.set(entityId, (this.totals.get(entityId) ?? 0) + amount);
  }

  /** Everything this machine has ever made. Zero for one that never has. */
  totalFor(entityId: EntityId): number {
    return this.totals.get(entityId) ?? 0;
  }

  /**
   * Drop the counters of entities that no longer exist.
   *
   * Called from the cleanup phase with the ids the store just removed (§8
   * phase 9). Without it the map is the one structure in the game that grows
   * with every building ever demolished — ids are never reused (§6 R5), so a
   * stale entry can never be read again, only paid for.
   */
  forget(entityIds: readonly EntityId[]): void {
    for (const entityId of entityIds) this.totals.delete(entityId);
  }

  /** How many machines are counted. For tests and for the debug readout. */
  get size(): number {
    return this.totals.size;
  }
}

/**
 * The rolling average, in items per minute, of one machine at a time.
 *
 * One machine because the inspector shows one: C12 task 2 puts this in the
 * controller's derived state, and tracking every machine in the factory would
 * be 20,000 windows (§12) kept up to date so that one of them could be read.
 * Switching machines starts the window again, which is why `perMinuteFor`
 * takes the id it is asked about and answers 0 for any other — a number
 * measured for a different miner is worse than no number at all.
 *
 * ## The window is a range, not a number
 *
 * Samples arrive at frame rate and are kept one per tick, so a window that has
 * only just opened is short. The average is then over what there is, which is
 * the honest reading: the alternative is to report 0 for the first ten seconds
 * after every click, and a panel that says a running miner produces nothing is
 * the bug pillar 3 exists to prevent.
 *
 * At the other end it **grows**, from `RATE_WINDOW_TICKS` up to
 * `MAX_RATE_WINDOW_TICKS`, until it holds `RATE_WINDOW_ITEMS` items. See those
 * three constants: the window is in items for a slow machine and in time for a
 * fast one, because what makes a rate readable is how many things it averaged
 * and what makes it responsive is how long ago they happened.
 */
export class ProductionRate {
  private subject: EntityId = NO_ENTITY;

  /** Sample ticks, ascending, and the totals at them. Parallel arrays. */
  private readonly ticks: number[] = [];

  private readonly totals: number[] = [];

  /**
   * Record where a machine's output stands now.
   *
   * At most one sample per tick: at 60 fps `pump()` runs twice per tick, and a
   * second sample at the same tick carries no information — it would only make
   * the window half as long in ticks for twice the memory.
   */
  sample(entityId: EntityId, tick: number, total: number): void {
    if (entityId !== this.subject) {
      this.subject = entityId;
      this.ticks.length = 0;
      this.totals.length = 0;
    }

    const last = this.ticks.length - 1;
    if (last >= 0 && this.ticks[last] === tick) {
      this.totals[last] = total;
      return;
    }

    this.ticks.push(tick);
    this.totals.push(total);

    // History is kept to the *widest* window; which part of it gets averaged
    // is decided per reading, in `windowStart`. Never fewer than two samples:
    // a window with one sample in it has no span to divide by.
    while (this.ticks.length > 2 && tick - (this.ticks[0] ?? tick) > MAX_RATE_WINDOW_TICKS) {
      this.ticks.shift();
      this.totals.shift();
    }
  }

  /**
   * The index the reading starts from: the narrow window, or the whole
   * history when the narrow one has too few items in it.
   *
   * **Two regimes and not a sliding scale**, which is the part worth
   * explaining. A rate is `items / span`, and it is only unbiased when the
   * span is chosen without looking at where the items fell: a window trimmed
   * to "the shortest span holding eight items" always ends just after an item
   * and just before a gap, so it reports about 14% high for a steady machine.
   * That was the first attempt and the arithmetic caught it.
   *
   * So the span is `RATE_WINDOW_TICKS`, or — when that holds too few items to
   * read — everything retained, which is `MAX_RATE_WINDOW_TICKS`. Both are
   * fixed tick counts chosen before the items are counted, and both are
   * therefore honest.
   */
  private windowStart(): number {
    const last = this.ticks.length - 1;
    const newestTick = this.ticks[last] ?? 0;

    let narrow = last;
    while (narrow > 0 && newestTick - (this.ticks[narrow - 1] ?? 0) <= RATE_WINDOW_TICKS) {
      narrow -= 1;
    }

    const items = (this.totals[last] ?? 0) - (this.totals[narrow] ?? 0);
    return items >= RATE_WINDOW_ITEMS ? narrow : 0;
  }

  /**
   * How many ticks the reading actually covers. For the tests and the panel.
   *
   * `RATE_WINDOW_TICKS` for a machine fast enough, and up to
   * `MAX_RATE_WINDOW_TICKS` for one that is not. Zero before there is a span.
   */
  get windowTicks(): number {
    if (this.ticks.length < 2) return 0;
    return (this.ticks[this.ticks.length - 1] ?? 0) - (this.ticks[this.windowStart()] ?? 0);
  }

  /** Forget everything. The window a machine that is no longer selected had. */
  reset(): void {
    this.subject = NO_ENTITY;
    this.ticks.length = 0;
    this.totals.length = 0;
  }

  /** How many samples the window holds. For the tests. */
  get sampleCount(): number {
    return this.ticks.length;
  }

  /**
   * How many items the reading averaged. For the tests, and the number
   * `RATE_WINDOW_ITEMS` is about: it is what decides whether the reading is
   * steady enough to be worth putting on screen.
   */
  get itemsInWindow(): number {
    if (this.ticks.length < 2) return 0;
    return (this.totals[this.totals.length - 1] ?? 0) - (this.totals[this.windowStart()] ?? 0);
  }

  /**
   * Items per minute for `entityId`, or 0 for a machine this is not measuring
   * and for a window too short to divide by.
   */
  perMinuteFor(entityId: EntityId): number {
    if (entityId !== this.subject || this.ticks.length < 2) return 0;

    const last = this.ticks.length - 1;
    const first = this.windowStart();
    const spanTicks = (this.ticks[last] ?? 0) - (this.ticks[first] ?? 0);
    if (spanTicks <= 0) return 0;

    const produced = (this.totals[last] ?? 0) - (this.totals[first] ?? 0);
    return (produced * TICKS_PER_MINUTE) / spanTicks;
  }
}
