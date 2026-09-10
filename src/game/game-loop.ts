import { SimulationClock } from './simulation-clock.js';

/**
 * Drives frames and turns them into simulation ticks. See ironflow.md §8.
 *
 * The loop lives in `src/game/` and therefore may not touch `requestAnimationFrame`
 * or `performance.now` (§4, §6 R1). It takes a `FrameScheduler` instead. The
 * browser implementation lives in `src/platform/browser-clock.ts`; the tests
 * supply a fake one, which is what makes the pacing testable at all.
 */

/** Everything the loop needs from the host environment. */
export interface FrameScheduler {
  /** Monotonic time in whole microseconds. */
  now(): number;
  /** Schedule `cb` for the next frame. Returns a cancellable handle. */
  request(cb: () => void): number;
  /** Cancel a previously scheduled frame. */
  cancel(handle: number): void;
}

export interface GameLoopHandlers {
  /** Advance the simulation by exactly one fixed timestep. */
  tick(): void;
  /** Draw. `alpha` is the 0..1 fraction toward the next tick, for interpolation. */
  render(alpha: number): void;
}

export interface LoopStats {
  /** Smoothed frames per second. */
  readonly fps: number;
  /** Smoothed wall time for a whole frame, ms. */
  readonly frameMs: number;
  /** Smoothed time spent in simulation ticks this frame, ms. */
  readonly simMs: number;
  /** Smoothed time spent rendering, ms. */
  readonly renderMs: number;
  /** Ticks run in the most recent frame. */
  readonly steps: number;
  /** Interpolation fraction from the most recent frame. */
  readonly alpha: number;
  /** Frames whose simulation debt was discarded because we could not keep up. */
  readonly shedCount: number;
  /** Frames drawn since start. */
  readonly frameCount: number;
}

/** Exponential smoothing factor for the timing readouts. Display only. */
const SMOOTHING = 0.1;

export class GameLoop {
  private readonly scheduler: FrameScheduler;
  private readonly handlers: GameLoopHandlers;
  private readonly clock = new SimulationClock();

  private handle: number | null = null;
  private running = false;

  private frameMs = 0;
  private simMs = 0;
  private renderMs = 0;
  private lastSteps = 0;
  private lastAlpha = 0;
  private frameCount = 0;

  private fpsWindowStartUs = 0;
  private fpsWindowFrames = 0;
  private fps = 0;

  constructor(scheduler: FrameScheduler, handlers: GameLoopHandlers) {
    this.scheduler = scheduler;
    this.handlers = handlers;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const now = this.scheduler.now();
    this.clock.reset(now);
    this.fpsWindowStartUs = now;
    this.fpsWindowFrames = 0;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.handle !== null) {
      this.scheduler.cancel(this.handle);
      this.handle = null;
    }
  }

  /**
   * Resume timing without crediting the elapsed gap.
   *
   * Call when the page becomes visible again. Without it the clamp in
   * SimulationClock would still cap the catch-up at MAX_FRAME_US, but the
   * player would get a quarter-second lurch for no reason.
   */
  resync(): void {
    this.clock.reset(this.scheduler.now());
  }

  getStats(): LoopStats {
    return {
      fps: this.fps,
      frameMs: this.frameMs,
      simMs: this.simMs,
      renderMs: this.renderMs,
      steps: this.lastSteps,
      alpha: this.lastAlpha,
      shedCount: this.clock.getShedCount(),
      frameCount: this.frameCount,
    };
  }

  private schedule(): void {
    this.handle = this.scheduler.request(this.frame);
  }

  /** Arrow property so it can be handed to the scheduler without binding. */
  private readonly frame = (): void => {
    if (!this.running) return;

    const frameStart = this.scheduler.now();
    const budget = this.clock.advance(frameStart);

    const simStart = this.scheduler.now();
    for (let i = 0; i < budget.steps; i++) {
      this.handlers.tick();
    }
    const simEnd = this.scheduler.now();

    this.handlers.render(budget.alpha);
    const frameEnd = this.scheduler.now();

    this.lastSteps = budget.steps;
    this.lastAlpha = budget.alpha;
    this.frameCount += 1;
    this.simMs = smooth(this.simMs, (simEnd - simStart) / 1000);
    this.renderMs = smooth(this.renderMs, (frameEnd - simEnd) / 1000);
    this.frameMs = smooth(this.frameMs, (frameEnd - frameStart) / 1000);

    this.fpsWindowFrames += 1;
    const windowUs = frameEnd - this.fpsWindowStartUs;
    if (windowUs >= 500_000) {
      this.fps = (this.fpsWindowFrames * 1_000_000) / windowUs;
      this.fpsWindowStartUs = frameEnd;
      this.fpsWindowFrames = 0;
    }

    this.schedule();
  };
}

function smooth(previous: number, sample: number): number {
  return previous === 0 ? sample : previous + (sample - previous) * SMOOTHING;
}
