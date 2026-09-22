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
 * splitter:<rotation 0-3>[:<phase 0-7>]       splitter:1:5
 * inserter:<rotation 0-3>:<swing 0-16>[:h]    inserter:2:8:h
 * item:<item id>                              item:iron_ore
 * player:<idle|walk|work>:<facing 0-3>        player:walk:1
 * building:<category>:<CODE>[:<w>x<h>[:<rise>]]
 *                                             building:extraction:MI
 *                                             building:power:PP:2x2:3
 * ```
 *
 * `<CODE>` is the two-letter code §11 asks for, `<w>x<h>` the footprint in
 * tiles (default `1x1`) and `<rise>` its **bulk** (default `1`) — how heavy
 * the machine reads, which C27A turned from an extrusion height into the
 * length of its shadow. The grammar did not change when the projection did, so
 * `data/buildings.ts` did not either.
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
 *
 * That indirection is why C27A cost this file its drawing and not its
 * arithmetic: a belt's chevrons, a splitter's lanes, a tunnel mouth and an ore
 * lump are all written as tile fractions against those two vectors, so they
 * came out square the moment the vectors did. Only the things that faked a
 * third dimension — the extruded prism, the arm's vertical arc, an item's lift
 * — had to be redrawn.
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

/**
 * Half the width of one tile's ground face, in world pixels at zoom 1.
 *
 * Taken from each axis's own basis vector. Before C27A both came out of
 * `EAST_STEP`, because one step east moved half a tile width right and half a
 * tile height down — true of a 2:1 diamond and false of a square, where a step
 * east has no vertical component at all.
 */
export const TILE_HALF_WIDTH = EAST_STEP.x / 2;

/** Half the height of one tile's ground face, in world pixels at zoom 1. */
export const TILE_HALF_HEIGHT = SOUTH_STEP.y / 2;

/**
 * How far one unit of bulk lifts a sprite up the screen, in world pixels at
 * zoom 1. See C27B.
 *
 * The ground is drawn from directly above and entities are drawn from a camera
 * tilted down at them — which is not one consistent projection, and is exactly
 * what the genre does. A tile stays square, so a footprint stays a rectangle
 * and a screen direction stays a tile direction (C27A's whole point); a machine
 * standing on it shows its top and its near face, so it reads as a thing in the
 * world rather than as paint on the floor.
 *
 * Nine tenths of a tile at bulk 2 — the furnace, the miner — and one and a
 * third at bulk 3. Tall enough to see the face, short enough that a machine
 * hides little of the row behind it.
 */
export const RISE_UNIT = TILE_HALF_HEIGHT * 0.9;

/**
 * How far a shadow slides per pixel of lift.
 *
 * The light is high and to the north-west, so a shadow falls south-east and is
 * shorter than the thing casting it. One number for every sprite in the game:
 * two objects of the same height with different shadows read as being lit by
 * different suns, which is the kind of wrongness a player feels without being
 * able to name.
 */
const SHADOW_SLANT = 0.42;

const SHADOW_ALPHA = 0.28;

/**
 * Trace the ground face of a `width` x `height` footprint centred on `(sx, sy)`.
 *
 * Exported because the overlay layer outlines tiles with it: hover, selection
 * and the ghost all need the same shape, and a second copy of these four
 * vertices would be a second thing to get wrong.
 *
 * Still built from the two basis vectors rather than from `rect()`, although
 * the shape it traces is now an axis-aligned rectangle. The vectors are what
 * make it the *projection's* footprint instead of this file's opinion of one.
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
  ctx.moveTo(sx - ax - bx, sy - ay - by); // north-west
  ctx.lineTo(sx + ax - bx, sy + ay - by); // north-east
  ctx.lineTo(sx + ax + bx, sy + ay + by); // south-east
  ctx.lineTo(sx - ax + bx, sy - ay + by); // south-west
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
 * The sprite for a splitter facing `rotation`, on the same chevron cycle (C17).
 *
 * Its own namespace rather than a belt with a footprint, because what it draws
 * is not a wider belt: it is one plate with **two** lanes running through it,
 * and C17 task 4 asks for the lane to read as continuous across it. The
 * footprint is implied by the rotation — two tiles across the flow, one deep —
 * which is the same fact `data/buildings.ts` states and the registry enforces.
 */
/**
 * The sprite for one mouth of an underground run (C23).
 *
 * Two pictures rather than one, and it is the same argument C22 used to keep
 * the fast belt out of the game: two buildings on the map the player cannot
 * tell apart is worse than one building fewer. An entrance and an exit sit at
 * either end of a tunnel doing opposite things, and a player tracing a line
 * has to be able to see which way it goes without counting chevrons.
 */
export function undergroundSprite(rotation: Rotation, entrance: boolean): SpriteId {
  return `underground:${rotation}:${entrance ? 'in' : 'out'}`;
}

export function splitterSprite(rotation: Rotation, phase = 0): SpriteId {
  return `splitter:${rotation}:${phase}`;
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
      readonly kind: 'machine';
      readonly fill: string;
      readonly code: string;
      readonly width: number;
      readonly height: number;
      /** How heavy it reads: shadow length and inset depth. See the grammar. */
      readonly bulk: number;
    }
  | { readonly kind: 'belt'; readonly rotation: Rotation; readonly phase: number }
  | { readonly kind: 'splitter'; readonly rotation: Rotation; readonly phase: number }
  | {
      readonly kind: 'underground';
      readonly rotation: Rotation;
      /** True for the mouth items go into, false for the one they come out of. */
      readonly entrance: boolean;
    }
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
  // C23's radar. Cyan-ish blue rather than the structure blue the logistics
  // buildings take, because what it produces is information: it is nearer the
  // data core's colour than the belt's, which is the association worth making.
  exploration: 'blue-high',
});

const DEFAULT_CATEGORY_COLOR: ColorToken = 'panel-high';

/** An item whose name does not match a palette token — C16's intermediates. */
const DEFAULT_ITEM_COLOR: ColorToken = 'text-muted';

/**
 * How far the sprite `id` rises above its ground face, in world pixels at
 * zoom 1. Zero for anything flat.
 *
 * The overlay layer needs this and may not work it out: a badge floats above
 * the machine it labels, and since C27B the machine stands up. Asking the
 * *atlas* was considered and rejected in C03 — `SpriteAtlas` is the interface
 * C29 swaps wholesale, and a height query on it is a second thing the image
 * implementation would have to answer. A function beside the descriptor is
 * neither: it reads the id that is already the contract between the two.
 */
export function spriteLift(id: SpriteId): number {
  const sprite = describeSprite(id);
  return sprite.kind === 'machine' ? sprite.bulk * RISE_UNIT : 0;
}

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

  if ((namespace === 'belt' || namespace === 'splitter') && (parts.length === 2 || parts.length === 3)) {
    // Matched as text, not with `Number`: `Number('')` is 0, so `belt:` would
    // otherwise parse as a perfectly good north-facing belt.
    const text = parts[1] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    // The phase is optional so that a ghost — which has a rotation but no
    // animation — can name a belt without inventing a frame number.
    const phaseText = parts[2] ?? '0';
    if (!/^\d+$/.test(phaseText)) return MISSING;
    return Object.freeze({
      kind: namespace,
      rotation: Number(text) as Rotation,
      phase: Number(phaseText) % BELT_CHEVRON_PHASES,
    });
  }

  if (namespace === 'underground' && parts.length === 3) {
    // Matched as text for the belt rotation's reason: `Number('')` is 0, so
    // `underground::in` would otherwise parse as a north-facing entrance.
    const text = parts[1] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    const end = parts[2] ?? '';
    if (end !== 'in' && end !== 'out') return MISSING;
    return Object.freeze({
      kind: 'underground' as const,
      rotation: Number(text) as Rotation,
      entrance: end === 'in',
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

    const bulk = parts[4] === undefined ? 1 : Number(parts[4]);
    if (!Number.isFinite(bulk) || bulk <= 0) return MISSING;

    return Object.freeze({
      kind: 'machine' as const,
      fill: color(CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLOR),
      code,
      width: footprint.width,
      height: footprint.height,
      bulk,
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

/**
 * Plate shading, seen from directly above.
 *
 * A top-down machine has one face, so the three tones that used to be three
 * sides of a solid become three parts of one plate: the body, a machined inset
 * that catches more light, and an outline dark enough to separate two machines
 * standing flush against each other — which is the job the silhouette used to
 * do for free.
 */
const BODY_TONE = 1;
const INSET_TONE = 1.22;
/** The near face, turned away from the light and so darker than the top. */
const FACE_TONE = 0.66;
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
 * the world chunk's own footprint, and anything overhanging would be clipped at
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
      case 'machine':
        drawMachine(ctx, sx, sy, zoom, sprite);
        return;
      case 'belt':
        drawBelt(ctx, sx, sy, zoom, sprite.rotation, sprite.phase);
        return;
      case 'splitter':
        drawSplitter(ctx, sx, sy, zoom, sprite.rotation, sprite.phase);
        return;
      case 'underground':
        drawUnderground(ctx, sx, sy, zoom, sprite.rotation, sprite.entrance);
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

interface Machine {
  readonly fill: string;
  readonly code: string;
  readonly width: number;
  readonly height: number;
  readonly bulk: number;
}

/** How far a machine's inset panel sits inside its footprint, in tiles. */
const MACHINE_INSET = 0.16;

/**
 * A machine seen from above: a shadow, a plate, an inset panel and its code.
 *
 * The pre-C27A version of this drew an extruded solid — three shaded faces and
 * a lift — and that extrusion was doing two jobs at once. It said *this is a
 * building and not a floor tile*, and it said *this one is bigger than that
 * one*. Top-down has to say both without a third dimension, so the two jobs
 * are split: the shadow separates the machine from the ground it stands on,
 * and its length is what bulk now buys. The inset says "machined" — a plain
 * rectangle of category colour reads as a painted square of terrain.
 *
 * The inset is inset by a fixed fraction of a **tile**, not of the footprint,
 * so a 3x3 assembler does not get a border three times as wide as a chest's.
 */
function drawMachine(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number, machine: Machine): void {
  const lift = machine.bulk * RISE_UNIT * zoom;
  const halfHeight = SOUTH_STEP.y * zoom * machine.height * 0.5;

  dropShadow(ctx, sx + lift * SHADOW_SLANT, sy + lift * SHADOW_SLANT, machine.width, machine.height, zoom);

  const outline = shade(machine.fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';

  // The near face, then the top. Two paths, not six: a camera that is tilted
  // but not turned sees a box's top and the side facing it, and nothing else —
  // the east and west walls are edge-on. That is one fewer face than the
  // pre-C27A isometric prism needed, and it is why a machine's silhouette is
  // still a rectangle and still exactly as wide as its footprint.
  const halfWidth = EAST_STEP.x * zoom * machine.width * 0.5;
  const faceTop = sy + halfHeight - lift;
  ctx.beginPath();
  ctx.moveTo(sx - halfWidth, faceTop);
  ctx.lineTo(sx + halfWidth, faceTop);
  ctx.lineTo(sx + halfWidth, sy + halfHeight);
  ctx.lineTo(sx - halfWidth, sy + halfHeight);
  ctx.closePath();
  paint(ctx, shade(machine.fill, FACE_TONE), outline);

  groundFacePath(ctx, sx, sy - lift, machine.width, machine.height, zoom);
  paint(ctx, shade(machine.fill, BODY_TONE), outline);

  const insetWidth = machine.width - MACHINE_INSET * 2;
  const insetHeight = machine.height - MACHINE_INSET * 2;
  if (insetWidth > 0 && insetHeight > 0) {
    groundFacePath(ctx, sx, sy - lift, insetWidth, insetHeight, zoom);
    paint(ctx, shade(machine.fill, INSET_TONE), outline);
  }

  drawCode(ctx, machine.code, sx, sy - lift, zoom * Math.min(machine.width, machine.height));
}

/**
 * A footprint-shaped shadow, translucent over whatever is under it.
 *
 * One function rather than four copies, because every solid thing in the game
 * casts one and they all have to agree about the light: north-west, which is
 * why callers offset by a positive amount on both axes. Saved and restored
 * around the alpha change for the reason `drawResource` is — a draw path that
 * leaves the context altered is a bug three sprites later.
 */
function dropShadow(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  width: number,
  height: number,
  zoom: number,
): void {
  groundFacePath(ctx, sx, sy, width, height, zoom);
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * SHADOW_ALPHA;
  ctx.fillStyle = color('bg-deep');
  ctx.fill();
  ctx.globalAlpha = previousAlpha;
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
  drawLane(ctx, sx, sy, zoom, rotation, phase, 0);
}

/**
 * One lane of chevrons, `across` tiles to the side of `(sx, sy)`.
 *
 * Split out of `drawBelt` by C17, because a splitter is two of these on one
 * plate: the lane is the thing that repeats, and drawing it from one function
 * is what makes task 4's "the belt lane drawn continuously through it" true by
 * construction rather than by matching two sets of constants by eye.
 */
function drawLane(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  rotation: Rotation,
  phase: number,
  across: number,
): void {
  const forward = DIRECTION_OFFSETS[rotation];
  const sideways = DIRECTION_OFFSETS[(rotation + 1) % 4];
  if (forward === undefined || sideways === undefined) return;

  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;
  const gx = (sideways.x * EAST_STEP.x + sideways.y * SOUTH_STEP.x) * zoom;
  const gy = (sideways.x * EAST_STEP.y + sideways.y * SOUTH_STEP.y) * zoom;

  const cx = sx + gx * across;
  const cy = sy + gy * across;

  ctx.strokeStyle = color('accent');
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const slide = (phase / BELT_CHEVRON_PHASES) * CHEVRON_SPACING;
  for (let i = 0; i < CHEVRON_COUNT; i++) {
    const along = CHEVRON_ORIGIN + i * CHEVRON_SPACING + slide;
    ctx.beginPath();
    ctx.moveTo(cx + fx * along - gx * CHEVRON_HALF_WIDTH, cy + fy * along - gy * CHEVRON_HALF_WIDTH);
    ctx.lineTo(cx + fx * (along + CHEVRON_HEAD), cy + fy * (along + CHEVRON_HEAD));
    ctx.lineTo(cx + fx * along + gx * CHEVRON_HALF_WIDTH, cy + fy * along + gy * CHEVRON_HALF_WIDTH);
    ctx.stroke();
  }
}

/** The mouth's opening, as a fraction of the tile, and how deep it is cut. */
const MOUTH_LENGTH = 0.44;
const MOUTH_HALF_WIDTH = 0.3;

/**
 * One mouth of an underground run: a belt plate with a hole cut in the end of
 * it, and a single chevron falling into the hole or climbing out of it.
 *
 * Drawn as a bare plate rather than as a machine because it lies *in* the
 * ground rather than on it — it is
 * `RenderLayer.Belt`, like the belt and the splitter, so a line running past a
 * building goes under it. What distinguishes it from a belt at a glance is the
 * dark opening at one end; what distinguishes the two ends from each other is
 * **which** end the opening is at. An entrance swallows items, so its hole is
 * ahead of the chevron; an exit spits them out, so its hole is behind.
 *
 * There is deliberately no chevron *phase*. Three sliding chevrons say "things
 * are moving along here", which is true of a belt tile and false of a mouth:
 * what is moving is underground and is not drawn. One static arrow says
 * "things go this way", which is all a mouth has to say.
 */
function drawUnderground(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  rotation: Rotation,
  entrance: boolean,
): void {
  const forward = DIRECTION_OFFSETS[rotation];
  const sideways = DIRECTION_OFFSETS[(rotation + 1) % 4];
  if (forward === undefined || sideways === undefined) return;

  fillFace(ctx, sx, sy, 1, 1, zoom, color('panel-high'));
  // Stroked in the structure colour, exactly as a splitter is, so the three
  // flat buildings read as belt, junction and tunnel rather than as one plate
  // drawn three ways.
  groundFacePath(ctx, sx, sy, 1, 1, zoom);
  ctx.strokeStyle = color('blue');
  ctx.lineWidth = Math.max(1, 2 * zoom);
  ctx.stroke();

  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;
  const gx = (sideways.x * EAST_STEP.x + sideways.y * SOUTH_STEP.x) * zoom;
  const gy = (sideways.x * EAST_STEP.y + sideways.y * SOUTH_STEP.y) * zoom;

  // The hole is at the far end for an entrance and at the near end for an exit
  // — which is the one line that makes the two sprites different pictures.
  const mouthSign = entrance ? 1 : -1;
  const near = 0.5 - MOUTH_LENGTH;
  ctx.beginPath();
  ctx.moveTo(sx + fx * mouthSign * near - gx * MOUTH_HALF_WIDTH, sy + fy * mouthSign * near - gy * MOUTH_HALF_WIDTH);
  ctx.lineTo(sx + fx * mouthSign * near + gx * MOUTH_HALF_WIDTH, sy + fy * mouthSign * near + gy * MOUTH_HALF_WIDTH);
  ctx.lineTo(sx + fx * mouthSign * 0.5 + gx * MOUTH_HALF_WIDTH, sy + fy * mouthSign * 0.5 + gy * MOUTH_HALF_WIDTH);
  ctx.lineTo(sx + fx * mouthSign * 0.5 - gx * MOUTH_HALF_WIDTH, sy + fy * mouthSign * 0.5 - gy * MOUTH_HALF_WIDTH);
  ctx.closePath();
  ctx.fillStyle = color('bg-deep');
  ctx.fill();

  // One chevron, pointing the way items go, set back from the hole so it reads
  // as approaching it rather than as part of it.
  ctx.strokeStyle = color('accent');
  ctx.lineWidth = Math.max(1, 1.5 * zoom);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const along = 0 - mouthSign * 0.24;
  ctx.beginPath();
  ctx.moveTo(sx + fx * along - gx * CHEVRON_HALF_WIDTH, sy + fy * along - gy * CHEVRON_HALF_WIDTH);
  ctx.lineTo(sx + fx * (along + CHEVRON_HEAD), sy + fy * (along + CHEVRON_HEAD));
  ctx.lineTo(sx + fx * along + gx * CHEVRON_HALF_WIDTH, sy + fy * along + gy * CHEVRON_HALF_WIDTH);
  ctx.stroke();
}

/** How far each of a splitter's two lanes sits from the middle, in tiles. */
const SPLITTER_LANE_OFFSET = 0.5;

/**
 * A splitter: one plate two tiles wide, with a belt lane running through each
 * half of it. C17 task 4.
 *
 * The footprint is not a parameter because it is implied by the facing — two
 * tiles across the flow and one deep, which is what `data/buildings.ts` says
 * and what the building registry refuses to let content contradict. An odd
 * rotation therefore swaps the extent, exactly as `footprintExtent` does for
 * the entity itself, and this is the renderer arriving at the same answer from
 * the same fact rather than being told it twice.
 *
 * The edge is stroked in the structure colour so that two belts and a splitter
 * are distinguishable at a glance: the lanes are deliberately identical, since
 * an item does not change speed crossing into one, and the outline is the only
 * thing that says a decision is being made here.
 */
function drawSplitter(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  rotation: Rotation,
  phase: number,
): void {
  const across = rotation === 1 || rotation === 3;
  const width = across ? 1 : 2;
  const height = across ? 2 : 1;

  fillFace(ctx, sx, sy, width, height, zoom, color('panel-high'));
  groundFacePath(ctx, sx, sy, width, height, zoom);
  ctx.strokeStyle = color('blue');
  ctx.lineWidth = Math.max(1, 2 * zoom);
  ctx.stroke();

  drawLane(ctx, sx, sy, zoom, rotation, phase, 0 - SPLITTER_LANE_OFFSET);
  drawLane(ctx, sx, sy, zoom, rotation, phase, SPLITTER_LANE_OFFSET);
}

/** The inserter's base, as a fraction of a tile, and its bulk. */
const INSERTER_BASE_SIZE = 0.46;
const INSERTER_BASE_BULK = 0.45;

/** How far the hand reaches from the base, in tiles, at each end of the sweep. */
const INSERTER_ARM_REACH = 0.52;

/** How high the arm carries the hand at the middle of the sweep, in bulk units. */
const INSERTER_ARM_LIFT = 0.9;

/** The hand, and the item in it, as a fraction of a tile. */
const INSERTER_HAND_SIZE = 0.2;

/**
 * An inserter: a squat base with one arm sweeping over it.
 *
 * The sweep is an **arc**, not a slide. Interpolating the hand's position
 * linearly from the source tile to the destination tile would take it through
 * the base at the halfway point, where the two offsets cancel — so the arm
 * would vanish into itself every cycle. Sweeping through a half turn instead
 * puts the hand over the source at one end, over the destination at the other,
 * and clear of the base in between.
 *
 * `cos` runs along the facing axis and `sin` up the screen, so the hand sits
 * over the source at one end, over the destination at the other, and is raised
 * above the machine in between. C27A briefly swung it sideways in the ground
 * plane instead, which is what a top-down camera would show and is not what
 * this one is: the camera is tilted (C27B), so height is visible and an arm
 * that lifts reads as lifting.
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
  const forward = DIRECTION_OFFSETS[rotation];
  if (forward === undefined) return;

  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;

  // The base: a short box, drawn through the same function every machine uses
  // so its face and its light match theirs. No code on it — it is half a tile
  // across and a two-letter label there is a smudge.
  drawMachine(ctx, sx, sy, zoom, {
    fill,
    code: '',
    width: INSERTER_BASE_SIZE,
    height: INSERTER_BASE_SIZE,
    bulk: INSERTER_BASE_BULK,
  });

  // π at the source end, 0 at the destination end.
  const angle = Math.PI * (1 - swing / INSERTER_SWING_STEPS);
  const along = Math.cos(angle) * INSERTER_ARM_REACH;
  const shoulderY = sy - INSERTER_BASE_BULK * RISE_UNIT * zoom;
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
  ctx.fillStyle = shade(color(holding ? 'accent-high' : 'blue-high'), BODY_TONE);
  ctx.fill();
  ctx.strokeStyle = shade(fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** How much of a tile one item covers. Four of these fit along a tile (§9). */
export const ITEM_TILE_SIZE = 0.3;

/** How high a lump of ore rides above the belt under it, in bulk units. */
const ITEM_BULK = 0.22;

/** A plate lies flat on the belt; a lump of ore sits proud of it. */
const PLATE_BULK = 0.07;

/**
 * One item: a small square sitting on whatever it is riding.
 *
 * Deliberately the cheapest thing that reads. An item is drawn four to a tile
 * and there may be thousands on screen at once (§12), so it is two paths —
 * a shadow and a face — and the only thing that tells a lump of ore from a
 * plate is how far apart those two are and how the face is lit.
 */
function drawItem(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  zoom: number,
  fill: string,
  flat: boolean,
): void {
  const lift = (flat ? PLATE_BULK : ITEM_BULK) * RISE_UNIT * zoom;

  // A shadow on the surface below, so an item reads as being *on* the belt
  // rather than as a stain in it.
  dropShadow(ctx, sx + lift * SHADOW_SLANT, sy + lift * SHADOW_SLANT, ITEM_TILE_SIZE, ITEM_TILE_SIZE, zoom);

  groundFacePath(ctx, sx, sy - lift, ITEM_TILE_SIZE, ITEM_TILE_SIZE, zoom);
  ctx.fillStyle = shade(fill, flat ? BODY_TONE : LUMP_TOP_TONE);
  ctx.fill();
  ctx.strokeStyle = shade(fill, OUTLINE_TONE);
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** The figure's radius, as a fraction of a tile. Comfortably inside one. */
const PLAYER_RADIUS = 0.19;

/** How tall the figure stands, in bulk units. Shorter than a chest. */
const PLAYER_BULK = 0.8;

/** How much shorter the figure stands while mining. */
const PLAYER_WORK_SCALE = 0.72;

/** How far the nose sticks out past the body, as a multiple of the radius. */
const PLAYER_NOSE = 1.5;

/** Colour per activity, so "walking" and "mining" are told apart at a glance. */
const PLAYER_TONE: Readonly<Record<PlayerActivity, ColorToken>> = Object.freeze({
  idle: 'blue-high',
  walk: 'accent-high',
  work: 'warn',
});

/**
 * The player: a shadow, a body and a nose pointing where they face.
 *
 * §11's placeholder-first pipeline in its purest form — C10 task 6 asks for
 * three states from the reference sheet and says in as many words that real
 * animation is C29's. What this has to get right is only what the *mechanics*
 * need to be verifiable by eye: which way the player is facing, whether they
 * are working, and where they are standing, because that last one is what the
 * build-range circle is drawn around.
 *
 * The figure stands up, like everything else the tilted camera sees (C27B):
 * a shadow on the tile, a body, and a head over it. What C27A's flat version
 * got right and this keeps is the nose — a wedge on the ground rather than a
 * line, because facing is the one thing about this sprite the player reads
 * every second and a one-pixel line at zoom 0.5 is not a readout.
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
  const radius = PLAYER_RADIUS * TILE_HALF_WIDTH * 2 * zoom;

  // Mining crouches: the same figure, shorter, which reads at any zoom and
  // needs no second sprite.
  const lift = PLAYER_BULK * RISE_UNIT * zoom * (activity === 'work' ? PLAYER_WORK_SCALE : 1);

  // A shadow on the tile, so the figure reads as standing on it rather than as
  // a mark painted on it.
  const previousAlpha = ctx.globalAlpha;
  ctx.globalAlpha = previousAlpha * SHADOW_ALPHA;
  ctx.beginPath();
  ctx.ellipse(sx + lift * SHADOW_SLANT, sy + lift * SHADOW_SLANT, radius, radius * 0.7, 0, 0, Math.PI * 2);
  ctx.fillStyle = color('bg-deep');
  ctx.fill();
  ctx.globalAlpha = previousAlpha;

  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';

  // Which way they are looking, in tile space, projected the same way
  // everything else is — so "north" points wherever north points on screen,
  // which since C27A is straight up.
  const forward = DIRECTION_OFFSETS[facing];
  if (forward === undefined) return;
  const fx = (forward.x * EAST_STEP.x + forward.y * SOUTH_STEP.x) * zoom;
  const fy = (forward.x * EAST_STEP.y + forward.y * SOUTH_STEP.y) * zoom;
  const length = Math.hypot(fx, fy);
  if (length === 0) return;
  const nx = fx / length;
  const ny = fy / length;

  // The nose sits on the ground and points where they walk, drawn first so the
  // body stands in front of it rather than beside it.
  ctx.beginPath();
  ctx.moveTo(sx + nx * radius * PLAYER_NOSE, sy + ny * radius * PLAYER_NOSE * 0.7);
  ctx.lineTo(sx - ny * radius * 0.7, sy + nx * radius * 0.5);
  ctx.lineTo(sx + ny * radius * 0.7, sy - nx * radius * 0.5);
  ctx.closePath();
  paint(ctx, shade(fill, FACE_TONE), outline);

  // The body: a rounded column standing on the tile, then a head over it.
  ctx.beginPath();
  ctx.moveTo(sx - radius * 0.72, sy);
  ctx.lineTo(sx - radius * 0.72, sy - lift);
  ctx.lineTo(sx + radius * 0.72, sy - lift);
  ctx.lineTo(sx + radius * 0.72, sy);
  ctx.closePath();
  paint(ctx, shade(fill, BODY_TONE), outline);

  ctx.beginPath();
  ctx.arc(sx, sy - lift, radius * 0.78, 0, Math.PI * 2);
  paint(ctx, shade(fill, INSET_TONE), outline);
}

function drawMissing(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number): void {
  fillFace(ctx, sx, sy, 1, 1, zoom, '#ff00ff');
  drawCode(ctx, '??', sx, sy, zoom);
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
