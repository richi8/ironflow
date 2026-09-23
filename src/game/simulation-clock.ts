/**
 * Fixed-timestep pacing. See ironflow.md §8.
 *
 * The simulation runs at exactly TPS ticks per simulated second, independent of
 * frame rate. This file owns the only place where real elapsed time is turned
 * into a number of ticks to run.
 *
 * ## Why the accumulator is an integer
 *
 * §8 sketches a float accumulator in milliseconds. That works, but 1000/30 is
 * not representable in binary floating point, so the error compounds: over ten
 * seconds of 16 ms frames a float accumulator loses a whole tick, and it loses
 * a *different* number of ticks depending on how the frames were spaced.
 *
 * Instead the accumulator counts in units of `microseconds x TPS`, where one
 * tick costs exactly `UNITS_PER_TICK`. Every quantity involved is an integer,
 * so the arithmetic is exact and two differently-paced runs covering the same
 * elapsed time produce byte-identical tick counts. That is not required by the
 * determinism contract (§6 concerns the simulation, not its pacing) but it
 * makes the C00 acceptance tests exact rather than approximate, and it costs
 * nothing.
 *
 * The accumulator is *presentation-side pacing*, not authoritative state. It is
 * never serialized.
 */

/** Simulation ticks per simulated second. */
export const TPS = 30;

/** Nominal tick duration in milliseconds. Informational; not used for pacing. */
export const TICK_MS = 1000 / TPS;

/**
 * Never process more than this much real time in a single frame.
 *
 * `requestAnimationFrame` stops in a background tab. Without this clamp,
 * returning after five minutes would ask for 9,000 ticks in one frame, freeze
 * the tab and then get it killed by the browser's watchdog. IronFlow's answer
 * is deliberate and stated in §8: the game does not run in a background tab.
 */
export const MAX_FRAME_US = 250_000;

/** Spiral-of-death guard: the most ticks one frame may run. */
export const MAX_STEPS_PER_FRAME = 5;

/** Accumulator units consumed by one tick. See the note above. */
const UNITS_PER_TICK = 1_000_000;

/** How much a frame of `dt` microseconds adds to the accumulator. */
const UNITS_PER_US = TPS;

/** What a single frame is allowed to do, decided before anything runs. */
export interface FrameBudget {
  /** Number of simulation ticks to run this frame. 0..MAX_STEPS_PER_FRAME. */
  readonly steps: number;
  /** Fraction of the way to the next tick, 0..1. For render interpolation only. */
  readonly alpha: number;
  /** True when simulation debt was discarded because the frame hit its step cap. */
  readonly shed: boolean;
}

export class SimulationClock {
  /** Integer, in units of microseconds x TPS. Always < UNITS_PER_TICK after advance(). */
  private accumulator = 0;
  private lastUs: number | null = null;
  private shedCount = 0;
  private tickBudgetTotal = 0;
  /** Simulated time per real time. An integer, so the accumulator stays exact. */
  private speed = 1;

  /**
   * Run `speed` simulated seconds per real one (C30 task 5).
   *
   * A whole number, which is what keeps the note at the top of this file
   * true: a frame's microseconds times an integer is still an integer. The
   * step cap scales with it, or 8x would be 5 ticks a frame and not 8x; the
   * 250 ms clamp does not, because it is about real time away from the tab.
   */
  setSpeed(speed: number): void {
    if (!Number.isInteger(speed) || speed < 1) {
      throw new RangeError(`SimulationClock.setSpeed: ${speed} is not a whole number of at least 1.`);
    }
    this.speed = speed;
  }

  getSpeed(): number {
    return this.speed;
  }

  /**
   * Begin (or resume) timing at `nowUs` without crediting the gap since the
   * last frame. Call on start and whenever the page becomes visible again.
   */
  reset(nowUs: number): void {
    this.lastUs = nowUs;
    this.accumulator = 0;
  }

  /**
   * Advance to `nowUs` and decide how many ticks this frame owes.
   *
   * @param nowUs monotonic time in whole microseconds.
   */
  advance(nowUs: number): FrameBudget {
    if (this.lastUs === null) {
      // First frame after construction: establish a baseline, run nothing.
      this.lastUs = nowUs;
      return { steps: 0, alpha: 0, shed: false };
    }

    let dtUs = nowUs - this.lastUs;
    this.lastUs = nowUs;

    // A non-monotonic or stalled clock must never move the simulation backwards.
    if (dtUs < 0) dtUs = 0;
    if (dtUs > MAX_FRAME_US) dtUs = MAX_FRAME_US;

    this.accumulator += dtUs * UNITS_PER_US * this.speed;

    const cap = MAX_STEPS_PER_FRAME * this.speed;
    let steps = 0;
    while (this.accumulator >= UNITS_PER_TICK && steps < cap) {
      this.accumulator -= UNITS_PER_TICK;
      steps += 1;
    }

    // Shed debt only when there is genuinely debt left over. §8 writes this as an
    // unconditional reset when the cap is hit, but that also discards a legitimate
    // sub-tick remainder on a frame that happened to consume exactly its budget,
    // which makes render interpolation stutter at low frame rates.
    let shed = false;
    if (steps === cap && this.accumulator >= UNITS_PER_TICK) {
      this.accumulator = 0;
      this.shedCount += 1;
      shed = true;
    }

    this.tickBudgetTotal += steps;
    return { steps, alpha: this.accumulator / UNITS_PER_TICK, shed };
  }

  /** Frames whose simulation debt was discarded. A rising count means we are too slow. */
  getShedCount(): number {
    return this.shedCount;
  }

  /** Total ticks this clock has authorised since construction. */
  getTotalSteps(): number {
    return this.tickBudgetTotal;
  }
}
