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
 * resource:<name>:<fullness 0-3>              resource:iron:2
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
import {
  NO_BUCKET,
  RESOURCE_BUCKET_COUNT,
  RESOURCE_TYPE_COUNT,
  ResourceType,
  resourceBucket,
  resourceName,
} from '../game/world/resource.js';
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
export const RISE_UNIT = TILE_HALF_HEIGHT * 2;

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

/**
 * The sprite for each resource type at each fullness bucket, `[type][bucket]`.
 *
 * Built from `resourceName` for the reason `TERRAIN_SPRITES` is built from
 * `tileProperties`: the resource added in C19 gets a sprite id that cannot
 * disagree with its name, and the id it gets names the §11 palette token that
 * colours it.
 */
export const RESOURCE_SPRITES: readonly (readonly SpriteId[])[] = Object.freeze(
  Array.from({ length: RESOURCE_TYPE_COUNT }, (_unused, type) =>
    Object.freeze(
      Array.from({ length: RESOURCE_BUCKET_COUNT }, (_unusedBucket, bucket) =>
        // Row 0 is the *absence* of a resource, which has no picture. It is
        // filled with the marker rather than left as a hole so that a tile
        // carrying an amount but no type — a corrupt world chunk, or a save
        // read wrongly — draws magenta instead of being quietly absorbed.
        type === ResourceType.None ? MISSING_SPRITE : `resource:${resourceName(type)}:${bucket}`,
      ),
    ),
  ),
);

/**
 * What to draw on a resource tile, or `null` for nothing at all.
 *
 * Two tiles draw no ore: bare ground, and a patch mined out (C09 acceptance 2).
 * Returning `null` rather than an empty sprite keeps that decision here, where
 * the fullness scale already lives, instead of in every layer that draws a
 * tile.
 */
export function resourceSprite(type: ResourceType, amount: number): SpriteId | null {
  const bucket = resourceBucket(amount);
  if (bucket === NO_BUCKET) return null;
  return RESOURCE_SPRITES[type]?.[bucket] ?? MISSING_SPRITE;
}

/* -------------------------------------------------------------------------- *
 * Parsing
 * -------------------------------------------------------------------------- */

/** A parsed sprite id: what the procedural atlas actually draws. */
export type SpriteDescriptor =
  | { readonly kind: 'face'; readonly fill: string }
  | { readonly kind: 'resource'; readonly fill: string; readonly bucket: number }
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

  if (namespace === 'resource' && parts.length === 3) {
    // The resource's name *is* its palette token (`--if-iron`), which is why
    // there is no lookup table between the two — see `ResourceProperties.name`.
    const token = parts[1] ?? '';
    if (!isColorToken(token)) return MISSING;
    // Matched as text for the reason the belt rotation below is: `Number('')`
    // is 0, so `resource:iron:` would otherwise parse as an empty pile.
    const text = parts[2] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    return Object.freeze({ kind: 'resource' as const, fill: color(token), bucket: Number(text) });
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

/** Ground tint opacity per fullness bucket, thinnest first. */
const TINT_ALPHA: readonly number[] = Object.freeze([0.3, 0.45, 0.6, 0.78]);

/** An ore lump's footprint, as a fraction of a tile. */
const LUMP_SCALE = 0.3;

/** Below this many pixels wide, lumps are skipped and the tint carries alone. */
const MIN_LUMP_PX = 2;

/** Lumps are lighter than the tint so they read as objects sitting on it. */
const LUMP_TOP_TONE = 1.35;

/**
 * Where each lump sits, in tile fractions from the tile centre, back to front.
 *
 * Four positions for four buckets: a fuller tile shows more of them. They are
 * inside a ±0.3 tile box so a lump never crosses into the neighbouring tile —
 * ore is drawn into the terrain layer's per-world-chunk bitmap, whose edges are
 * the world chunk's own diamond, and anything overhanging would be clipped at
 * the seam.
 */
const LUMP_OFFSETS: readonly { readonly u: number; readonly v: number }[] = Object.freeze([
  Object.freeze({ u: -0.18, v: -0.2 }),
  Object.freeze({ u: 0.24, v: -0.1 }),
  Object.freeze({ u: -0.24, v: 0.16 }),
  Object.freeze({ u: 0.12, v: 0.26 }),
]);

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
      case 'resource':
        drawResource(ctx, sx, sy, zoom, sprite.fill, sprite.bucket);
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

/**
 * Ore on a tile: a tint over the ground, plus one lump per unit of fullness.
 *
 * Two readings of the same number, because C09 task 3 asks for a patch that is
 * legible "at a glance without a number" and the two carry at different zooms.
 * The tint survives to the far end of the zoom range, where a lump is a
 * fraction of a pixel and a patch has to read as a coloured region; the lumps
 * are what make a half-mined tile distinguishable from a full one when the
 * player is standing over it. Neither alone does both.
 *
 * The tint deepens with fullness rather than being constant, so a patch thins
 * visibly as it is worked even at the zoom where the lumps have vanished.
 */
function drawResource(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  fill: string,
  bucket: number,
): void {
  const alpha = TINT_ALPHA[bucket] ?? TINT_ALPHA[TINT_ALPHA.length - 1] ?? 1;

  // Saved and restored rather than reset to 1: this runs inside the terrain
  // layer's draw loop, and a layer that leaves the context changed is the kind
  // of bug that shows up three sprites later in something unrelated.
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * alpha;
  fillFace(ctx, sx, sy, 1, 1, zoom, fill);
  ctx.globalAlpha = previousAlpha;

  // Below a pixel or so a lump is a smudge that costs a path to draw. The tint
  // is still carrying the information at that size.
  const lumpSize = LUMP_SCALE * TILE_HALF_WIDTH * zoom;
  if (lumpSize < MIN_LUMP_PX) return;

  const top = shade(fill, LUMP_TOP_TONE);
  const outline = shade(fill, OUTLINE_TONE);

  // Back to front, so a lump nearer the viewer overlaps the one behind it. The
  // offsets are fractions of a tile, so the pile reads the same at every zoom,
  // and they are a fixed table rather than anything seeded — two tiles of the
  // same fullness must be the same picture (§6 is about the simulation, but a
  // renderer that invents per-tile noise makes a screenshot untestable too).
  for (let i = 0; i <= bucket; i++) {
    const lump = LUMP_OFFSETS[i];
    if (lump === undefined) continue;
    const lx = sx + (lump.u * EAST_STEP.x + lump.v * SOUTH_STEP.x) * zoom;
    const ly = sy + (lump.u * EAST_STEP.y + lump.v * SOUTH_STEP.y) * zoom;
    groundFacePath(ctx, lx, ly, LUMP_SCALE, LUMP_SCALE, zoom);
    ctx.fillStyle = top;
    ctx.fill();
    ctx.strokeStyle = outline;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
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
