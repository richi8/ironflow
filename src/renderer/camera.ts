import type { TileBounds, TileCoord } from '../game/world/coordinates.js';

import { screenToTile, tileToScreen, type ScreenPoint, type WorldPoint } from './projection.js';

/**
 * The view onto the world. See ironflow.md C01.
 *
 * The camera is presentation state, not simulation state: it is never
 * serialized into a save's authoritative section, never read by a system, and
 * it may smooth itself against wall-clock time as freely as it likes (§6).
 *
 * All of its transforms are built from `projection.ts` plus an affine
 * scale-and-translate. It contains no projection arithmetic of its own, and a
 * test enforces that.
 */

/** Closest the camera may get. Below this, tiles are smaller than an icon. */
export const ZOOM_MIN = 0.25;

/** Furthest the camera may get. Above this, a screen holds too few tiles. */
export const ZOOM_MAX = 4;

/** Multiplicative change per wheel notch. */
export const ZOOM_STEP = 1.2;

/**
 * Time constant of the zoom ease, in milliseconds.
 *
 * Interpolation happens in log space so that each notch takes the same time
 * regardless of the current zoom — a linear ease makes zooming out from 4x
 * feel violent and zooming in from 0.25x feel stuck.
 */
const ZOOM_SMOOTHING_MS = 55;

/** Bounds on the snap threshold below, for a degenerate or enormous viewport. */
const MIN_SNAP_EPSILON = 1e-6;
const MAX_SNAP_EPSILON = 1e-2;

/**
 * Inclusive tile bounds. `maxX < minX` means nothing is visible.
 *
 * Defined in `game/world/coordinates.ts` and re-exported here: the world
 * iterates the same rectangle the camera culls to, and two structurally
 * identical declarations would let their inclusivity conventions drift apart
 * without a single type error.
 */
export type { TileBounds };

export interface CameraOptions {
  /** Tile-space position shown at the centre of the viewport. Fractional. */
  readonly x?: number;
  readonly y?: number;
  readonly zoom?: number;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
}

/**
 * A world point pinned to a screen point for the duration of a zoom ease.
 *
 * Applying cursor-anchored zoom once, at the moment of the wheel event, is not
 * enough: the zoom then keeps changing for another ~90 ms and the tile slides
 * out from under the cursor. Instead the constraint is stored and re-solved on
 * every frame of the ease, which keeps the tile pinned throughout.
 */
interface ZoomAnchor {
  readonly screenX: number;
  readonly screenY: number;
  readonly worldX: number;
  readonly worldY: number;
}

function clampZoom(zoom: number): number {
  if (zoom < ZOOM_MIN) return ZOOM_MIN;
  if (zoom > ZOOM_MAX) return ZOOM_MAX;
  return zoom;
}

export class Camera {
  private posX: number;
  private posY: number;
  private zoomLevel: number;
  private targetZoomLevel: number;
  private viewportWidth: number;
  private viewportHeight: number;
  private anchor: ZoomAnchor | null = null;

  constructor(options: CameraOptions = {}) {
    this.posX = options.x ?? 0;
    this.posY = options.y ?? 0;
    this.zoomLevel = clampZoom(options.zoom ?? 1);
    this.targetZoomLevel = this.zoomLevel;
    this.viewportWidth = options.viewportWidth ?? 0;
    this.viewportHeight = options.viewportHeight ?? 0;
  }

  /** Tile-space position at the centre of the viewport. */
  get x(): number {
    return this.posX;
  }

  get y(): number {
    return this.posY;
  }

  /** Current, smoothed zoom. This is the one to draw with. */
  get zoom(): number {
    return this.zoomLevel;
  }

  /** Where the zoom is heading. Equal to `zoom` when at rest. */
  get targetZoom(): number {
    return this.targetZoomLevel;
  }

  /** True while the zoom ease is still running. */
  isZooming(): boolean {
    return this.zoomLevel !== this.targetZoomLevel;
  }

  /**
   * Tell the camera how big the canvas is, in CSS pixels.
   *
   * The camera holds the viewport rather than taking it per call. C01 sketches
   * `visibleTileBounds(w, h)`, but `zoomAt` and `screenToWorld` need the same
   * two numbers, and four call sites each passing their own copy is four
   * chances to pass a stale one after a resize. `CanvasSurface` already emits a
   * resize notification; this is the one place that listens to it.
   */
  setViewport(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /** Jump the centre of the view to a tile-space position. Cancels any ease. */
  setPosition(x: number, y: number): void {
    this.posX = x;
    this.posY = y;
    this.anchor = null;
  }

  /** Set zoom with no ease and no anchor. For initialisation and tests. */
  setZoom(zoom: number): void {
    this.zoomLevel = clampZoom(zoom);
    this.targetZoomLevel = this.zoomLevel;
    this.anchor = null;
  }

  /**
   * Drag the world by a screen-pixel delta.
   *
   * Moving the mouse `(dx, dy)` moves the world exactly `(dx, dy)` on screen at
   * every zoom level, because the camera moves by the same delta divided by
   * zoom in world-pixel space before being unprojected.
   */
  pan(dxPx: number, dyPx: number): void {
    if (dxPx === 0 && dyPx === 0) return;

    const centre = tileToScreen(this.posX, this.posY);
    const moved = screenToTile(centre.x - dxPx / this.zoomLevel, centre.y - dyPx / this.zoomLevel);
    this.posX = moved.x;
    this.posY = moved.y;

    // The world moved under the cursor, so the anchor's screen position moves
    // with it. Its world point is unchanged, which keeps the constraint true
    // and lets a pan and a zoom ease run at the same time without fighting.
    if (this.anchor !== null) {
      this.anchor = {
        screenX: this.anchor.screenX + dxPx,
        screenY: this.anchor.screenY + dyPx,
        worldX: this.anchor.worldX,
        worldY: this.anchor.worldY,
      };
    }
  }

  /**
   * Zoom by `steps` multiplicative notches, keeping whatever is under
   * `(screenX, screenY)` under it. `steps` may be fractional or negative.
   */
  zoomAt(screenX: number, screenY: number, steps: number): void {
    const target = clampZoom(this.targetZoomLevel * Math.pow(ZOOM_STEP, steps));
    if (target === this.targetZoomLevel) return; // already at the clamp, or a no-op

    const under = this.screenToWorld(screenX, screenY);
    this.targetZoomLevel = target;
    this.anchor = { screenX, screenY, worldX: under.x, worldY: under.y };
  }

  /**
   * Advance the zoom ease. Call once per rendered frame with the frame's real
   * elapsed milliseconds; this is the camera's only use of wall-clock time.
   */
  update(dtMs: number): void {
    if (this.zoomLevel === this.targetZoomLevel) {
      this.anchor = null;
      return;
    }
    if (dtMs <= 0) return;

    const from = Math.log(this.zoomLevel);
    const to = Math.log(this.targetZoomLevel);
    const t = 1 - Math.exp(-dtMs / ZOOM_SMOOTHING_MS);

    const stepped = from + (to - from) * t;
    this.zoomLevel = Math.abs(to - stepped) < this.snapEpsilon() ? this.targetZoomLevel : Math.exp(stepped);

    // Re-solved from the stored world point every frame rather than nudged, so
    // a long ease accumulates no drift.
    this.solveForAnchor();

    if (this.zoomLevel === this.targetZoomLevel) this.anchor = null;
  }

  /** Tile-space position (fractional allowed) to a pixel on the canvas. */
  worldToScreen(wx: number, wy: number): ScreenPoint {
    const point = tileToScreen(wx, wy);
    const centre = tileToScreen(this.posX, this.posY);
    return {
      x: (point.x - centre.x) * this.zoomLevel + this.viewportWidth / 2,
      y: (point.y - centre.y) * this.zoomLevel + this.viewportHeight / 2,
    };
  }

  /** The exact inverse of `worldToScreen`. Returns a fractional tile position. */
  screenToWorld(sx: number, sy: number): WorldPoint {
    const centre = tileToScreen(this.posX, this.posY);
    return screenToTile(
      (sx - this.viewportWidth / 2) / this.zoomLevel + centre.x,
      (sy - this.viewportHeight / 2) / this.zoomLevel + centre.y,
    );
  }

  /**
   * The tile containing a canvas pixel — the *ground* tile.
   *
   * A tall building drawn over that ground tile is not considered (§5 hazard 2)
   * — that is `picker.ts`'s job, and it is the one to ask when the answer has
   * to match what the player can see. This is the right answer for everything
   * that is about the ground itself: cull bounds, terrain, a click on bare map.
   */
  screenToTile(sx: number, sy: number): TileCoord {
    const world = this.screenToWorld(sx, sy);
    return { x: Math.floor(world.x), y: Math.floor(world.y) };
  }

  /**
   * Inclusive tile bounds covering everything at least partly on screen.
   *
   * The viewport is a screen-space rectangle, so in tile space it is a rotated
   * one; this returns its axis-aligned bounding box, which over-covers at the
   * corners and never under-covers. Tile `(x, y)` occupies the unit square
   * `[x, x+1] x [y, y+1]`, so it is visible exactly when `x + 1 > minX` and
   * `x < maxX` — hence `floor` on the low side and `ceil - 1` on the high side,
   * which stays correct when a bound lands exactly on an integer.
   *
   * This bounds the *ground*. A sprite taller than one tile can be visible
   * while its ground tile is not; the renderer pads for sprite height when it
   * culls (§5 hazard 1), because only the renderer knows how tall things are.
   */
  visibleTileBounds(): TileBounds {
    if (this.viewportWidth <= 0 || this.viewportHeight <= 0) {
      return { minX: 0, minY: 0, maxX: -1, maxY: -1 };
    }

    const topLeft = this.screenToWorld(0, 0);
    const topRight = this.screenToWorld(this.viewportWidth, 0);
    const bottomLeft = this.screenToWorld(0, this.viewportHeight);
    const bottomRight = this.screenToWorld(this.viewportWidth, this.viewportHeight);

    const minX = Math.min(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
    const maxX = Math.max(topLeft.x, topRight.x, bottomLeft.x, bottomRight.x);
    const minY = Math.min(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);
    const maxY = Math.max(topLeft.y, topRight.y, bottomLeft.y, bottomRight.y);

    return {
      minX: Math.floor(minX),
      minY: Math.floor(minY),
      maxX: Math.ceil(maxX) - 1,
      maxY: Math.ceil(maxY) - 1,
    };
  }

  /**
   * How close to the target zoom counts as arrived.
   *
   * An exponential ease never actually reaches its target, so it needs a
   * threshold — and an arbitrary one is either a visible snap or a tail that
   * keeps `isZooming()` true for half a second after the motion has visibly
   * stopped. This derives it instead: a residual log-zoom of `e` displaces a
   * point `d` pixels from the anchor by about `e * d`, and the furthest point
   * on screen is at most a viewport diagonal away. Snap when that displacement
   * drops below half a pixel, which is the point at which finishing the ease
   * could not change a single drawn pixel.
   */
  private snapEpsilon(): number {
    const diagonal = Math.max(Math.hypot(this.viewportWidth, this.viewportHeight), 1);
    const epsilon = 0.5 / diagonal;
    if (epsilon < MIN_SNAP_EPSILON) return MIN_SNAP_EPSILON;
    if (epsilon > MAX_SNAP_EPSILON) return MAX_SNAP_EPSILON;
    return epsilon;
  }

  /** Move the camera so the anchored world point sits back under its pixel. */
  private solveForAnchor(): void {
    const anchor = this.anchor;
    if (anchor === null) return;

    const point = tileToScreen(anchor.worldX, anchor.worldY);
    const centre = screenToTile(
      point.x - (anchor.screenX - this.viewportWidth / 2) / this.zoomLevel,
      point.y - (anchor.screenY - this.viewportHeight / 2) / this.zoomLevel,
    );
    this.posX = centre.x;
    this.posY = centre.y;
  }
}
