import { GameLoop } from './game-loop.js';
import type { FrameScheduler, LoopStats } from './game-loop.js';
import { Simulation } from './simulation.js';

/**
 * Orchestration. See ironflow.md §4.
 *
 * `Game` wires the simulation to the loop and exposes a small surface for the
 * composition root. It deliberately contains no game logic of its own — when a
 * system needs coordinating, the coordination belongs in `Simulation`, not here.
 *
 * Rendering arrives as an injected callback rather than a `Renderer`, because
 * the `Renderer` interface does not exist until C03 and inventing it now would
 * be an abstraction for a hypothetical (§19 rule 10).
 */
export interface GameOptions {
  readonly simulation: Simulation;
  readonly scheduler: FrameScheduler;
  readonly render: (alpha: number) => void;
}

export class Game {
  private current: Simulation;
  private readonly loop: GameLoop;

  constructor(options: GameOptions) {
    this.current = options.simulation;
    this.loop = new GameLoop(options.scheduler, {
      // A closure rather than a bound method, which is what lets `load`
      // replace the world without the loop noticing.
      tick: () => this.current.tick(),
      render: options.render,
    });
  }

  /** The world being simulated right now. */
  get simulation(): Simulation {
    return this.current;
  }

  /**
   * Play a different world — what loading a save is, from here (C25).
   *
   * `deserialize` builds a **fresh** `Simulation` rather than mutating one
   * (C24), because a half-applied load is a factory with two of everything.
   * That leaves exactly one question for this layer: who is holding the old
   * object. The answer is this field and `GameController`, which reads it
   * back through here — so a load is one assignment rather than a graph walk,
   * and nothing downstream can be left pointing at the world before the load.
   *
   * The clock is rebased on the way out: the read, the decode and the
   * deserialize are wall-clock time the player did not play, and crediting it
   * would run a burst of catch-up ticks on a factory that has just appeared.
   */
  replaceSimulation(simulation: Simulation): void {
    this.current = simulation;
    this.loop.resync();
  }

  start(): void {
    this.loop.start();
  }

  stop(): void {
    this.loop.stop();
  }

  isRunning(): boolean {
    return this.loop.isRunning();
  }

  /** Is the simulation held still while the world keeps being drawn? See §8. */
  isPaused(): boolean {
    return this.loop.isPaused();
  }

  /** Hold the simulation still, or let it run again. C07's HUD owns the button. */
  setPaused(paused: boolean): void {
    this.loop.setPaused(paused);
  }

  /** Resume timing after the page was hidden, without crediting the gap. */
  resync(): void {
    this.loop.resync();
  }

  getStats(): LoopStats {
    return this.loop.getStats();
  }
}
