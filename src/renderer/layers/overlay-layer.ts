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
import { FONT_STACK, color } from '../palette.js';
import type { GhostView, MachineAnnotation, PlayerRenderView, RenderState } from '../render-state.js';
import { TILE_HALF_HEIGHT, TILE_HALF_WIDTH, groundFacePath, type SpriteAtlas } from '../sprite-atlas.js';

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

/** Size of the ghost's ore-count label, in CSS pixels. Fixed: it is a readout. */
const GHOST_LABEL_SIZE = 12;

/** How far above the footprint's north corner the label sits, in CSS pixels. */
const GHOST_LABEL_OFFSET = 8;

/** Weight of the label's outline, which is what keeps it readable over ore. */
const GHOST_LABEL_OUTLINE = 3;

/** Radius of the mining progress ring, in world pixels at zoom 1. */
const MINING_RING_RADIUS = TILE_HALF_WIDTH * 0.42;

/** Stroke weight of the progress ring, in CSS pixels at zoom 1. */
const MINING_RING_WIDTH = 4;

/* -------------------------------------------------------------------------- *
 * Alt mode (C20 task 5). All fixed CSS pixels — see `drawAnnotation`.
 * -------------------------------------------------------------------------- */

/** Height of a badge's item icon, in CSS pixels. */
const BADGE_SIZE = 18;

/** Space between the icon and the count. */
const BADGE_GAP = 4;

/** Padding inside the badge's plate. */
const BADGE_PAD = 4;

/** How far above the footprint's north corner the badge sits. */
const BADGE_OFFSET = 6;

const BADGE_TEXT_SIZE = 11;

/** How solid the plate behind a badge is. Dark enough to read over ore. */
const BADGE_PLATE_ALPHA = 0.8;

/** A rounded rectangle, because `roundRect` is not in every target browser. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius = 3,
): void {
  const r = Math.min(radius, width * 0.5, height * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

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
      this.outline(
        ctx,
        camera,
        state.selected,
        state.selected.width,
        state.selected.height,
        color('accent-high'),
      );
    }
    if (state.hover !== null) {
      this.outline(ctx, camera, state.hover, 1, 1, color('accent'));
    }
    if (state.ghost !== null) {
      this.drawGhost(ctx, camera, state.ghost);
    }
    // Last, so a badge is never hidden by an outline or a ghost — the mode
    // exists to be read across the whole screen at once.
    for (const annotation of state.annotations) {
      this.drawAnnotation(ctx, camera, annotation);
    }
  }

  /**
   * One machine's "this is what I make" badge (C20 task 5).
   *
   * Drawn at a **fixed pixel size** above the middle of the footprint's top
   * edge, for the reason the mining ring and the ghost's ore count are: it is
   * a readout,
   * and the whole value of the mode is being able to read forty of them at
   * once at the zoom where forty machines fit on screen. A badge that
   * foreshortened with the tile would be unreadable exactly when it is
   * wanted.
   *
   * The item sprite is drawn at zoom 1 into a dark rounded plate, because the
   * colours it has to stay legible against are the terrain and the machines —
   * §11 gives no token for "over anything", and a plate is what the HUD's own
   * chips already do.
   */
  private drawAnnotation(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    annotation: MachineAnnotation,
  ): void {
    const centre = camera.worldToScreen(
      annotation.x + annotation.width * 0.5,
      annotation.y + annotation.height * 0.5,
    );
    const top = centre.y - annotation.height * TILE_HALF_HEIGHT * camera.zoom;
    const y = top - BADGE_OFFSET;

    const label = annotation.count === null ? '' : String(annotation.count);
    const textWidth = label === '' ? 0 : this.measureBadge(ctx, label);
    const width = BADGE_SIZE + (textWidth === 0 ? 0 : textWidth + BADGE_GAP);

    roundedRect(ctx, centre.x - width * 0.5 - BADGE_PAD, y - BADGE_SIZE, width + BADGE_PAD * 2, BADGE_SIZE + BADGE_PAD);
    ctx.fillStyle = color('bg-deep');
    const previousAlpha = ctx.globalAlpha;
    ctx.globalAlpha = previousAlpha * BADGE_PLATE_ALPHA;
    ctx.fill();
    ctx.globalAlpha = previousAlpha;
    ctx.strokeStyle = color('stroke');
    ctx.lineWidth = 1;
    ctx.stroke();

    // At zoom 1 whatever the camera is doing: see the header above.
    this.atlas.draw(ctx, annotation.sprite, centre.x - width * 0.5 + BADGE_SIZE * 0.5, y - BADGE_SIZE * 0.3, 1);

    if (label === '') return;
    ctx.font = `${BADGE_TEXT_SIZE}px ${FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color('text');
    ctx.fillText(label, centre.x - width * 0.5 + BADGE_SIZE + BADGE_GAP, y - BADGE_SIZE * 0.4);
  }

  private measureBadge(ctx: CanvasRenderingContext2D, label: string): number {
    ctx.font = `${BADGE_TEXT_SIZE}px ${FONT_STACK}`;
    return ctx.measureText(label).width;
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

    if (ghost.resourceTiles !== null) {
      this.drawResourceCount(ctx, camera, ghost, ghost.resourceTiles);
    }
  }

  /**
   * How many of the tiles under a miner actually have ore on them (C11 task 4).
   *
   * Drawn at a **fixed pixel size**, like the mining ring and for the same
   * reason: it is a readout rather than part of the world, and a number that
   * shrinks with the zoom is one the player cannot read at the moment they are
   * lining a miner up. It is anchored on the middle of the footprint's top
   * edge — asked of the camera rather than derived from the tile dimensions,
   * because §5 keeps the projection in one file.
   */
  private drawResourceCount(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    ghost: GhostView,
    covered: number,
  ): void {
    const north = camera.worldToScreen(ghost.x + ghost.width * 0.5, ghost.y);
    const text = `${covered}/${ghost.width * ghost.height} ore`;

    ctx.font = `${GHOST_LABEL_SIZE}px ${FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    // Outlined rather than boxed: a panel behind the text would hide the very
    // tiles being counted, which are directly under it.
    ctx.lineJoin = 'round';
    ctx.lineWidth = GHOST_LABEL_OUTLINE;
    ctx.strokeStyle = color('bg-deep');
    ctx.strokeText(text, north.x, north.y - GHOST_LABEL_OFFSET);

    ctx.fillStyle = covered > 0 ? color('accent-high') : color('danger');
    ctx.fillText(text, north.x, north.y - GHOST_LABEL_OFFSET);
  }
}
