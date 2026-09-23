import { readFileSync } from 'node:fs';

import { Profiler } from '../../src/debug/profiler.js';
import { PHASE_COUNT, PHASE_NAMES, type Phase, type PhaseTimer } from '../../src/game/phase-timer.js';
import { deserialize } from '../../src/game/save/save-serializer.js';
import type { Simulation } from '../../src/game/simulation.js';
import { decodeSaveFile } from '../../src/persistence/export-import.js';

/**
 * §12's reference factory, loaded and measured. The harness C28 tasks 4 and 5
 * stand on.
 *
 * The fixture is `tests/fixtures/reference-factory.ifsave`, built by
 * `npm run bench:fixture` (`tools/make-reference-factory.ts`), and it is
 * loaded through the door a player's export comes through — header, migrate,
 * validate, deserialize — so a benchmark cannot pass on a file the game would
 * refuse.
 *
 * The clock is Node's `performance.now` handed to the same `Profiler` the F3
 * overlay uses, so the numbers the benchmarks commit and the numbers a person
 * reads in the browser are produced by one piece of code.
 */

export const REFERENCE_FIXTURE = new URL('../fixtures/reference-factory.ifsave', import.meta.url);

/** The fixture's bytes. Read once per process; decoding is the part worth timing. */
let bytes: Uint8Array | null = null;
export function referenceFixtureBytes(): Uint8Array {
  bytes ??= readFileSync(REFERENCE_FIXTURE);
  return bytes;
}

/** A fresh simulation from the fixture. Every call is a new world. */
export async function loadReferenceFactory(): Promise<Simulation> {
  const file = await decodeSaveFile(referenceFixtureBytes());
  return deserialize(file.state);
}

/** Node's monotonic clock in milliseconds, which is `Profiler`'s unit. */
export const now = (): number => performance.now();

/** One measured run. Milliseconds throughout. */
export interface PhaseProfile {
  readonly ticks: number;
  readonly tickMean: number;
  readonly tickP99: number;
  /** Mean per phase, keyed by `PHASE_NAMES`. */
  readonly phases: Readonly<Record<string, number>>;
}

/**
 * Ticks run before anything is recorded: enough for the JIT to have compiled
 * every system's hot loop, which it does after a few hundred calls. A number
 * taken before that is a measurement of the interpreter.
 */
export const WARMUP_TICKS = 150;

/** Ticks recorded per window: twenty simulated seconds. */
export const MEASURED_TICKS = 600;

/**
 * Windows measured per result, whose median is the result.
 *
 * One window is at the mercy of whatever else the machine did in those two
 * seconds — an editor indexing, a browser tab waking up — and on a laptop
 * that moved one run in five by 20% during C28. The median of three is the
 * window that was neither the unlucky one nor the lucky one, and it is what
 * brought run-to-run variation under the 5% §17 asks for.
 */
export const WINDOWS = 3;

/**
 * Run `simulation` forward and report what each phase cost.
 *
 * `wrap` lets a caller stand between the simulation and the profiler — the
 * regression test uses it to slow one phase down on purpose.
 *
 * Costs `WARMUP_TICKS + WINDOWS * ticks` ticks of the factory's life. The
 * fixture's furnaces have about 10,000 ticks of coal (see
 * `tools/make-reference-factory.ts`), so a caller measuring more than four
 * times loads a fresh one rather than running a factory that is going cold.
 */
export function measurePhases(
  simulation: Simulation,
  ticks: number = MEASURED_TICKS,
  wrap: (profiler: Profiler) => PhaseTimer = (profiler) => profiler,
): PhaseProfile {
  const profiler = new Profiler(now, ticks);
  const timer = wrap(profiler);
  const windows: PhaseProfile[] = [];

  simulation.setPhaseTimer(timer);
  try {
    for (let tick = 0; tick < WARMUP_TICKS; tick++) simulation.tick();
    for (let window = 0; window < WINDOWS; window++) {
      collectGarbage();
      profiler.reset();
      for (let tick = 0; tick < ticks; tick++) simulation.tick();
      windows.push(profileOf(profiler));
    }
  } finally {
    simulation.setPhaseTimer(null);
  }

  // Field by field, so every phase is its own median: the phases of one
  // window are not averaged against the phases of another.
  const phases: Record<string, number> = {};
  for (const name of PHASE_NAMES) phases[name] = median(windows.map((window) => window.phases[name] ?? 0));
  return {
    ticks,
    tickMean: median(windows.map((window) => window.tickMean)),
    tickP99: median(windows.map((window) => window.tickP99)),
    phases,
  };
}

function profileOf(profiler: Profiler): PhaseProfile {
  const snapshot = profiler.snapshot();
  const phases: Record<string, number> = {};
  for (let phase = 0; phase < PHASE_COUNT; phase++) {
    phases[PHASE_NAMES[phase] ?? String(phase)] = snapshot.phases[phase]?.mean ?? 0;
  }
  return { ticks: snapshot.ticks, tickMean: snapshot.tick.mean, tickP99: snapshot.tick.p99, phases };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/**
 * Collect now, if this process was started with `--expose-gc` (the `perf`
 * project is). Whatever the load and the warm-up left behind is then not
 * collected in the middle of the window, which is where a major collection
 * would otherwise land in one run and not the next.
 */
export function collectGarbage(): void {
  (globalThis as { gc?: () => void }).gc?.();
}

/**
 * A timer that makes one phase take twice as long, really.
 *
 * It busy-waits at the end of `phase` for as long as the phase itself took,
 * *before* handing the report on, so the profiler behind it sees a phase that
 * genuinely cost double on the wall clock. That is C28's "a deliberate 2×
 * slowdown in one system", done without editing the system: the detector is
 * tested against a real slowdown measured by the real profiler, rather than
 * against numbers somebody multiplied by two.
 */
export function slowedPhase(phase: Phase, factor = 2): (profiler: Profiler) => PhaseTimer {
  return (profiler) => {
    let last = 0;
    return {
      beginTick(): void {
        profiler.beginTick();
        last = now();
      },
      endPhase(ended: Phase): void {
        if (ended === phase) {
          const took = now() - last;
          const until = now() + took * (factor - 1);
          while (now() < until) {
            // Spinning, deliberately.
          }
        }
        profiler.endPhase(ended);
        last = now();
      },
    };
  };
}

/** One phase judged slower than the baseline says it should be. */
export interface Regression {
  readonly phase: string;
  /** How much slower than the rest of the tick explains, e.g. 2.0. */
  readonly ratio: number;
}

/**
 * A phase's share of the tick below which it is not judged: its mean is a few
 * microseconds, and a few microseconds doubles on noise.
 */
export const MIN_SHARE = 0.03;

/** Slower than this, relative to the rest of the tick, is a regression. */
export const REGRESSION_RATIO = 1.5;

/**
 * Which phases got slower than the machine did.
 *
 * A committed baseline was measured on somebody's laptop, and this may be
 * running on a slower one, a busier one, or one on battery. Comparing
 * absolute milliseconds would call every phase a regression on a machine
 * that is merely slower, and none of them on one that is faster — so each
 * phase is compared against **the rest of the same tick**. If the machine is
 * 30% slower, every phase and every "rest" is 30% slower and every ratio is
 * one; if belts alone doubled, belts' ratio is two and nothing else moves.
 *
 * What this cannot see is the whole tick getting uniformly slower, which is
 * indistinguishable from a slower machine by construction. §12's hard-fail
 * budgets are what catch that, and they are absolute on purpose.
 */
export function findRegressions(
  baseline: PhaseProfile,
  current: PhaseProfile,
  ratioLimit = REGRESSION_RATIO,
  minShare = MIN_SHARE,
): readonly Regression[] {
  const baselineTotal = sum(baseline.phases);
  const currentTotal = sum(current.phases);
  const out: Regression[] = [];
  for (const name of PHASE_NAMES) {
    const before = baseline.phases[name] ?? 0;
    const after = current.phases[name] ?? 0;
    if (baselineTotal <= 0 || before / baselineTotal < minShare) continue;

    const restBefore = baselineTotal - before;
    const restAfter = currentTotal - after;
    if (restBefore <= 0 || restAfter <= 0) continue;

    const ratio = after / before / (restAfter / restBefore);
    if (ratio >= ratioLimit) out.push({ phase: name, ratio });
  }
  return out;
}

function sum(values: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const value of Object.values(values)) total += value;
  return total;
}

/** A profile as a table, for the console. */
export function formatProfile(label: string, profile: PhaseProfile, baseline?: PhaseProfile): string {
  const lines = [`${label}: tick mean ${ms(profile.tickMean)}, p99 ${ms(profile.tickP99)} over ${profile.ticks} ticks`];
  for (const name of PHASE_NAMES) {
    const value = profile.phases[name] ?? 0;
    const before = baseline?.phases[name];
    const change = before === undefined || before <= 0 ? '' : `  (baseline ${ms(before)}, x${(value / before).toFixed(2)})`;
    lines.push(`  ${name.padEnd(12)} ${ms(value).padStart(10)}${change}`);
  }
  return lines.join('\n');
}

function ms(value: number): string {
  return `${value.toFixed(3)} ms`;
}
