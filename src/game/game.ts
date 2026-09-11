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
  readonly simulation: Simulation;
  private readonly loop: GameLoop;

  constructor(options: GameOptions) {
    this.simulation = options.simulation;
    this.loop = new GameLoop(options.scheduler, {
      tick: () => this.simulation.tick(),
      render: options.render,
    });
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
