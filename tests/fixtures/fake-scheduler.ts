import type { FrameScheduler } from '../../src/game/game-loop.js';

/**
 * A `FrameScheduler` the test drives by hand. Frames only happen when we say
 * so, and time only moves when we move it — which is the entire reason
 * `GameLoop` takes a scheduler instead of calling `requestAnimationFrame`.
 */
export class FakeScheduler implements FrameScheduler {
  private us = 0;
  private queued: (() => void) | null = null;
  private nextHandle = 1;

  now(): number {
    return this.us;
  }

  request(cb: () => void): number {
    this.queued = cb;
    return this.nextHandle++;
  }

  cancel(): void {
    this.queued = null;
  }

  /**
   * Advance time *without* running a frame — what a hidden tab does, since
   * `requestAnimationFrame` stops firing while the page is not visible.
   */
  advance(dtUs: number): void {
    this.us += dtUs;
  }

  /** Advance time by `dtUs` and run the frame that was waiting. */
  runFrame(dtUs: number): void {
    this.us += dtUs;
    const cb = this.queued;
    this.queued = null;
    cb?.();
  }

  /** Run `count` frames of `dtUs` each. */
  runFrames(count: number, dtUs: number): void {
    for (let i = 0; i < count; i++) this.runFrame(dtUs);
  }

  hasPendingFrame(): boolean {
    return this.queued !== null;
  }
}
