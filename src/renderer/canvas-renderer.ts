/**
 * The Canvas 2D renderer. See ironflow.md C03.
 *
 * Three layers in a fixed order — terrain, depth-sorted entities, overlays —
 * over a culled rectangle, into a context it does not own. `CanvasSurface`
 * (platform) owns the element, its backing-store size and the device-pixel
 * transform; this class owns what is painted through it. Splitting it that way
 * is what lets `resize` here be four assignments instead of a second copy of
 * the device-pixel-ratio logic.
 *
 * Nothing in here can reach the simulation. It is handed a `RenderState`, which
 * is a read-only view, and that is the whole of its access to the game (§4).
 */

import type { TileBounds } from '../game/world/coordinates.js';

import type { Camera } from './camera.js';
import { TerrainLayer, type SurfaceFactory, type TerrainStats } from './layers/terrain-layer.js';
import { EntityLayer } from './layers/entity-layer.js';
import { OverlayLayer } from './layers/overlay-layer.js';
import { color } from './palette.js';
import type { RenderState } from './render-state.js';
import type { Renderer } from './renderer.js';
import { ProceduralAtlas, type SpriteAtlas } from './sprite-atlas.js';

/**
 * Cull margin, in tiles, for sprites taller than the ground they stand on.
 *
 * C03 task 6 asks for "a margin equal to the tallest sprite". §5 hazard 1 puts
 * the tallest v1 building at three tiles; four is that plus a tile of slack, and
 * padding all four sides rather than only the near ones costs a handful of
 * world chunks at the edge of a rectangle that is already conservative.
 *
 * Asking the atlas for a real per-sprite height was the alternative. It would
 * mean a method on `SpriteAtlas` that only the culler uses, on an interface
 * whose whole purpose is that C29 can swap the implementation — and a wrong
 * answer from it is an invisible sprite, which is much harder to notice than a
 * few extra tiles of work.
 */
export const TALLEST_SPRITE_TILES = 4;

/** Grow an inclusive rectangle by `margin` tiles on every side. */
export function padBounds(bounds: TileBounds, margin: number): TileBounds {
  if (bounds.maxX < bounds.minX || bounds.maxY < bounds.minY) return bounds;
  return {
    minX: bounds.minX - margin,
    minY: bounds.minY - margin,
    maxX: bounds.maxX + margin,
    maxY: bounds.maxY + margin,
  };
}

export interface CanvasRendererOptions {
  /** Defaults to the procedural placeholders of §11. C29 passes the image atlas. */
  readonly atlas?: SpriteAtlas;
  /** Offscreen surfaces for the terrain cache. Injected so tests can fake them. */
  readonly createSurface?: SurfaceFactory;
}

export interface RendererStats {
  readonly terrain: TerrainStats;
  /** Entities drawn last frame, after culling. */
  readonly entities: number;
  /** The interpolation fraction of the last frame. Presentation only. */
  readonly alpha: number;
}

export class CanvasRenderer implements Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly terrain: TerrainLayer;
  private readonly entities: EntityLayer;
  private readonly overlay: OverlayLayer;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private alpha = 0;

  constructor(ctx: CanvasRenderingContext2D, options: CanvasRendererOptions = {}) {
    const atlas = options.atlas ?? new ProceduralAtlas();
    this.ctx = ctx;
    this.terrain = new TerrainLayer(
      options.createSurface === undefined ? { atlas } : { atlas, createSurface: options.createSurface },
    );
    this.entities = new EntityLayer(atlas);
    this.overlay = new OverlayLayer(atlas);
  }

  /**
   * Record the surface size.
   *
   * It does not touch `canvas.width` or the context transform: `CanvasSurface`
   * has already done both by the time this is called, and two owners of the
   * backing store is one too many. The numbers are kept because clearing needs
   * the extent and the terrain blits need the pixel ratio.
   */
  resize(w: number, h: number, dpr: number): void {
    this.width = w;
    this.height = h;
    this.dpr = dpr;
  }

  getStats(): RendererStats {
    return { terrain: this.terrain.getStats(), entities: this.entities.lastDrawn, alpha: this.alpha };
  }

  render(state: RenderState, camera: Camera, alpha: number): void {
    // Held for the debug readout only. C03 task 7: `alpha` is wall-clock
    // derived and must not affect the simulation — nothing reachable from here
    // can, which is the point of taking a `RenderState` rather than a `Game`.
    this.alpha = alpha;

    const ctx = this.ctx;
    ctx.fillStyle = color('bg-deep');
    ctx.fillRect(0, 0, this.width, this.height);

    const bounds = padBounds(camera.visibleTileBounds(), TALLEST_SPRITE_TILES);

    this.terrain.draw(ctx, state.world, camera, bounds, this.dpr);
    this.entities.draw(ctx, state.entities, camera, bounds, state.player);
    this.overlay.draw(ctx, state, camera);
  }

  destroy(): void {
    this.terrain.destroy();
  }
}
