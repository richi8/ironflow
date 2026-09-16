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
 * How many ticks the rolling average covers. C12 task 2: 300 ticks, ten
 * seconds. Long enough that a miner's 60-tick item does not make the number
 * jump between 0 and 60/min, short enough that stopping shows up while the
 * player is still looking at the panel.
 */
export const RATE_WINDOW_TICKS = 300;

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
 * ## The window is "at most 300 ticks", not "exactly 300"
 *
 * Samples arrive at frame rate and are kept one per tick, so a window that has
 * only just opened is short. The average is then over what there is, which is
 * the honest reading: the alternative is to report 0 for the first ten seconds
 * after every click, and a panel that says a running miner produces nothing is
 * the bug pillar 3 exists to prevent.
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

    // Drop samples that have fallen out of the window, but never the last two:
    // a window with one sample in it has no span to divide by.
    while (this.ticks.length > 2 && tick - (this.ticks[0] ?? tick) > RATE_WINDOW_TICKS) {
      this.ticks.shift();
      this.totals.shift();
    }
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
   * Items per minute for `entityId`, or 0 for a machine this is not measuring
   * and for a window too short to divide by.
   */
  perMinuteFor(entityId: EntityId): number {
    if (entityId !== this.subject || this.ticks.length < 2) return 0;

    const last = this.ticks.length - 1;
    const spanTicks = (this.ticks[last] ?? 0) - (this.ticks[0] ?? 0);
    if (spanTicks <= 0) return 0;

    const produced = (this.totals[last] ?? 0) - (this.totals[0] ?? 0);
    return (produced * TICKS_PER_MINUTE) / spanTicks;
  }
}
