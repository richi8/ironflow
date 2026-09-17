import type { Command } from '../../src/game/commands/command.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

import { layReferenceFactory, PLAYER_TILE, referenceWorld } from './reference-factory.js';
import { hashLayout, hashState } from './state-hash.js';

/**
 * The determinism harness. C18 task 5:
 *
 * ```ts
 * function runScenario(seed: number, commands: TimedCommand[], ticks: number): Hash;
 * ```
 *
 * A scenario is the four things §6's contract names — a seed, an initial
 * state, a command sequence and a tick count — turned into one number. Two
 * scenarios that agree on all four must produce the same number, and the whole
 * of C18's test file is that sentence asked in three different ways.
 *
 * ## It is driven through the loop, not by calling `tick()`
 *
 * `runScenario` pumps frames into a `GameLoop` through a `FakeScheduler`
 * rather than calling `simulation.tick()` in a loop. That is what makes the
 * frame-pattern test meaningful: §8's accumulator, its clamp, its step cap and
 * its debt-shedding all sit between a frame and a tick, and a harness that
 * skipped them would be testing the simulation against itself rather than
 * against the loop that drives it in a browser.
 *
 * ## Commands are placed on ticks, not on frames
 *
 * A frame can run up to `MAX_STEPS_PER_FRAME` ticks, so "enqueue before each
 * frame" would land a command on a different tick under a different frame
 * pattern — and the frame-pattern test would fail for a reason that has
 * nothing to do with the simulation. `ScriptedSimulation` therefore enqueues
 * each command inside the tick it is due on, which is the same guarantee §7
 * gives a real player: what you clicked is applied at the start of a tick, and
 * which tick is decided by the clock rather than by the renderer.
 *
 * Time is then run until the simulation has taken **exactly** `ticks` steps,
 * however many frames that takes. §8 is explicit that wall-clock time away
 * costs nothing and produces nothing, so a scenario is a number of ticks and
 * never a number of seconds; a two-second stall runs fewer ticks per second of
 * real time and the same ticks overall, which is precisely the thing the
 * acceptance criterion is asking about.
 */

/** A command and the tick it is applied on. Tick 1 is the first tick. */
export interface TimedCommand {
  readonly tick: number;
  readonly command: Command;
}

/** Eight hex digits from `state-hash.ts`. */
export type Hash = string;

/**
 * How long each successive frame is, in microseconds.
 *
 * A function of the frame index rather than a list, so a pattern is a rule
 * ("jitter between 5 and 120 ms") instead of a table someone has to keep as
 * long as the run.
 */
export type FramePattern = (frameIndex: number) => number;

/** Steady 60 Hz, the pattern everything else is compared against. */
export const STEADY_60: FramePattern = () => 16_667;

/**
 * 5–120 ms, varying every frame, with no clock behind it.
 *
 * The jitter comes from a tiny integer hash of the frame index rather than
 * from the game's own PRNG: the *pacing* is not authoritative state, and
 * drawing it from the simulation stream would advance a position the hash then
 * compares — a test that changed the thing it measured.
 */
export const JITTERY: FramePattern = (i) => {
  const mixed = Math.imul(i + 1, 0x9e3779b1) >>> 0;
  return 5_000 + (mixed % 115_001);
};

/** Steady 60 Hz with one two-second stall, five seconds in (§8's clamp). */
export const STALLING: FramePattern = (i) => (i === 300 ? 2_000_000 : 16_667);

/** What a scenario is made of, beyond §6's four ingredients. */
export interface ScenarioOptions {
  /** How the entities are laid down. Only the ids differ. See the factory. */
  readonly order?: 'forwards' | 'backwards';
  /** Frame lengths. Defaults to steady 60 Hz. */
  readonly pattern?: FramePattern;
  /**
   * Hash the id-free, tile-keyed projection instead of the whole state.
   *
   * Only the build-order test wants this, and only because §6 R5 makes ids a
   * real difference between two orders — see `canonicalLayout`.
   */
  readonly ignoreIds?: boolean;
}

/**
 * A simulation that applies a script at the start of the tick it belongs to.
 *
 * The one thing the harness adds to the real game, and it adds it at the only
 * place §7 allows: the command queue. `super.tick()` drains it as it always
 * does, so a scripted command travels exactly the path a clicked one does.
 */
class ScriptedSimulation extends Simulation {
  /** Commands by the tick they are due on. Built once; never iterated (§6 R4). */
  private script = new Map<number, readonly Command[]>();

  /**
   * The tick the measurement stops at.
   *
   * A frame may carry up to `MAX_STEPS_PER_FRAME` ticks, so a loop driven by
   * frames cannot land on an exact tick count: a jittery pattern would sail
   * two ticks past ten thousand where a steady one stopped on it, and the two
   * hashes would differ for a reason that is about pacing rather than about
   * the simulation. §6's contract is stated in ticks, so the limit is where
   * the *measurement* ends — the loop keeps running, and the world simply
   * stops moving once it has taken the steps the scenario asked for.
   */
  private limit = Number.POSITIVE_INFINITY;

  setTickLimit(ticks: number): void {
    this.limit = ticks;
  }

  setScript(commands: readonly TimedCommand[]): void {
    const byTick = new Map<number, Command[]>();
    for (const timed of commands) {
      const list = byTick.get(timed.tick);
      if (list === undefined) byTick.set(timed.tick, [timed.command]);
      else list.push(timed.command);
    }
    this.script = byTick;
  }

  override tick(): void {
    if (this.getTick() >= this.limit) return;
    // `getTick()` is the count of ticks *finished*, so the tick about to run
    // is the next one — and a command due on it is enqueued now, before
    // `super.tick()` drains the queue.
    const due = this.script.get(this.getTick() + 1);
    if (due !== undefined) {
      for (const command of due) this.commands.enqueue(command);
    }
    super.tick();
  }
}

/** A scenario, built but not yet run. Exposed so a test can look inside one. */
export interface Scenario {
  readonly simulation: Simulation;
  readonly game: Game;
  readonly scheduler: FakeScheduler;
}

/** Build the scenario's world without running it. */
export function buildScenario(
  seed: number,
  commands: readonly TimedCommand[],
  ticks: number,
  options: ScenarioOptions = {},
): Scenario {
  const simulation = new ScriptedSimulation({ world: referenceWorld(), seed });
  simulation.player.setTilePosition(PLAYER_TILE.x, PLAYER_TILE.y);
  // Enough to pay for whatever the script builds. A refused `build` would be a
  // perfectly deterministic nothing, and a test that silently measured nothing
  // is the failure this stock exists to prevent.
  simulation.inventory.add('chest', 4);
  simulation.inventory.add('belt', 4);
  layReferenceFactory(simulation, options.order ?? 'forwards');
  simulation.setScript(commands);
  simulation.setTickLimit(ticks);

  const scheduler = new FakeScheduler();
  const game = new Game({ simulation, scheduler, render: () => {} });
  return { simulation, game, scheduler };
}

/**
 * Run a scenario to exactly `ticks` ticks and hash what it produced.
 *
 * The frame loop is bounded: a pattern that produced no ticks at all would
 * otherwise spin forever, and a test that hangs is worse than one that fails.
 * The bound is generous — one tick per frame is the floor, and a frame can
 * carry five.
 */
export function runScenario(
  seed: number,
  commands: readonly TimedCommand[],
  ticks: number,
  options: ScenarioOptions = {},
): Hash {
  const { simulation, game, scheduler } = buildScenario(seed, commands, ticks, options);
  const pattern = options.pattern ?? STEADY_60;

  game.start();

  // A 60 Hz frame is half a tick, so a run needs about twice as many frames as
  // ticks; four times that is room for any pattern short of one that produces
  // no ticks at all, and that one has to fail rather than hang.
  const maxFrames = ticks * 4 + 256;
  let frame = 0;
  while (simulation.getTick() < ticks && frame < maxFrames) {
    scheduler.runFrame(pattern(frame));
    frame += 1;
  }
  game.stop();

  if (simulation.getTick() !== ticks) {
    throw new Error(
      `runScenario: asked for ${ticks} ticks, ran ${simulation.getTick()} in ${frame} frames. ` +
        'A frame pattern that overshoots the last tick cannot be compared against one that does not.',
    );
  }

  return options.ignoreIds === true ? hashLayout(simulation) : hashState(simulation);
}
