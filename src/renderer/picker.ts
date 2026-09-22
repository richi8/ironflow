/**
 * Turning a pixel back into a thing. See ironflow.md C04 task 5 and C27A.
 *
 * `Camera.screenToTile` answers "which tile is under this pixel" — the ground
 * tile. This answers "which *entity* is under it", which is a different
 * question whenever two entities overlap the same pixel, and the one the
 * cursor is really asking.
 *
 * It lives in `renderer/` rather than `input/` because the answer depends on
 * what was drawn and in what order, and §4 forbids the input layer from
 * knowing that. The input layer names the interface it needs — screen pixels
 * in, a tile out — and the composition root hands it this. Nothing here writes
 * anything.
 *
 * ## What C27A took out of this file
 *
 * Until C27A the renderer drew solids standing up on the ground, so the pixel
 * under the cursor could be the *roof* of a building three rows in front of
 * the tile it geometrically sat on — §5 hazard 2, and the reason this file was
 * written. The hit test was a ray: slide the ground point down the screen by
 * up to the sprite's lift and ask whether it ever lands in the footprint, then
 * take the far end of the crossing because that is the surface facing the
 * camera.
 *
 * Top-down has no lift, so the ray has no length: a sprite covers its
 * footprint and nothing else, and the test is "is this point inside that
 * rectangle". Hazard 2 does not exist any more, and about a hundred lines of
 * exactly-correct ray arithmetic went with it.
 *
 * What did *not* go is this file. An entity is still not the same thing as the
 * tile under the cursor: a 3x3 assembler covers nine tiles, overlays and
 * annotations are drawn over things they do not belong to, and the draw list
 * is still the only place that knows which of two things sharing a tile is on
 * top. The answer is simply cheaper to compute than it was.
 */

import type { TileCoord } from '../game/world/coordinates.js';

import type { Camera } from './camera.js';
import { depthKey } from './layers/entity-layer.js';
import type { RenderEntity } from './render-state.js';

/** What is under a pixel: always a tile, and an entity when one was hit. */
export interface ScenePick {
  readonly tile: TileCoord;
  /** The topmost entity whose sprite covers the pixel, or null for bare ground. */
  readonly entityId: number | null;
}

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
   * and drawing cannot disagree about which of two overlapping things is in
   * front. Reverse-depth iteration with an early exit would be the same answer
   * for a sort this code would have to do itself; taking the maximum costs one
   * pass and no allocation.
   *
   * The scan is linear in the entity count. That is the right shape now and
   * the wrong one at §12's 20,000 entities; the world already has an occupancy
   * map, so this becomes a lookup the day C28's profiler says it must. It runs
   * at most once per frame, so there is nothing to fix yet.
   */
  pick(screenX: number, screenY: number): ScenePick {
    const ground = this.camera.screenToWorld(screenX, screenY);

    let bestKey = -Infinity;
    let bestId = 0;
    let hit = false;

    for (const entity of this.entities()) {
      if (!covers(entity, ground.x, ground.y)) continue;

      const key = depthKey(entity);
      if (key <= bestKey) continue;
      bestKey = key;
      bestId = entity.id;
      hit = true;
    }

    const tile: TileCoord = { x: Math.floor(ground.x), y: Math.floor(ground.y) };
    return hit ? { tile, entityId: bestId } : { tile, entityId: null };
  }
}

/**
 * Is the fractional tile position `(x, y)` inside `entity`'s footprint?
 *
 * Half-open on the far edges: a point exactly on the boundary belongs to the
 * next tile along. That is the convention `Math.floor` already uses, and
 * matching it is what stops a hover highlight landing one tile past the
 * cursor.
 */
function covers(entity: RenderEntity, x: number, y: number): boolean {
  return (
    x >= entity.x && x < entity.x + entity.width && y >= entity.y && y < entity.y + entity.height
  );
}
