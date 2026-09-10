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
import type { GhostView, RenderState } from '../render-state.js';
import { groundFacePath, type SpriteAtlas } from '../sprite-atlas.js';

/** Outline weight in CSS pixels at zoom 1; scaled up, never below hairline. */
const OUTLINE_WIDTH = 1.5;

/** How transparent a ghost's sprite is under its tint. */
const GHOST_SPRITE_ALPHA = 0.55;

export class OverlayLayer {
  private readonly atlas: SpriteAtlas;

  constructor(atlas: SpriteAtlas) {
    this.atlas = atlas;
  }

  draw(ctx: CanvasRenderingContext2D, state: RenderState, camera: Camera): void {
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
