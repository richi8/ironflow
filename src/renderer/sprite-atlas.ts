/**
 * The sprite atlas and its procedural implementation. See ironflow.md C03
 * task 3 and §11.
 *
 * `SpriteAtlas` is the second of the two abstractions §19 rule 10 sanctions.
 * It exists so that C29 can swap procedurally drawn placeholders for an
 * image-backed atlas **without the layers changing a line**: they name a
 * sprite and an anchor, and something else decides what that looks like.
 *
 * ## Sprite ids
 *
 * A `SpriteId` is a namespaced string. Later chunks invent ids freely — there
 * is no registry to update — and C29 maps the same strings to atlas cells.
 *
 * ```text
 * terrain:<name>                              terrain:grass
 * belt:<rotation 0-3>                         belt:1
 * building:<category>:<CODE>[:<w>x<h>[:<rise>]]
 *                                             building:extraction:MI
 *                                             building:power:PP:2x2:3
 * ```
 *
 * `<CODE>` is the two-letter code §11 asks for, `<w>x<h>` the footprint in
 * tiles (default `1x1`) and `<rise>` the height in tile-heights (default `1`).
 * An id that parses into none of these draws a magenta marker rather than
 * throwing: a missing sprite is a content bug, and a content bug that takes the
 * frame down is worse than one you can see.
 *
 * ## Geometry
 *
 * This file needs to know how big a tile is on screen, which §5 says only
 * `projection.ts` may know. It therefore asks, rather than restating: the
 * projection is linear, so `tileToScreen(1, 0)` and `tileToScreen(0, 1)` *are*
 * its entire geometry, and every measurement below is built from those two
 * vectors. Copying the constants instead would put a second copy of the tile
 * dimensions in the codebase, which is the thing §5 exists to prevent.
 */

import { DIRECTION_OFFSETS, type Rotation } from '../game/world/coordinates.js';
import { TILE_TYPE_COUNT, type TileType, tileProperties } from '../game/world/tile.js';

import { FONT_STACK, PALETTE, color, shade, type ColorToken } from './palette.js';
import { tileToScreen } from './projection.js';

/** Names a drawable. See the grammar above. */
export type SpriteId = string;

export interface SpriteAtlas {
  /**
   * Draw `id` with its ground footprint centred on `(sx, sy)`, scaled by `zoom`.
   *
   * The anchor is the centre of the footprint's ground face, which for a
   * multi-tile building is the projected centre of the whole footprint (§5).
   * Anything with height grows upward from there.
   */
  draw(ctx: CanvasRenderingContext2D, id: SpriteId, sx: number, sy: number, zoom: number): void;
  readonly kind: 'procedural' | 'image';
}

/* -------------------------------------------------------------------------- *
 * Geometry, derived from the projection rather than restated.
 * -------------------------------------------------------------------------- */

/** Screen displacement of one tile step east, at zoom 1. */
const EAST_STEP = tileToScreen(1, 0);

/** Screen displacement of one tile step south, at zoom 1. */
const SOUTH_STEP = tileToScreen(0, 1);

/** Half the width of one tile's ground face, in world pixels at zoom 1. */
export const TILE_HALF_WIDTH = EAST_STEP.x;

/** Half the height of one tile's ground face, in world pixels at zoom 1. */
export const TILE_HALF_HEIGHT = EAST_STEP.y;

/**
 * How far one unit of `<rise>` lifts a sprite, in world pixels at zoom 1.
 *
 * One tile-height, so a `rise` of 3 on a power plant is about as tall as three
 * tiles are deep — the proportion the reference sheet's buildings use.
 */
const RISE_UNIT = TILE_HALF_HEIGHT * 2;

/**
 * Trace the ground face of a `width` x `height` footprint centred on `(sx, sy)`.
 *
 * Exported because the overlay layer outlines tiles with it: hover, selection
 * and the ghost all need the same shape, and a second copy of these four
 * vertices would be a second thing to get wrong.
 */
export function groundFacePath(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  width: number,
  height: number,
  zoom: number,
): void {
  const ax = EAST_STEP.x * zoom * width * 0.5;
  const ay = EAST_STEP.y * zoom * width * 0.5;
  const bx = SOUTH_STEP.x * zoom * height * 0.5;
  const by = SOUTH_STEP.y * zoom * height * 0.5;

  ctx.beginPath();
  ctx.moveTo(sx - ax - bx, sy - ay - by); // north corner
  ctx.lineTo(sx + ax - bx, sy + ay - by); // east
  ctx.lineTo(sx + ax + bx, sy + ay + by); // south
  ctx.lineTo(sx - ax + bx, sy - ay + by); // west
  ctx.closePath();
}

/* -------------------------------------------------------------------------- *
 * Sprite ids
 * -------------------------------------------------------------------------- */

/**
 * The sprite for each `TileType`, indexed by it.
 *
 * Built from `tileProperties` rather than written out, so a terrain type added
 * in C19 cannot acquire a sprite id that disagrees with its name. The same name
 * is the enum member, the palette token and the sprite id — one word, three
 * uses, no translation table.
 */
export const TERRAIN_SPRITES: readonly SpriteId[] = Object.freeze(
  Array.from({ length: TILE_TYPE_COUNT }, (_unused, type) => `terrain:${tileProperties(type).name}`),
);

/** The sprite for a belt facing each `Rotation`, indexed by it. */
export const BELT_SPRITES: readonly SpriteId[] = Object.freeze(['belt:0', 'belt:1', 'belt:2', 'belt:3']);

/** The sprite for a terrain type. Falls back to the missing marker. */
export function terrainSprite(type: TileType): SpriteId {
  return TERRAIN_SPRITES[type] ?? MISSING_SPRITE;
}

/** The id that draws the "no such sprite" marker. */
export const MISSING_SPRITE: SpriteId = 'missing';

/* -------------------------------------------------------------------------- *
 * Parsing
 * -------------------------------------------------------------------------- */

/** A parsed sprite id: what the procedural atlas actually draws. */
export type SpriteDescriptor =
  | { readonly kind: 'face'; readonly fill: string }
  | {
      readonly kind: 'prism';
      readonly fill: string;
      readonly code: string;
      readonly width: number;
      readonly height: number;
      readonly rise: number;
    }
  | { readonly kind: 'belt'; readonly rotation: Rotation }
  | { readonly kind: 'missing' };

const MISSING: SpriteDescriptor = Object.freeze({ kind: 'missing' });

/**
 * Placeholder colour per building category, per §11's "category colour".
 *
 * Orange is action and energy, blue is structure, so extraction and power take
 * the warm end and the things that merely move or hold take the cool end.
 * Categories are C06's to define; an unknown one is not an error, it is a
 * building whose category has not been coloured yet.
 */
const CATEGORY_COLORS: Readonly<Record<string, ColorToken>> = Object.freeze({
  extraction: 'accent',
  production: 'accent-high',
  logistics: 'blue',
  storage: 'text-muted',
  power: 'warn',
  research: 'ok',
});

const DEFAULT_CATEGORY_COLOR: ColorToken = 'panel-high';

/**
 * Resolve a sprite id, memoised.
 *
 * The parse is a handful of `split`s, but it sits on a path that runs once per
 * drawn thing per frame, and a factory screen asks for the same twenty ids
 * every time. Memoising turns it into one `Map` hit. The cache is unbounded
 * because the id space is: it is the set of building types in the game, which
 * is content, not player data.
 */
const descriptorCache = new Map<SpriteId, SpriteDescriptor>();

export function describeSprite(id: SpriteId): SpriteDescriptor {
  const cached = descriptorCache.get(id);
  if (cached !== undefined) return cached;

  const parsed = parseSpriteId(id);
  descriptorCache.set(id, parsed);
  return parsed;
}

function parseSpriteId(id: SpriteId): SpriteDescriptor {
  const parts = id.split(':');
  const namespace = parts[0];

  if (namespace === 'terrain' && parts.length === 2) {
    const token = `terrain-${parts[1] ?? ''}`;
    if (!isColorToken(token)) return MISSING;
    return Object.freeze({ kind: 'face' as const, fill: color(token) });
  }

  if (namespace === 'belt' && parts.length === 2) {
    // Matched as text, not with `Number`: `Number('')` is 0, so `belt:` would
    // otherwise parse as a perfectly good north-facing belt.
    const text = parts[1] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    return Object.freeze({ kind: 'belt' as const, rotation: Number(text) as Rotation });
  }

  if (namespace === 'building' && parts.length >= 3 && parts.length <= 5) {
    const category = parts[1] ?? '';
    const code = (parts[2] ?? '').slice(0, 2).toUpperCase();
    // An *unknown* category is content that has not been coloured yet and
    // draws fine. An *empty* one is a malformed id, and drawing it in the
    // fallback colour would hide the typo that produced it.
    if (category.length === 0 || code.length === 0) return MISSING;

    const footprint = parseFootprint(parts[3]);
    if (footprint === null) return MISSING;

    const rise = parts[4] === undefined ? 1 : Number(parts[4]);
    if (!Number.isFinite(rise) || rise <= 0) return MISSING;

    return Object.freeze({
      kind: 'prism' as const,
      fill: color(CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLOR),
      code,
      width: footprint.width,
      height: footprint.height,
      rise,
    });
  }

  return MISSING;
}

function parseFootprint(text: string | undefined): { width: number; height: number } | null {
  if (text === undefined) return { width: 1, height: 1 };

  const [w, h] = text.split('x');
  const width = Number(w);
  const height = Number(h);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  return { width, height };
}

function isColorToken(token: string): token is ColorToken {
  return Object.prototype.hasOwnProperty.call(PALETTE, token);
}

/* -------------------------------------------------------------------------- *
 * The procedural atlas
 * -------------------------------------------------------------------------- */

/** Face shading: the three sides of a prism, lit from the north-east. */
const TOP_TONE = 1;
const LEFT_TONE = 0.62;
const RIGHT_TONE = 0.82;
const OUTLINE_TONE = 0.4;

/** Below this many pixels a two-letter code is a smudge, so it is skipped. */
const MIN_LABEL_PX = 7;

/**
 * Everything drawn by code, no image assets. See §11's placeholder-first
 * pipeline: this is the implementation C29 replaces, and the only reason the
 * game is playable before there is any art at all.
 */
export class ProceduralAtlas implements SpriteAtlas {
  readonly kind = 'procedural' as const;

  draw(ctx: CanvasRenderingContext2D, id: SpriteId, sx: number, sy: number, zoom: number): void {
    const sprite = describeSprite(id);
    switch (sprite.kind) {
      case 'face':
        fillFace(ctx, sx, sy, 1, 1, zoom, sprite.fill);
        return;
      case 'prism':
        drawPrism(ctx, sx, sy, zoom, sprite);
        return;
      case 'belt':
        drawBelt(ctx, sx, sy, zoom, sprite.rotation);
        return;
      case 'missing':
        drawMissing(ctx, sx, sy, zoom);
        return;
    }
  }
}

/**
 * Fill a ground face, then overdraw its outline in the same colour.
 *
 * The stroke is not decoration. Two faces sharing an edge are each antialiased
 * against transparency along it, and the two half-covered pixels do not add up
 * to one opaque one — so a hairline of the background shows through every tile
 * boundary. Widening each face by half a line covers its neighbour's gap. This
 * is what makes "no seams at any zoom step" true.
 */
function fillFace(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  width: number,
  height: number,
  zoom: number,
  fill: string,
): void {
  groundFacePath(ctx, sx, sy, width, height, zoom);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = fill;
  ctx.lineWidth = 1;
  ctx.stroke();
}

interface Prism {
  readonly fill: string;
  readonly code: string;
  readonly width: number;
  readonly height: number;
  readonly rise: number;
}

function drawPrism(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number, prism: Prism): void {
  const ax = EAST_STEP.x * zoom * prism.width * 0.5;
  const ay = EAST_STEP.y * zoom * prism.width * 0.5;
  const bx = SOUTH_STEP.x * zoom * prism.height * 0.5;
  const by = SOUTH_STEP.y * zoom * prism.height * 0.5;
  const lift = prism.rise * RISE_UNIT * zoom;

  const north = { x: sx - ax - bx, y: sy - ay - by };
  const east = { x: sx + ax - bx, y: sy + ay - by };
  const south = { x: sx + ax + bx, y: sy + ay + by };
  const west = { x: sx - ax + bx, y: sy - ay + by };

  const outline = shade(prism.fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';

  // Walls first, top last: the top face overlaps both walls' upper edges, so
  // painting it afterwards is what makes the solid read as solid.
  quad(ctx, west, south, { x: south.x, y: south.y - lift }, { x: west.x, y: west.y - lift });
  paint(ctx, shade(prism.fill, LEFT_TONE), outline);

  quad(ctx, south, east, { x: east.x, y: east.y - lift }, { x: south.x, y: south.y - lift });
  paint(ctx, shade(prism.fill, RIGHT_TONE), outline);

  quad(
    ctx,
    { x: north.x, y: north.y - lift },
    { x: east.x, y: east.y - lift },
    { x: south.x, y: south.y - lift },
    { x: west.x, y: west.y - lift },
  );
  paint(ctx, shade(prism.fill, TOP_TONE), outline);

  drawCode(ctx, prism.code, sx, sy - lift, zoom * Math.min(prism.width, prism.height));
}

function drawBelt(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number, rotation: Rotation): void {
  fillFace(ctx, sx, sy, 1, 1, zoom, color('panel-high'));

  const forward = DIRECTION_OFFSETS[rotation];
  const sideways = DIRECTION_OFFSETS[(rotation + 1) % 4];
  if (forward === undefined || sideways === undefined) return;

  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;
  const gx = (sideways.x * EAST_STEP.x + sideways.y * SOUTH_STEP.x) * zoom;
  const gy = (sideways.x * EAST_STEP.y + sideways.y * SOUTH_STEP.y) * zoom;

  ctx.strokeStyle = color('accent');
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Two chevrons pointing the way items travel. Offsets are fractions of a
  // tile, so the belt reads the same at every zoom.
  for (const along of [-0.28, 0.04]) {
    ctx.beginPath();
    ctx.moveTo(sx + fx * along - gx * 0.26, sy + fy * along - gy * 0.26);
    ctx.lineTo(sx + fx * (along + 0.24), sy + fy * (along + 0.24));
    ctx.lineTo(sx + fx * along + gx * 0.26, sy + fy * along + gy * 0.26);
    ctx.stroke();
  }
}

function drawMissing(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number): void {
  fillFace(ctx, sx, sy, 1, 1, zoom, '#ff00ff');
  drawCode(ctx, '??', sx, sy, zoom);
}

function quad(
  ctx: CanvasRenderingContext2D,
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
  d: { x: number; y: number },
): void {
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

function paint(ctx: CanvasRenderingContext2D, fill: string, stroke: string): void {
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawCode(ctx: CanvasRenderingContext2D, code: string, sx: number, sy: number, scale: number): void {
  const size = Math.round(11 * scale);
  if (size < MIN_LABEL_PX) return;

  ctx.font = `${size}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color('bg-deep');
  ctx.fillText(code, sx, sy + Math.max(1, scale));
  ctx.fillStyle = color('text');
  ctx.fillText(code, sx, sy);
}
