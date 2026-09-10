import type { FrameScheduler } from '../game/game-loop.js';

/**
 * The browser implementation of `FrameScheduler`.
 *
 * This file exists so that `src/game/game-loop.ts` can pace the simulation
 * without ever naming `requestAnimationFrame` or `performance.now`, which §4
 * and §6 R1 forbid inside the simulation core. `src/platform/` holds adapters
 * of exactly this shape: browser APIs wrapped in an interface the core defines.
 */
export class BrowserFrameScheduler implements FrameScheduler {
  /** Whole microseconds. `performance.now()` is sub-millisecond but fractional. */
  now(): number {
    return Math.round(performance.now() * 1000);
  }

  request(cb: () => void): number {
    return requestAnimationFrame(() => cb());
  }

  cancel(handle: number): void {
    cancelAnimationFrame(handle);
  }
}
