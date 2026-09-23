/**
 * The depth-sorted entity layer. See ironflow.md C03 task 5, §5 and C27A.
 *
 * §18 risk 2 — "depth sorting breaks with tall multi-tile buildings" — is rated
 * high likelihood, and the mitigation named there is this file: an explicit
 * depth key with an entity-id tie-break, and overlays drawn afterwards.
 *
 * C27A took most of the risk away with the third dimension: nothing is drawn
 * standing up, so nothing occludes anything, and the sort decides only which
 * of two *overlapping* things — a shadow and its neighbour, two items sharing
 * a tile — is painted last. The key stayed, because "which of these is on top"
 * still has to have one deterministic answer and the picker still reads it.
 */

import type { TileBounds } from '../../game/world/coordinates.js';
import { NO_ENTITY } from '../../game/entities/entity.js';
import type { Camera } from '../camera.js';
import { RENDER_LAYER_COUNT, RenderLayer, type PlayerRenderView, type RenderEntity } from '../render-state.js';
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
 * The painter's-algorithm sort key from §5, on C27A's axis.
 *
 * ```text
 * depth = y * LARGE + layerBias * SMALL + entityId
 * ```
 *
 * Three properties, all of them load-bearing:
 *
 * - **`y` is the depth axis.** Further down the screen draws later, so it
 *   draws in front — which is what makes a machine's shadow fall *under* the
 *   machine south of it rather than over it. It was `x + y` until C27A,
 *   because that was the axis running away from an isometric camera; a
 *   top-down camera has no such axis, and screen rows are the honest answer.
 *   A multi-tile building uses its **southern** row, the edge nearest the
 *   bottom of the screen, for the same reason it used its maximum corner.
 * - **The layer bias orders things sharing a tile**, so an item never sinks
 *   into the belt carrying it.
 * - **The entity id breaks the remaining ties deterministically.** Ids are
 *   unique, so no two entities can produce the same key — the ordering is a
 *   total order, and never "whatever order the array happened to be in".
 *
 * The largest magnitude this reaches is about `2^45`, well inside the range
 * where a float64 holds every integer exactly, so the arithmetic is a genuine
 * positional encoding rather than an approximate one.
 *
 * The player (C10) goes through here with a **fractional** position, which is
 * fine: the key is arithmetic, not an index, so a player halfway between two
 * depth rows sorts halfway between them — which is exactly where they should
 * be drawn. Only the id has to be an integer, and the player uses `NO_ENTITY`,
 * a number the store never hands out.
 */
export function depthKey(entity: RenderEntity): number {
  if (!Number.isInteger(entity.id) || entity.id < 0 || entity.id >= DEPTH_ID_LIMIT) {
    throw new RangeError(`depthKey: entity id ${entity.id} is outside [0, ${DEPTH_ID_LIMIT}).`);
  }
  if (entity.layer < 0 || entity.layer >= RENDER_LAYER_COUNT) {
    throw new RangeError(`depthKey: layer ${entity.layer} is outside [0, ${RENDER_LAYER_COUNT}).`);
  }

  const row = entity.depthRow ?? entity.y + entity.height - 1;
  return row * DEPTH_TILE_STRIDE + entity.layer * DEPTH_LAYER_STRIDE + entity.id;
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

/**
 * The player as a drawable. A 1x1 footprint centred on where they stand.
 *
 * The anchor everything else uses is a footprint's north-west corner, and the
 * layer adds half the footprint back to find the centre; the player has a
 * position rather than a footprint, so half a tile comes off here to survive
 * that round trip. Doing it this way rather than special-casing the anchor in
 * `draw` keeps one anchoring rule in the renderer instead of two.
 */
function asDrawable(player: PlayerRenderView): RenderEntity {
  return {
    id: NO_ENTITY,
    x: player.x - 0.5,
    y: player.y - 0.5,
    width: 1,
    height: 1,
    sprite: player.sprite,
    layer: RenderLayer.Building,
  };
}

/** No items on screen. Shared and frozen: every test that draws a bare world. */
const NO_ITEMS: readonly RenderEntity[] = Object.freeze([]);

export class EntityLayer {
  private readonly atlas: SpriteAtlas;

  /**
   * The visible subset, reused between frames.
   *
   * Rebuilt in place rather than reallocated: this runs every frame over every
   * entity, and §12's budget for a whole frame is 8 ms.
   */
  private readonly visible: RenderEntity[] = [];

  /**
   * Each visible drawable's depth key, and the draw order as indexes into
   * `visible`. Grown, never shrunk, so a steady frame allocates nothing.
   */
  private keys = new Float64Array(1024);
  private order = new Uint32Array(1024);
  private readonly byKey = (a: number, b: number): number => (this.keys[a] ?? 0) - (this.keys[b] ?? 0) || a - b;

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
    player: PlayerRenderView | null = null,
    items: readonly RenderEntity[] = NO_ITEMS,
  ): void {
    this.visible.length = 0;
    for (const entity of entities) {
      if (overlapsBounds(entity, bounds)) this.visible.push(entity);
    }

    // Items on belts (C13) are sorted in with everything else rather than
    // drawn over it, so two items sharing a tile stack in flow order. They
    // arrive separately for the same reason the player does: this array is
    // also what the picker searches, and an item is not something the cursor
    // can hit — see `render-state.ts`.
    for (const item of items) {
      if (overlapsBounds(item, bounds)) this.visible.push(item);
    }

    // The player is sorted in with everything else rather than drawn over it,
    // so walking north of a miner puts that miner's shadow across their feet
    // — which is the whole reason §5 has a depth key. They arrive as a
    // separate argument instead of in `entities` because that array is also
    // what the picker searches, and the player is not something the cursor
    // should be able to hit — see `render-state.ts` on why.
    if (player !== null) {
      const drawable = asDrawable(player);
      if (overlapsBounds(drawable, bounds)) this.visible.push(drawable);
    }

    // Each key once, then an index sort over the keys (C29). Until C29 the
    // key was recomputed inside the comparator, O(n log n) times, which is
    // what this comment used to say belonged to the profiler to decide: at
    // the far zoom, with nineteen thousand drawables, it did. Ties — items,
    // which share `NO_ENTITY` — fall back to arrival order, which is what the
    // stable array sort gave them before.
    const count = this.visible.length;
    if (this.keys.length < count) {
      this.keys = new Float64Array(count * 2);
      this.order = new Uint32Array(count * 2);
    }
    for (let i = 0; i < count; i++) {
      this.keys[i] = depthKey(this.visible[i] as RenderEntity);
      this.order[i] = i;
    }
    const order = this.order.subarray(0, count).sort(this.byKey);

    for (let i = 0; i < count; i++) {
      const entity = this.visible[order[i] ?? 0] as RenderEntity;
      const anchor = camera.worldToScreen(entity.x + entity.width * 0.5, entity.y + entity.height * 0.5);
      this.atlas.draw(ctx, entity.sprite, anchor.x, anchor.y, camera.zoom);
    }
  }
}
