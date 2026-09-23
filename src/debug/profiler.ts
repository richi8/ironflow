import { PHASE_COUNT, Phase, type PhaseTimer } from '../game/phase-timer.js';

/**
 * Per-phase tick timings over a rolling window. See ironflow.md C28 task 1.
 *
 * The simulation reports *when* each phase ends (`game/phase-timer.ts`); this
 * reads a clock at each report and keeps the differences. It lives outside
 * `game/` for the one reason §6 R1 gives — a clock — and it takes the clock as
 * a function so that the browser can hand it `performance.now`, the
 * benchmarks Node's, and a test a counter.
 *
 * ## What it costs
 *
 * Eleven clock reads and eleven stores into preallocated `Float64Array`s per
 * tick, and nothing else: no allocation, no branch on content, no string. C28
 * sets the ceiling at 0.1 ms a tick and `tests/perf/profiler.perf.test.ts`
 * holds it to that with a real clock; the answer on a laptop is around a
 * microsecond, which is mostly the clock. Everything that *summarises* —
 * sorting for a percentile, averaging — happens in `snapshot()`, which the
 * overlay calls ten times a second rather than thirty.
 *
 * ## Why a window and not a running average
 *
 * `LoopStats` smooths exponentially, which is right for a number a person
 * watches and wrong for §12's budget table: a p99 is a statement about the
 * worst tick in a hundred, and exponential smoothing is designed to forget
 * exactly that tick. A window holds the samples themselves, so the p99 is the
 * p99 of the last `capacity` ticks and nothing is invented.
 */

/** Ticks in the default window: ten seconds at 30 TPS. */
export const DEFAULT_WINDOW = 300;

/**
 * A fixed number of recent samples, oldest overwritten first.
 *
 * Also used by `main.ts` for frame times, which is why it is exported and why
 * it knows nothing about phases.
 */
export class RollingWindow {
  private readonly samples: Float64Array;
  private next = 0;
  private filled = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RollingWindow: capacity must be a whole number of at least 1, not ${capacity}.`);
    }
    this.samples = new Float64Array(capacity);
  }

  push(value: number): void {
    this.samples[this.next] = value;
    this.next = this.next + 1 === this.capacity ? 0 : this.next + 1;
    if (this.filled < this.capacity) this.filled += 1;
  }

  /** How many samples are held; at most `capacity`. */
  get size(): number {
    return this.filled;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  /** The mean of the held samples, or 0 with none. */
  mean(): number {
    if (this.filled === 0) return 0;
    let sum = 0;
    for (let i = 0; i < this.filled; i++) sum += this.samples[i] ?? 0;
    return sum / this.filled;
  }

  /**
   * The largest held sample, or 0 with none.
   *
   * @param ceiling ignore samples above this. The overlay passes one so that a
   * frame measuring how long a background tab was away is not reported as the
   * longest frame of the session.
   */
  max(ceiling = Number.POSITIVE_INFINITY): number {
    let max = 0;
    for (let i = 0; i < this.filled; i++) {
      const sample = this.samples[i] ?? 0;
      if (sample <= ceiling && sample > max) max = sample;
    }
    return max;
  }

  /**
   * The `q`-quantile of the held samples, `q` in `[0, 1]`, or 0 with none.
   *
   * Nearest-rank, not interpolated: the answer is always a tick that actually
   * happened, which is what a budget is about. With the default window of 300
   * the p99 is the third-slowest tick of the last ten seconds.
   */
  quantile(q: number): number {
    if (this.filled === 0) return 0;
    const sorted = this.samples.slice(0, this.filled).sort();
    const rank = Math.min(this.filled - 1, Math.max(0, Math.ceil(q * this.filled) - 1));
    return sorted[rank] ?? 0;
  }
}

/** One phase's numbers over the window, in milliseconds. */
export interface PhaseStats {
  readonly mean: number;
  readonly p99: number;
}

/** What `Profiler.snapshot()` reports. Milliseconds throughout. */
export interface ProfileSnapshot {
  /** Ticks the numbers below are drawn from. */
  readonly ticks: number;
  /** A whole tick, first phase to last. */
  readonly tick: PhaseStats & { readonly max: number };
  /** Indexed by `Phase`. */
  readonly phases: readonly PhaseStats[];
}

export class Profiler implements PhaseTimer {
  private readonly now: () => number;
  private readonly phaseWindows: RollingWindow[];
  private readonly tickWindow: RollingWindow;

  private tickStart = 0;
  private last = 0;
  /** Is a tick open? Set by `beginTick`, so a phase report without one is ignored. */
  private open = false;

  /**
   * @param now a monotonic clock in **milliseconds** — `performance.now`, or
   * anything with its shape.
   * @param window ticks to keep; see `DEFAULT_WINDOW`.
   */
  constructor(now: () => number, window: number = DEFAULT_WINDOW) {
    this.now = now;
    this.tickWindow = new RollingWindow(window);
    this.phaseWindows = [];
    for (let phase = 0; phase < PHASE_COUNT; phase++) this.phaseWindows.push(new RollingWindow(window));
  }

  beginTick(): void {
    const now = this.now();
    this.tickStart = now;
    this.last = now;
    this.open = true;
  }

  endPhase(phase: Phase): void {
    if (!this.open) return;
    const now = this.now();
    this.phaseWindows[phase]?.push(now - this.last);
    this.last = now;
    if (phase === Phase.Cleanup) {
      this.tickWindow.push(now - this.tickStart);
      this.open = false;
    }
  }

  /** Forget every sample — for a loaded world, whose numbers are not these. */
  reset(): void {
    this.tickWindow.clear();
    for (const window of this.phaseWindows) window.clear();
    this.open = false;
  }

  snapshot(): ProfileSnapshot {
    return {
      ticks: this.tickWindow.size,
      tick: { mean: this.tickWindow.mean(), p99: this.tickWindow.quantile(0.99), max: this.tickWindow.max() },
      phases: this.phaseWindows.map((window) => ({ mean: window.mean(), p99: window.quantile(0.99) })),
    };
  }
}
