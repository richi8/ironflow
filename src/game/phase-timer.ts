/**
 * Per-phase timing, as the simulation sees it. See ironflow.md C28.
 *
 * The simulation cannot time itself: §6 R1 bans every clock from `game/`, and
 * for once the rule is not about determinism at all — a phase timer changes
 * nothing the simulation computes — but about keeping the ban simple enough
 * to lint. So the simulation says *when* a phase ends and something outside
 * `game/` decides what time it is. The browser's implementation is
 * `debug/profiler.ts`, and the benchmarks hand it Node's clock.
 *
 * ## Why this costs nothing when nobody is listening
 *
 * `Simulation` holds a `PhaseTimer | null`, and with `null` the tick reads no
 * clock, calls nothing and allocates nothing: what remains is one comparison
 * against `null` per phase, which is below what any benchmark in this
 * repository can resolve. C28 asked for a "compile-time-ish flag", and the
 * flag is where the timer is *attached* — `main.ts` attaches one only while
 * the F3 overlay is open, and the overlay starts closed in a release build.
 */

/**
 * The ten phases of §8, numbered in the order they run.
 *
 * A numeric enum rather than a string union because the profiler indexes
 * typed arrays by it once per phase per tick, and a string key there would be
 * a hash lookup in the one loop C28 promised would cost nothing.
 */
export enum Phase {
  Commands = 0,
  Power = 1,
  Mining = 2,
  Production = 3,
  Belts = 4,
  Inserters = 5,
  Research = 6,
  Player = 7,
  Exploration = 8,
  Cleanup = 9,
}

/** How many phases a tick has. Kept in step with the table, not hand-written. */
export const PHASE_COUNT = 10;

/** Indexed by `Phase`. For readouts and benchmark tables; never for lookup. */
export const PHASE_NAMES: readonly string[] = Object.freeze([
  'commands',
  'power',
  'mining',
  'production',
  'belts',
  'inserters',
  'research',
  'player',
  'exploration',
  'cleanup',
]);

/**
 * Something that wants to know how long each phase took.
 *
 * The calls arrive in a fixed shape, once per tick:
 *
 * ```text
 * beginTick()  endPhase(Commands)  endPhase(Power)  ...  endPhase(Cleanup)
 * ```
 *
 * so an implementation that reads its clock in each call has the duration of
 * every phase as the difference between two consecutive reads, and the tick's
 * as the difference between the first and the last. `endPhase(Cleanup)` is
 * the end of the tick; there is no separate call for it, because it would be
 * a twelfth clock read measuring nothing.
 *
 * A tick that throws never reaches `endPhase(Cleanup)`. The next
 * `beginTick()` starts again from a clean read, so the half-tick is dropped
 * rather than folded into the next one.
 */
export interface PhaseTimer {
  beginTick(): void;
  endPhase(phase: Phase): void;
}
