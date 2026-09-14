/**
 * Hover, ghost and selection. See ironflow.md C03 task 5 and §5 hazard 1.
 *
 * Everything here is drawn **after** the entity layer, unconditionally and
 * without depth sorting. That is not laziness: a three-tile power plant
 * correctly occludes the tiles behind it, so a hover highlight or a placement
 * ghost sorted into the same order would disappear behind the very building
 * the player is trying to place next to. §5 says draw both in the overlay
 * layer, after everything, and this is that layer.
 */

import type { TileCoord } from '../../game/world/coordinates.js';
import type { Camera } from '../camera.js';
import { color } from '../palette.js';
import type { GhostView, PlayerRenderView, RenderState } from '../render-state.js';
import { TILE_HALF_WIDTH, groundFacePath, type SpriteAtlas } from '../sprite-atlas.js';

/** Restores a solid stroke after the dashed range circle. */
const EMPTY_DASH: number[] = [];

/** Outline weight in CSS pixels at zoom 1; scaled up, never below hairline. */
const OUTLINE_WIDTH = 1.5;

/** How transparent a ghost's sprite is under its tint. */
const GHOST_SPRITE_ALPHA = 0.55;

/**
 * Straight segments used to draw a tile-space circle.
 *
 * The range circle is a circle **in tile space**, which is an ellipse on
 * screen. It is drawn by projecting points around it rather than by asking the
 * context for an ellipse, because the ellipse's axes and rotation are a
 * property of the projection and §5 keeps that in one file. Forty-eight
 * segments is under a pixel of chord error at the zoom where the circle is
 * biggest.
 */
const RANGE_SEGMENTS = 48;

/** How solid the build-range circle's fill is. Soft, per C10 task 5. */
const RANGE_FILL_ALPHA = 0.07;

/** Radius of the mining progress ring, in world pixels at zoom 1. */
const MINING_RING_RADIUS = TILE_HALF_WIDTH * 0.42;

/** Stroke weight of the progress ring, in CSS pixels at zoom 1. */
const MINING_RING_WIDTH = 4;

export class OverlayLayer {
  private readonly atlas: SpriteAtlas;

  constructor(atlas: SpriteAtlas) {
    this.atlas = atlas;
  }

  draw(ctx: CanvasRenderingContext2D, state: RenderState, camera: Camera): void {
    // Build range first, so everything else sits on top of the wash rather
    // than under it. C10 task 5 asks for it "while a building is selected",
    // and a ghost is exactly the state of holding one over the world.
    if (state.player !== null && state.ghost !== null) {
      this.drawBuildRange(ctx, camera, state.player);
    }
    if (state.player?.mining != null) {
      this.drawMiningProgress(ctx, camera, state.player.mining);
    }
    if (state.selected !== null) {
      this.outline(ctx, camera, state.selected, 1, 1, color('accent-high'));
    }
    if (state.hover !== null) {
      this.outline(ctx, camera, state.hover, 1, 1, color('accent'));
    }
    if (state.ghost !== null) {
      this.drawGhost(ctx, camera, state.ghost);
    }
  }

  /**
   * The soft circle showing how far the player can build (C10 task 5).
   *
   * Drawn around the player rather than around the cursor, because the rule it
   * shows is about where the player is standing — that is the thing the player
   * has to move to change, and the thing the range makes them move.
   */
  private drawBuildRange(ctx: CanvasRenderingContext2D, camera: Camera, player: PlayerRenderView): void {
    ctx.beginPath();
    for (let i = 0; i <= RANGE_SEGMENTS; i++) {
      const angle = (i / RANGE_SEGMENTS) * Math.PI * 2;
      const point = camera.worldToScreen(
        player.x + Math.cos(angle) * player.buildRange,
        player.y + Math.sin(angle) * player.buildRange,
      );
      if (i === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    }
    ctx.closePath();

    const previousAlpha = ctx.globalAlpha;
    ctx.globalAlpha = previousAlpha * RANGE_FILL_ALPHA;
    ctx.fillStyle = color('accent-high');
    ctx.fill();
    ctx.globalAlpha = previousAlpha;

    ctx.strokeStyle = color('accent-dim');
    ctx.lineWidth = Math.max(1, OUTLINE_WIDTH * camera.zoom);
    ctx.setLineDash([6 * camera.zoom, 6 * camera.zoom]);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
  }

  /**
   * The progress ring over the tile being mined (C10 task 4).
   *
   * A ring in **screen space**, not a tile-space arc: it is a readout, and a
   * readout that foreshortens into a thin sliver when it sits on a tile is one
   * the player cannot read. It is anchored on the projected tile centre, which
   * is the only part of it the projection has any say over.
   */
  private drawMiningProgress(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    mining: NonNullable<PlayerRenderView['mining']>,
  ): void {
    const centre = camera.worldToScreen(mining.x + 0.5, mining.y + 0.5);
    const radius = MINING_RING_RADIUS * camera.zoom;
    const width = Math.max(2, MINING_RING_WIDTH * camera.zoom);
    // Clamped, because a ring that overshoots by a rounding error draws a
    // second lap over the first and flickers.
    const progress = Math.min(1, Math.max(0, mining.progress));

    ctx.lineWidth = width;
    ctx.lineCap = 'butt';

    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = color('bg-deep');
    ctx.stroke();

    // From twelve o'clock, clockwise: the direction every progress dial in the
    // genre turns, and the one a player reads without being told.
    const start = 0 - Math.PI / 2;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, radius, start, start + progress * Math.PI * 2);
    ctx.strokeStyle = color('accent-high');
    ctx.stroke();
  }

  private outline(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    tile: TileCoord,
    width: number,
    height: number,
    stroke: string,
  ): void {
    const anchor = camera.worldToScreen(tile.x + width * 0.5, tile.y + height * 0.5);
    groundFacePath(ctx, anchor.x, anchor.y, width, height, camera.zoom);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, OUTLINE_WIDTH * camera.zoom);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /**
   * The placement preview: the real sprite at reduced opacity, then a tinted
   * footprint over it so validity reads at a glance without having to find the
   * outline among the machinery behind it.
   */
  private drawGhost(ctx: CanvasRenderingContext2D, camera: Camera, ghost: GhostView): void {
    const anchor = camera.worldToScreen(ghost.x + ghost.width * 0.5, ghost.y + ghost.height * 0.5);

    const previousAlpha = ctx.globalAlpha;
    ctx.globalAlpha = previousAlpha * GHOST_SPRITE_ALPHA;
    this.atlas.draw(ctx, ghost.sprite, anchor.x, anchor.y, camera.zoom);
    ctx.globalAlpha = previousAlpha;

    groundFacePath(ctx, anchor.x, anchor.y, ghost.width, ghost.height, camera.zoom);
    ctx.fillStyle = ghost.valid ? color('ghost-valid') : color('ghost-invalid');
    ctx.fill();
    ctx.strokeStyle = ghost.valid ? color('ok') : color('danger');
    ctx.lineWidth = Math.max(1, OUTLINE_WIDTH * camera.zoom);
    ctx.stroke();
  }
}
