import type { LoopStats } from '../game/game-loop.js';
import { PHASE_NAMES } from '../game/phase-timer.js';
import { TICK_MS } from '../game/simulation-clock.js';

import { BUDGETS, judge, type Budget } from './budgets.js';
import type { Census } from './census.js';
import type { DebugRows, RowTone } from './debug-overlay.js';
import type { ProfileSnapshot, RollingWindow } from './profiler.js';

/**
 * The F3 overlay's performance sections: §12's table with live numbers in it.
 * See ironflow.md C28 task 2.
 *
 * ```text
 * frame     fps, render, frame interval, sim per frame, ticks/frame,
 *           accumulator, shed frames, longest frame (GC pauses)
 * tick      mean and p99 over the last ten seconds, then every phase
 * world     entities, belts and their items, machines, inserters,
 *           on-screen entities, visible and loaded world chunks, heap
 * once      cold start, worldgen, last save's serialize and size, last load
 * ```
 *
 * A row §12 has a budget for is coloured against it — within target, over
 * target, past the hard-fail line — using the same `BUDGETS` the perf suite
 * fails on, so the overlay and `npm run perf` cannot disagree about what "too
 * slow" means. A row with nothing measured yet says `—` rather than `0`,
 * because "no save this session" and "a save that took no time" are different
 * statements.
 *
 * Everything here is formatting; every number is measured by the caller.
 */

/** Real time, per frame, over a rolling window. Kept by `main.ts`. */
export interface FrameTimes {
  /** The whole render callback: draw, UI and everything else a frame does besides ticking. */
  readonly render: RollingWindow;
  /** Time between one frame and the next. The reciprocal of the frame rate. */
  readonly interval: RollingWindow;
}

/** Things measured once, or once per event. Milliseconds unless named otherwise. */
export interface Milestones {
  readonly coldStart: number | null;
  readonly worldgen: number | null;
  readonly serialize: number | null;
  readonly saveBytes: number | null;
  readonly load: number | null;
}

export interface PerformanceReadout {
  readonly loop: LoopStats;
  readonly frames: FrameTimes;
  /** `null` while no profiler is attached. */
  readonly profile: ProfileSnapshot | null;
  readonly census: Census;
  /** Entities the renderer drew last frame, after culling. */
  readonly drawn: number;
  readonly visibleChunks: number;
  readonly loadedChunks: number;
  /** `performance.memory.usedJSHeapSize` in MB, where the browser has it. */
  readonly heapMB: number | null;
  readonly once: Milestones;
}

/**
 * A frame longer than this is a hitch rather than a returning tab.
 *
 * §8 stops the loop in a background tab, and the first frame after it comes
 * back measures however long the tab was away. That is not a GC pause, and
 * counting it as one would put a red number on the overlay every time a
 * person switched windows.
 */
const HITCH_CEILING_MS = 1_000;

export function writePerformanceRows(rows: DebugRows, readout: PerformanceReadout): void {
  const { loop, frames, profile, census, once } = readout;

  rows.section('frame');
  const interval = frames.interval.mean();
  const fps = interval > 0 ? 1000 / interval : 0;
  rows.row('fps', fps.toFixed(1), toned(BUDGETS.fps, fps, frames.interval.size > 0));
  const render = frames.render.mean();
  rows.row('render', `${ms(render)} mean`, toned(BUDGETS.renderMean, render, frames.render.size > 0));
  rows.row('interval', `${ms(interval)} mean`);
  rows.row('sim/frame', ms(loop.simMs));
  rows.row('ticks/frame', String(loop.steps));
  rows.row('accumulator', `${ms(loop.alpha * TICK_MS)} (α ${loop.alpha.toFixed(2)})`);
  rows.row('shed', String(loop.shedCount));
  const longest = longestFrame(frames.interval);
  rows.row('longest', `${ms(longest)} in ${frames.interval.size}`, toned(BUDGETS.gcPause, longest, longest > 0));

  rows.section('tick');
  if (profile === null || profile.ticks === 0) {
    rows.row('mean', '—');
    rows.row('p99', '—');
  } else {
    rows.row('mean', ms(profile.tick.mean), toned(BUDGETS.tickMean, profile.tick.mean, true));
    rows.row('p99', `${ms(profile.tick.p99)} (max ${ms(profile.tick.max)})`, toned(BUDGETS.tickP99, profile.tick.p99, true));
  }
  for (let phase = 0; phase < PHASE_NAMES.length; phase++) {
    const stats = profile?.phases[phase];
    rows.row(PHASE_NAMES[phase] ?? String(phase), stats === undefined || profile?.ticks === 0 ? '—' : ms(stats.mean));
  }

  rows.section('world');
  rows.row('entities', `${count(census.entities)} (${count(readout.drawn)} drawn)`);
  rows.row('belts', `${count(census.belts)}, ${count(census.beltItems)} items`);
  rows.row('machines', count(census.machines));
  rows.row('inserters', count(census.inserters));
  rows.row('chunks', `${readout.visibleChunks} visible / ${count(readout.loadedChunks)} loaded`);
  rows.row(
    'heap',
    readout.heapMB === null ? 'n/a in this browser' : `${readout.heapMB.toFixed(0)} MB`,
    readout.heapMB === null ? null : judge(BUDGETS.heap, readout.heapMB),
  );

  rows.section('once');
  rows.row('cold start', optionalMs(once.coldStart), optionalTone(BUDGETS.coldStart, once.coldStart));
  rows.row('worldgen', once.worldgen === null ? '— (loaded)' : ms(once.worldgen));
  rows.row('serialize', optionalMs(once.serialize), optionalTone(BUDGETS.serialize, once.serialize));
  const saveMB = once.saveBytes === null ? null : once.saveBytes / (1024 * 1024);
  rows.row(
    'save size',
    once.saveBytes === null ? '—' : `${(once.saveBytes / 1024).toFixed(0)} kB`,
    optionalTone(BUDGETS.saveSize, saveMB),
  );
  rows.row('load', optionalMs(once.load), optionalTone(BUDGETS.load, once.load));
}

/**
 * The longest frame in the window that was not a returning tab.
 *
 * §12's "GC pauses during steady play: none visible, any > 50 ms is a fail".
 * The browser does not say when it collects, so a pause is seen the only way
 * a player sees one: a frame that took too long.
 */
function longestFrame(window: RollingWindow): number {
  return window.max(HITCH_CEILING_MS);
}

function toned(budget: Budget, value: number, measured: boolean): RowTone {
  return measured ? judge(budget, value) : null;
}

function optionalTone(budget: Budget, value: number | null): RowTone {
  return value === null ? null : judge(budget, value);
}

function ms(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)} ms`;
}

function optionalMs(value: number | null): string {
  return value === null ? '—' : ms(value);
}

/** A count with a comma every three digits. Not `toLocaleString`: this is read by developers, not localised. */
function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
