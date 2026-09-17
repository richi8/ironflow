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
 * belt:<rotation 0-3>[:<phase 0-7>]           belt:1:5
 * inserter:<rotation 0-3>:<swing 0-16>[:h]    inserter:2:8:h
 * item:<item id>                              item:iron_ore
 * player:<idle|walk|work>:<facing 0-3>        player:walk:1
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

/** The sprite for a belt facing each `Rotation`, indexed by it. Phase 0. */
export const BELT_SPRITES: readonly SpriteId[] = Object.freeze(['belt:0', 'belt:1', 'belt:2', 'belt:3']);

/**
 * How many chevron positions one belt animation cycle has. C13 task 8.
 *
 * The animation is a *discrete* phase baked into the sprite id rather than a
 * clock the atlas reads, because `SpriteAtlas.draw` takes no time and giving
 * it one would put a wall clock behind an interface whose whole purpose is
 * that C29 can swap the implementation. Eight steps at two tiles a second is
 * sixteen a second, which reads as motion; the phase is computed render-side
 * from elapsed wall time (§6: presentation may read the clock freely) in
 * `entity-view.ts`, and nothing in `game/` knows it exists.
 */
export const BELT_CHEVRON_PHASES = 8;

/** The sprite for a belt facing `rotation`, `phase` steps into its cycle. */
export function beltSprite(rotation: Rotation, phase = 0): SpriteId {
  return `belt:${rotation}:${phase}`;
}

/**
 * How many arm positions one inserter swing is quantised to. C14 task 7.
 *
 * The same arrangement as `BELT_CHEVRON_PHASES`, for the same reason: the
 * position is baked into the sprite id rather than read from a clock behind
 * `SpriteAtlas.draw`, so C29 can swap the implementation without the interface
 * growing a notion of time. Unlike the belt's it is not a *cycle* — it is a
 * sweep from one end to the other, so there are `STEPS + 1` positions and the
 * value is clamped rather than wrapped. Seventeen positions across a swing of
 * twelve ticks is finer than the simulation moves, which is exactly enough.
 */
export const INSERTER_SWING_STEPS = 16;

/**
 * The sprite for an inserter facing `rotation`, `swing` steps into its sweep.
 *
 * `swing` is `0` with the hand over the source and `INSERTER_SWING_STEPS` with
 * it over the destination. `holding` is whether there is an item in it — one
 * bit rather than the item's own id, because what it is holding is legible in
 * the inspector and an inserter holds it for under a second.
 */
export function inserterSprite(rotation: Rotation, swing: number, holding: boolean): SpriteId {
  return `inserter:${rotation}:${swing}${holding ? ':h' : ''}`;
}

/** The sprite for one item, riding a belt or sitting in a panel. */
export function itemSprite(itemId: string): SpriteId {
  return `item:${itemId}`;
}

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
  | { readonly kind: 'belt'; readonly rotation: Rotation; readonly phase: number }
  | {
      readonly kind: 'inserter';
      readonly rotation: Rotation;
      readonly swing: number;
      readonly holding: boolean;
    }
  | { readonly kind: 'item'; readonly fill: string; readonly flat: boolean }
  | { readonly kind: 'player'; readonly activity: PlayerActivity; readonly facing: Rotation }
  | { readonly kind: 'missing' };

/** The three states C10 task 6 asks for. Real animation is C29's. */
export type PlayerActivity = 'idle' | 'walk' | 'work';

const PLAYER_ACTIVITIES: readonly PlayerActivity[] = Object.freeze(['idle', 'walk', 'work']);

/** The sprite for a player in a given state, facing a given way. */
export function playerSprite(activity: PlayerActivity, facing: Rotation): SpriteId {
  return `player:${activity}:${facing}`;
}

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

/** An item whose name does not match a palette token — C16's intermediates. */
const DEFAULT_ITEM_COLOR: ColorToken = 'text-muted';

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

  if (namespace === 'belt' && (parts.length === 2 || parts.length === 3)) {
    // Matched as text, not with `Number`: `Number('')` is 0, so `belt:` would
    // otherwise parse as a perfectly good north-facing belt.
    const text = parts[1] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    // The phase is optional so that a ghost — which has a rotation but no
    // animation — can name a belt without inventing a frame number.
    const phaseText = parts[2] ?? '0';
    if (!/^\d+$/.test(phaseText)) return MISSING;
    return Object.freeze({
      kind: 'belt' as const,
      rotation: Number(text) as Rotation,
      phase: Number(phaseText) % BELT_CHEVRON_PHASES,
    });
  }

  if (namespace === 'inserter' && (parts.length === 3 || parts.length === 4)) {
    // Matched as text for the reason the belt rotation is: `Number('')` is 0,
    // so `inserter::` would otherwise parse as a north-facing arm at rest.
    const text = parts[1] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    const swingText = parts[2] ?? '';
    if (!/^\d+$/.test(swingText)) return MISSING;
    // Clamped rather than wrapped: a swing is a sweep with two ends, and an
    // arm that wrapped past the destination would snap back to the source.
    const holding = parts[3];
    if (holding !== undefined && holding !== 'h') return MISSING;
    return Object.freeze({
      kind: 'inserter' as const,
      rotation: Number(text) as Rotation,
      swing: Math.min(Number(swingText), INSERTER_SWING_STEPS),
      holding: holding === 'h',
    });
  }

  if (namespace === 'item' && parts.length === 2) {
    const itemId = parts[1] ?? '';
    if (itemId.length === 0) return MISSING;
    // An item's colour is the colour of the thing it came out of the ground
    // as: `iron_ore` and `iron_plate` are both `--if-iron`, and C16's
    // `copper_wire` is `--if-copper`, which is what makes a belt of one metal
    // read as one line whatever stage it is at. C29 replaces this with real
    // icons; until then a plate is the same colour drawn flat, because a flat
    // sheet is what a plate is.
    const flat = itemId.endsWith('_plate');
    const token = itemId.replace(/_(ore|plate|wire)$/, '');
    return Object.freeze({
      kind: 'item' as const,
      fill: color(isColorToken(token) ? token : DEFAULT_ITEM_COLOR),
      flat,
    });
  }

  if (namespace === 'player' && parts.length === 3) {
    const activity = parts[1] ?? '';
    if (!isPlayerActivity(activity)) return MISSING;
    // Matched as text for the same reason the belt rotation is: `Number('')`
    // is 0, and a facing of "north" is not the right answer to a typo.
    const text = parts[2] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    return Object.freeze({ kind: 'player' as const, activity, facing: Number(text) as Rotation });
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

function isPlayerActivity(value: string): value is PlayerActivity {
  return (PLAYER_ACTIVITIES as readonly string[]).includes(value);
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
        drawBelt(ctx, sx, sy, zoom, sprite.rotation, sprite.phase);
        return;
      case 'inserter':
        drawInserter(ctx, sx, sy, zoom, sprite.rotation, sprite.swing, sprite.holding);
        return;
      case 'item':
        drawItem(ctx, sx, sy, zoom, sprite.fill, sprite.flat);
        return;
      case 'player':
        drawPlayer(ctx, sx, sy, zoom, sprite.activity, sprite.facing);
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

/** Chevrons drawn per belt tile, and how far apart they sit, in tile fractions. */
const CHEVRON_COUNT = 3;
const CHEVRON_SPACING = 0.28;

/** Where the hindmost chevron starts, and how long its arms are. */
const CHEVRON_ORIGIN = -0.52;
const CHEVRON_HEAD = 0.2;
const CHEVRON_HALF_WIDTH = 0.22;

/**
 * A belt: a flat plate with chevrons sliding along it the way items do.
 *
 * `phase` slides the whole row forward by one spacing over a full cycle, and
 * the row is one chevron longer than it needs to be so the pattern is
 * continuous rather than a shape that reappears at the back edge. It is
 * render-side time and nothing else — no simulation state reaches this file,
 * and an item's *actual* position is drawn separately, on top (§6).
 */
function drawBelt(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  rotation: Rotation,
  phase: number,
): void {
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

  const slide = (phase / BELT_CHEVRON_PHASES) * CHEVRON_SPACING;
  for (let i = 0; i < CHEVRON_COUNT; i++) {
    const along = CHEVRON_ORIGIN + i * CHEVRON_SPACING + slide;
    ctx.beginPath();
    ctx.moveTo(sx + fx * along - gx * CHEVRON_HALF_WIDTH, sy + fy * along - gy * CHEVRON_HALF_WIDTH);
    ctx.lineTo(sx + fx * (along + CHEVRON_HEAD), sy + fy * (along + CHEVRON_HEAD));
    ctx.lineTo(sx + fx * along + gx * CHEVRON_HALF_WIDTH, sy + fy * along + gy * CHEVRON_HALF_WIDTH);
    ctx.stroke();
  }
}

/** The inserter's base, as a fraction of a tile and in rise units. */
const INSERTER_BASE_SIZE = 0.46;
const INSERTER_BASE_RISE = 0.2;

/** How far the hand reaches from the base, in tiles, at each end of the sweep. */
const INSERTER_ARM_REACH = 0.52;

/** How high the arm arcs at the middle of the sweep, in rise units. */
const INSERTER_ARM_LIFT = 0.5;

/** The hand, and the item in it, as a fraction of a tile. */
const INSERTER_HAND_SIZE = 0.2;

/**
 * An inserter: a squat base with one arm sweeping over it.
 *
 * The sweep is an **arc**, not a slide. Interpolating the hand's position
 * linearly from the source tile to the destination tile would take it through
 * the base at the halfway point, where the two offsets cancel — so the arm
 * would vanish into itself every cycle. Sweeping through a half turn instead
 * (`cos` along the facing axis, `sin` upward) puts the hand over the source at
 * one end, over the destination at the other, and raised above the machine in
 * between, which is both what an inserter does and the only shape that reads
 * at a glance in isometric.
 *
 * The rotation is the *facing*, which is the destination side: `swing` 0 is
 * therefore behind the base and `INSERTER_SWING_STEPS` is in front of it.
 */
function drawInserter(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  rotation: Rotation,
  swing: number,
  holding: boolean,
): void {
  const fill = color('blue');
  drawPrism(ctx, sx, sy, zoom, {
    fill,
    code: '',
    width: INSERTER_BASE_SIZE,
    height: INSERTER_BASE_SIZE,
    rise: INSERTER_BASE_RISE,
  });

  const forward = DIRECTION_OFFSETS[rotation];
  if (forward === undefined) return;
  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;

  // π at the source end, 0 at the destination end.
  const angle = Math.PI * (1 - swing / INSERTER_SWING_STEPS);
  const along = Math.cos(angle) * INSERTER_ARM_REACH;
  const shoulderY = sy - INSERTER_BASE_RISE * RISE_UNIT * zoom;
  const handX = sx + fx * along;
  const handY = shoulderY + fy * along - Math.sin(angle) * INSERTER_ARM_LIFT * RISE_UNIT * zoom;

  ctx.beginPath();
  ctx.moveTo(sx, shoulderY);
  ctx.lineTo(handX, handY);
  ctx.strokeStyle = color(holding ? 'accent' : 'blue-high');
  ctx.lineWidth = Math.max(1, 2 * zoom);
  ctx.lineCap = 'round';
  ctx.stroke();

  // The hand itself, so the end of the arm is a thing rather than a stop. It
  // takes the cargo colour when full, which is what makes a working inserter
  // readable from across the factory without reading the item.
  groundFacePath(ctx, handX, handY, INSERTER_HAND_SIZE, INSERTER_HAND_SIZE, zoom);
  ctx.fillStyle = shade(color(holding ? 'accent-high' : 'blue-high'), TOP_TONE);
  ctx.fill();
  ctx.strokeStyle = shade(fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** How much of a tile one item covers. Four of these fit along a tile (§9). */
export const ITEM_TILE_SIZE = 0.3;

/** How far an item floats above the belt under it, in rise units. */
const ITEM_RISE = 0.12;

/** A plate lies flat; a lump of ore sits proud of the belt. */
const PLATE_RISE = 0.04;

/**
 * One item: a small diamond sitting on whatever it is riding.
 *
 * Deliberately not a prism. An item is drawn four to a tile and there may be
 * thousands on screen at once (§12), so it is two paths rather than seven, and
 * the shading that tells a lump of ore from a plate is a lift and a tone
 * rather than a pair of extra faces.
 */
function drawItem(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  fill: string,
  flat: boolean,
): void {
  const lift = (flat ? PLATE_RISE : ITEM_RISE) * RISE_UNIT * zoom;

  // A shadow on the surface below, so an item reads as being *on* the belt
  // rather than as a stain in it.
  groundFacePath(ctx, sx, sy, ITEM_TILE_SIZE, ITEM_TILE_SIZE, zoom);
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * 0.4;
  ctx.fillStyle = color('bg-deep');
  ctx.fill();
  ctx.globalAlpha = previousAlpha;

  groundFacePath(ctx, sx, sy - lift, ITEM_TILE_SIZE, ITEM_TILE_SIZE, zoom);
  ctx.fillStyle = shade(fill, flat ? TOP_TONE : LUMP_TOP_TONE);
  ctx.fill();
  ctx.strokeStyle = shade(fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** How tall the placeholder figure stands, in rise units. Shorter than a chest. */
const PLAYER_RISE = 0.75;

/** Half the width of the figure's body, as a fraction of a tile. */
const PLAYER_HALF_WIDTH = 0.17;

/** Colour per activity, so "walking" and "mining" are told apart at a glance. */
const PLAYER_TONE: Readonly<Record<PlayerActivity, ColorToken>> = Object.freeze({
  idle: 'blue-high',
  walk: 'accent-high',
  work: 'warn',
});

/**
 * The player: a shadow, a body, a head and a nose pointing where they face.
 *
 * §11's placeholder-first pipeline in its purest form — C10 task 6 asks for
 * three states from the reference sheet and says in as many words that real
 * animation is C29's. What this has to get right is only what the *mechanics*
 * need to be verifiable by eye: which way the player is facing, whether they
 * are working, and where their feet are, because that last one is what the
 * build-range circle is drawn around.
 */
function drawPlayer(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  activity: PlayerActivity,
  facing: Rotation,
): void {
  const fill = color(PLAYER_TONE[activity]);
  const outline = shade(fill, OUTLINE_TONE);

  // A shadow on the ground, so the figure reads as standing on a tile rather
  // than floating over the one behind it.
  groundFacePath(ctx, sx, sy, 0.42, 0.42, zoom);
  ctx.fillStyle = color('bg-deep');
  ctx.globalAlpha *= 0.45;
  ctx.fill();
  ctx.globalAlpha /= 0.45;

  const lift = PLAYER_RISE * RISE_UNIT * zoom;
  const half = PLAYER_HALF_WIDTH * TILE_HALF_WIDTH * zoom;
  // Mining crouches: the same figure, shorter, which reads at any zoom and
  // needs no second sprite.
  const height = activity === 'work' ? lift * 0.72 : lift;

  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';

  quad(
    ctx,
    { x: sx - half, y: sy },
    { x: sx + half, y: sy },
    { x: sx + half, y: sy - height },
    { x: sx - half, y: sy - height },
  );
  paint(ctx, fill, outline);

  const headRadius = half * 1.15;
  ctx.beginPath();
  ctx.ellipse(sx, sy - height - headRadius * 0.7, headRadius, headRadius * 0.85, 0, 0, Math.PI * 2);
  ctx.fillStyle = shade(fill, TOP_TONE);
  ctx.fill();
  ctx.strokeStyle = outline;
  ctx.stroke();

  // Which way they are looking, in tile space, projected the same way
  // everything else is — so "north" points wherever north points on screen.
  const forward = DIRECTION_OFFSETS[facing];
  if (forward === undefined) return;
  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom * 0.42;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom * 0.42;

  ctx.beginPath();
  ctx.moveTo(sx, sy - height * 0.55);
  ctx.lineTo(sx + fx, sy - height * 0.55 + fy);
  ctx.strokeStyle = color('text');
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.lineCap = 'round';
  ctx.stroke();
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
