/**
 * Turning a pixel back into a thing. See ironflow.md C04 task 5 and §5 hazard 2.
 *
 * `Camera.screenToTile` answers "which tile is under this pixel" — the *ground*
 * tile. That is the wrong answer whenever the pixel is on a building: hovering
 * the roof of a three-tile power plant would highlight a tile three rows behind
 * it, which is §5 hazard 2 and the reason this file exists.
 *
 * It lives in `renderer/` rather than `input/` because the answer depends on
 * how tall a sprite is drawn, and §4 forbids the input layer from knowing that.
 * The input layer names the interface it needs — screen pixels in, a tile out —
 * and the composition root hands it this. Nothing here writes anything.
 *
 * ## How the hit test works
 *
 * A prism is its ground face swept straight up the screen by `rise * RISE_UNIT`
 * pixels. So a screen point is inside it exactly when that point, slid **down**
 * the screen by somewhere between zero and the full lift, lands inside the
 * footprint.
 *
 * Unprojecting turns that into tile-space arithmetic, because sliding down the
 * screen slides along the `(1, 1)` tile diagonal — one rise unit is exactly one
 * diagonal tile step. The test becomes
 *
 * ```text
 * exists s in [0, 1] :  ground + s * rise * (1, 1)  is inside the footprint
 * ```
 *
 * which is a ray against an axis-aligned rectangle: four divisions, no polygon
 * clipping, and exact at every zoom because the lift scales with zoom and
 * unprojection divides it straight back out.
 *
 * ## Which end of the ray the player is looking at
 *
 * The ray usually crosses the solid, so it has two ends and only one of them
 * is a surface the player can see. It is the **far** end — the largest `s`.
 *
 * Write the drawing out in three dimensions and the reason is immediate: a
 * point at footprint tile `(x, y)` and height `z` lands at screen `y` of
 * `(x + y) * halfTile - z * riseUnit`, so the ray that holds one screen point
 * fixed runs along `(1, 1, 1)`. §5 already fixes which way along it the camera
 * is: larger `x + y` draws *in front*, so larger is nearer, so the nearest
 * surface is the one with the largest `s`. Taking the smallest instead would
 * return the tile at the back of the building — which looks correct on a 1x1
 * and is silently wrong on everything larger.
 */

import type { TileCoord } from '../game/world/coordinates.js';

import type { Camera } from './camera.js';
import { depthKey } from './layers/entity-layer.js';
import { screenToTile } from './projection.js';
import type { RenderEntity } from './render-state.js';
import { RISE_UNIT, describeSprite } from './sprite-atlas.js';

/** What is under a pixel: always a tile, and an entity when one was hit. */
export interface ScenePick {
  readonly tile: TileCoord;
  /** The topmost entity whose sprite covers the pixel, or null for bare ground. */
  readonly entityId: number | null;
}

/**
 * Tile-space displacement of one `rise` unit of screen lift.
 *
 * This is `(1, 1)`, and it is derived rather than written as `1` so that
 * changing how tall a rise unit is cannot silently desynchronise picking from
 * drawing. The projection is linear, so unprojecting the displacement is the
 * displacement of the unprojection — no camera needed, and no zoom either,
 * since the lift grows with zoom and this division shrinks by the same factor.
 */
const RISE_STEP: TileCoord = screenToTile(0, RISE_UNIT);

export class ScenePicker {
  private readonly camera: Camera;
  private readonly entities: () => readonly RenderEntity[];

  /**
   * @param entities the current frame's draw list. A supplier rather than an
   * array because the controller rebuilds it every frame; holding one array
   * would pin picking to whatever was on screen when this was constructed.
   */
  constructor(camera: Camera, entities: () => readonly RenderEntity[]) {
    this.camera = camera;
    this.entities = entities;
  }

  /**
   * What the player is pointing at, in canvas-local CSS pixels.
   *
   * Entities are scanned and the deepest hit wins, which is the same thing as
   * "topmost in draw order" — `depthKey` *is* the draw order (§5), so picking
   * and drawing cannot disagree about which of two overlapping buildings is in
   * front. Reverse-depth iteration with an early exit would be the same answer
   * for a sort this code would have to do itself; taking the maximum costs one
   * pass and no allocation.
   *
   * The scan is linear in the entity count. That is the right shape now and
   * the wrong one at §12's 20,000 entities; C06 gives the world an occupancy
   * map, at which point this becomes a lookup in the handful of tiles the ray
   * crosses. It runs at most once per frame, so there is nothing to fix yet.
   */
  pick(screenX: number, screenY: number): ScenePick {
    const ground = this.camera.screenToWorld(screenX, screenY);

    let bestKey = -Infinity;
    let bestTile: TileCoord | null = null;
    let bestId = 0;

    for (const entity of this.entities()) {
      const hit = hitTest(entity, ground.x, ground.y);
      if (hit === null) continue;

      const key = depthKey(entity);
      if (key <= bestKey) continue;
      bestKey = key;
      bestTile = hit;
      bestId = entity.id;
    }

    if (bestTile !== null) return { tile: bestTile, entityId: bestId };
    return { tile: { x: Math.floor(ground.x), y: Math.floor(ground.y) }, entityId: null };
  }
}

/**
 * Which of `entity`'s tiles the cursor is on, or null if the sprite misses it.
 *
 * `(groundX, groundY)` is the fractional tile position the pixel unprojects to
 * with no height applied — the foot of the sweep described at the top.
 */
function hitTest(entity: RenderEntity, groundX: number, groundY: number): TileCoord | null {
  const rise = riseOf(entity);
  const dx = RISE_STEP.x * rise;
  const dy = RISE_STEP.y * rise;

  // The footprint is half-open: a point on the far edge belongs to the next
  // tile. That is the convention `Math.floor` already uses, and matching it is
  // what stops a hover highlight landing one tile past the cursor.
  const spanX = axisSpan(groundX, dx, entity.x, entity.x + entity.width);
  if (spanX === null) return null;

  const spanY = axisSpan(groundY, dy, entity.y, entity.y + entity.height);
  if (spanY === null) return null;

  const nearest = Math.min(spanX.hi, spanY.hi);
  if (nearest < Math.max(spanX.lo, spanY.lo)) return null;

  // Clamped because the ray leaves through a face of the footprint, so the
  // exit point sits exactly on a boundary and floors to one tile past it about
  // as often as not. The hit is inside the footprint by construction; the
  // clamp resolves which side of the edge it is counted on, and never invents
  // a tile the building does not stand on.
  return {
    x: clamp(Math.floor(groundX + dx * nearest), entity.x, entity.x + entity.width - 1),
    y: clamp(Math.floor(groundY + dy * nearest), entity.y, entity.y + entity.height - 1),
  };
}

/**
 * The sub-range of `s` within `[0, 1]` for which `start + s * length` lies in
 * `[min, max)`, or null when there is none.
 *
 * A `length` of zero is the flat case — a belt, a terrain overlay — where the
 * answer is all of it or none of it.
 */
function axisSpan(start: number, length: number, min: number, max: number): { lo: number; hi: number } | null {
  if (length === 0) {
    return start >= min && start < max ? FULL_SPAN : null;
  }
  const a = (min - start) / length;
  const b = (max - start) / length;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(1, Math.max(a, b));
  return lo <= hi ? { lo, hi } : null;
}

const FULL_SPAN = Object.freeze({ lo: 0, hi: 1 });

/** How tall this entity is drawn, in rise units. Flat things are zero. */
function riseOf(entity: RenderEntity): number {
  const sprite = describeSprite(entity.sprite);
  return sprite.kind === 'prism' ? sprite.rise : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
