/**
 * The renderer interface. See ironflow.md C03 task 1.
 *
 * One of the two abstractions §19 rule 10 sanctions, because it has two real
 * implementations planned rather than a hypothetical one: `CanvasRenderer` now,
 * and a WebGL2 renderer if and when §16's optimisation path is walked. Nothing
 * outside `main.ts` should name the concrete class.
 */

import type { Camera } from './camera.js';
import type { RenderState } from './render-state.js';

export interface Renderer {
  /**
   * The drawing surface changed size.
   *
   * `w` and `h` are CSS pixels and `dpr` the device pixel ratio; the backing
   * store is `w * dpr` by `h * dpr`. The renderer draws in CSS pixels and needs
   * the ratio only to snap to whole device pixels (§5 hazard 3).
   */
  resize(w: number, h: number, dpr: number): void;

  /**
   * Draw one frame.
   *
   * `alpha` is the fraction of the way to the next simulation tick, for
   * interpolating positions. It is wall-clock-derived and **must not be used
   * for anything affecting the simulation** (C03 task 7) — nothing here can
   * reach the simulation to try, which is the point of `RenderState`.
   */
  render(state: RenderState, camera: Camera, alpha: number): void;

  /** Release caches and any offscreen surfaces. */
  destroy(): void;
}
