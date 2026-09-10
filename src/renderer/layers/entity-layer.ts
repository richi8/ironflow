/**
 * The depth-sorted entity layer. See ironflow.md C03 task 5 and §5.
 *
 * §18 risk 2 — "depth sorting breaks with tall multi-tile buildings" — is rated
 * high likelihood, and the mitigation named there is this file: an explicit
 * depth key with an entity-id tie-break, and overlays drawn afterwards.
 */

import type { TileBounds } from '../../game/world/coordinates.js';
import type { Camera } from '../camera.js';
import { RENDER_LAYER_COUNT, type RenderEntity } from '../render-state.js';
import type { SpriteAtlas } from '../sprite-atlas.js';

/**
 * Entity ids the depth key can encode without collision.
 *
 * 67 million, against §12's reference factory of 20,000 entities. Ids are
 * never reused, so the bound is on total placements over the life of a save
 * rather than on entities alive at once — which is why it is generous.
 */
export const DEPTH_ID_LIMIT = 2 ** 26;

/** Distance between adjacent layer biases in the key. One id space wide. */
export const DEPTH_LAYER_STRIDE = DEPTH_ID_LIMIT;

/** Distance between adjacent depth rows. One id space per layer. */
export const DEPTH_TILE_STRIDE = DEPTH_LAYER_STRIDE * RENDER_LAYER_COUNT;

/**
 * The painter's-algorithm sort key from §5.
 *
 * ```text
 * depth = (x + y) * LARGE + layerBias * SMALL + entityId
 * ```
 *
 * Three properties, all of them load-bearing:
 *
 * - **`x + y` is the depth axis.** Larger draws later, so it draws in front.
 *   A multi-tile building uses its **maximum** corner (§5), because that is the
 *   corner nearest the camera and the one that decides what it may cover.
 * - **The layer bias orders things sharing a tile**, so an item never sinks
 *   into the belt carrying it.
 * - **The entity id breaks the remaining ties deterministically.** Ids are
 *   unique, so no two entities can produce the same key — the ordering is a
 *   total order, and never "whatever order the array happened to be in".
 *
 * The largest magnitude this reaches is about `2^45`, well inside the range
 * where a float64 holds every integer exactly, so the arithmetic is a genuine
 * positional encoding rather than an approximate one.
 */
export function depthKey(entity: RenderEntity): number {
  if (!Number.isInteger(entity.id) || entity.id < 0 || entity.id >= DEPTH_ID_LIMIT) {
    throw new RangeError(`depthKey: entity id ${entity.id} is outside [0, ${DEPTH_ID_LIMIT}).`);
  }
  if (entity.layer < 0 || entity.layer >= RENDER_LAYER_COUNT) {
    throw new RangeError(`depthKey: layer ${entity.layer} is outside [0, ${RENDER_LAYER_COUNT}).`);
  }

  const nearestCorner = entity.x + entity.width - 1 + (entity.y + entity.height - 1);
  return nearestCorner * DEPTH_TILE_STRIDE + entity.layer * DEPTH_LAYER_STRIDE + entity.id;
}

/** Does an entity's footprint overlap an inclusive tile rectangle? */
export function overlapsBounds(entity: RenderEntity, bounds: TileBounds): boolean {
  return (
    entity.x <= bounds.maxX &&
    entity.x + entity.width - 1 >= bounds.minX &&
    entity.y <= bounds.maxY &&
    entity.y + entity.height - 1 >= bounds.minY
  );
}

export class EntityLayer {
  private readonly atlas: SpriteAtlas;

  /**
   * The visible subset, reused between frames.
   *
   * Rebuilt in place rather than reallocated: this runs every frame over every
   * entity, and §12's budget for a whole frame is 8 ms.
   */
  private readonly visible: RenderEntity[] = [];

  constructor(atlas: SpriteAtlas) {
    this.atlas = atlas;
  }

  /** How many entities were drawn last frame. For the debug readout. */
  get lastDrawn(): number {
    return this.visible.length;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    entities: readonly RenderEntity[],
    camera: Camera,
    bounds: TileBounds,
  ): void {
    this.visible.length = 0;
    for (const entity of entities) {
      if (overlapsBounds(entity, bounds)) this.visible.push(entity);
    }

    // Recomputing the key inside the comparator is O(n log n) key computations
    // rather than O(n). The alternative is a parallel key array and an index
    // sort, which is a real optimisation with a real cost in clarity — §16 says
    // that decision belongs to C28's profiler, not to this line.
    this.visible.sort((a, b) => depthKey(a) - depthKey(b));

    for (const entity of this.visible) {
      const anchor = camera.worldToScreen(entity.x + entity.width * 0.5, entity.y + entity.height * 0.5);
      this.atlas.draw(ctx, entity.sprite, anchor.x, anchor.y, camera.zoom);
    }
  }
}
