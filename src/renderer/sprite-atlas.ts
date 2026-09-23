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
 * terrain:<name>[:<variant 0-3>]              terrain:grass:2
 * resource:<name>:<fullness 0-3>              resource:iron:2
 * belt:<rotation 0-3>[:<phase 0-7>]           belt:1:5
 * splitter:<rotation 0-3>[:<phase 0-7>]       splitter:1:5
 * inserter:<rotation 0-3>:<swing 0-16>[:h]    inserter:2:8:h
 * item:<item id>                              item:iron_ore
 * player:<idle|walk|work>:<facing 0-3>[:<frame 0-3>]
 *                                             player:walk:1:2
 * building:<category>:<CODE>[:<w>x<h>[:<rise>]][:f<frame 0-3>]
 *                                             building:extraction:MI
 *                                             building:power:PP:2x2:3
 *                                             building:extraction:MI:2x2:2:f1
 * ```
 *
 * The optional tails are C29's (art tasks 3 and 4): a terrain variant, so a
 * field is not wallpaper, and an activity frame for machines and the player,
 * where frame 0 is at rest. Each is optional so an id written before C29 still
 * names the same picture.
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
 * ## Geometry and drawing
 *
 * The geometry every sprite obeys is in `sprite-geometry.ts` and the drawings
 * are in `sprite-painter.ts`, both since C29. This file is the vocabulary: the
 * ids, what they parse into, and the two atlases that draw them — the
 * procedural one here, which paints every call, and `ImageAtlas`, which copies
 * baked cells.
 */

import type { Rotation } from '../game/world/coordinates.js';
import {
  NO_BUCKET,
  RESOURCE_BUCKET_COUNT,
  RESOURCE_TYPE_COUNT,
  ResourceType,
  resourceBucket,
  resourceName,
} from '../game/world/resource.js';
import { TILE_TYPE_COUNT, type TileType, tileProperties } from '../game/world/tile.js';

import { PALETTE, color, type ColorToken } from './palette.js';
import { ACTIVITY_FRAMES, BELT_CHEVRON_PHASES, INSERTER_SWING_STEPS, RISE_UNIT } from './sprite-geometry.js';
import { paintSprite } from './sprite-painter.js';

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

/* The geometry moved to `sprite-geometry.ts` in C29; re-exported so nothing
 * that imported it from here had to move. */
export {
  ACTIVITY_FRAMES,
  BELT_CHEVRON_PHASES,
  DETAIL_ZOOM,
  INSERTER_SWING_STEPS,
  RISE_UNIT,
  TILE_HALF_HEIGHT,
  TILE_HALF_WIDTH,
  groundFacePath,
} from './sprite-geometry.js';

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
 * The sprite for a belt facing `rotation`, `phase` steps into its cycle.
 *
 * `joined` says which sides another belt feeds in from (2026-09-23): bit 1 is
 * the left of the flow, bit 2 the right. A joined side is drawn without its
 * lit lip, so the incoming belt meets an open edge. Written as a `j<mask>`
 * tail, and left off when nothing joins, so every older id names the same
 * picture it did.
 */
export function beltSprite(rotation: Rotation, phase = 0, joined = 0): SpriteId {
  return joined === 0 ? `belt:${rotation}:${phase}` : `belt:${rotation}:${phase}:j${joined}`;
}

/** `beltSprite`'s `joined` bit for a belt fed from its left. */
export const JOINED_LEFT = 1;
/** `beltSprite`'s `joined` bit for a belt fed from its right. */
export const JOINED_RIGHT = 2;

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

/** How many texture variants each terrain type has (C29). */
export const TERRAIN_VARIANTS = 4;

/** `[type][variant]`, built once so the terrain loop allocates no strings. */
const TERRAIN_VARIANT_SPRITES: readonly (readonly SpriteId[])[] = Object.freeze(
  TERRAIN_SPRITES.map((base) =>
    Object.freeze(Array.from({ length: TERRAIN_VARIANTS }, (_unused, variant) => `${base}:${variant}`)),
  ),
);

/**
 * The sprite for a terrain type with one of its texture variants (C29).
 *
 * The terrain layer picks the variant from the tile's position, so the same
 * tile is always the same picture and a field of grass is not wallpaper. The
 * bare `terrainSprite` still names a flat face in the same colour.
 */
export function terrainVariantSprite(type: TileType, variant: number): SpriteId {
  return TERRAIN_VARIANT_SPRITES[type]?.[variant & (TERRAIN_VARIANTS - 1)] ?? MISSING_SPRITE;
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
  | {
      readonly kind: 'face';
      readonly fill: string;
      /** The terrain's name, and which of its variants. Only on a variant id (C29). */
      readonly texture?: string;
      readonly variant?: number;
    }
  | { readonly kind: 'resource'; readonly fill: string; readonly bucket: number }
  | {
      readonly kind: 'machine';
      readonly fill: string;
      readonly code: string;
      readonly width: number;
      readonly height: number;
      /** How heavy it reads: shadow length and inset depth. See the grammar. */
      readonly bulk: number;
      /** The activity frame, 1-3 while working. Absent (at rest) on a plain id. */
      readonly frame?: number;
    }
  | {
      readonly kind: 'belt';
      readonly rotation: Rotation;
      readonly phase: number;
      /** Which sides are fed from another belt. See `beltSprite`. Absent when none. */
      readonly joined?: number;
    }
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
  | { readonly kind: 'item'; readonly fill: string; readonly flat: boolean; readonly shape: ItemShape }
  | {
      readonly kind: 'player';
      readonly activity: PlayerActivity;
      readonly facing: Rotation;
      /** The activity frame. Absent on a plain id, which is frame 0. */
      readonly frame?: number;
    }
  | { readonly kind: 'missing' };

/** The three states C10 task 6 asks for, each animated since C29. */
export type PlayerActivity = 'idle' | 'walk' | 'work';

export const PLAYER_ACTIVITIES: readonly PlayerActivity[] = Object.freeze(['idle', 'walk', 'work']);

/**
 * The sprite for a player in a given state, facing a given way, `frame` steps
 * into that state's cycle. Without a frame it is frame 0 — the id C10 wrote.
 */
export function playerSprite(activity: PlayerActivity, facing: Rotation, frame?: number): SpriteId {
  return frame === undefined ? `player:${activity}:${facing}` : `player:${activity}:${facing}:${frame}`;
}

/**
 * A building's sprite `frame` steps into its activity cycle (C29).
 *
 * Frame 0 is the plain id, so a building at rest — and a ghost, and anything
 * content names — is exactly the sprite it always was. Memoised, because the
 * entity view asks for one per working machine per frame and a string built
 * each time would be thousands of allocations a second on a large factory.
 */
const frameSpriteCache = new Map<SpriteId, SpriteId[]>();

export function machineFrameSprite(base: SpriteId, frame: number): SpriteId {
  if (frame === 0) return base;
  let frames = frameSpriteCache.get(base);
  if (frames === undefined) {
    frames = Array.from({ length: ACTIVITY_FRAMES }, (_unused, f) => (f === 0 ? base : `${base}:f${f}`));
    frameSpriteCache.set(base, frames);
  }
  return frames[frame % ACTIVITY_FRAMES] ?? base;
}

/**
 * What an item looks like, by what kind of thing it is (C29).
 *
 * Read off the id by the same suffix rule that picks its colour, plus a short
 * list of names. Per-item knowledge in the renderer is the art's business —
 * it decides how a gear looks, not how it behaves — and an item nobody listed
 * is a crate in its own colour, which is what a building on a belt is anyway.
 */
export type ItemShape = 'lump' | 'plate' | 'ingot' | 'gear' | 'coil' | 'chip' | 'core' | 'crate';

const NAMED_SHAPES: Readonly<Record<string, ItemShape>> = Object.freeze({
  coal: 'lump',
  stone: 'lump',
  steel: 'ingot',
  brick: 'ingot',
  gear: 'gear',
  circuit: 'chip',
  data_core: 'core',
});

function itemShape(itemId: string): ItemShape {
  if (itemId.endsWith('_ore')) return 'lump';
  if (itemId.endsWith('_plate')) return 'plate';
  if (itemId.endsWith('_wire')) return 'coil';
  return NAMED_SHAPES[itemId] ?? 'crate';
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

  if (namespace === 'terrain' && (parts.length === 2 || parts.length === 3)) {
    const name = parts[1] ?? '';
    const token = `terrain-${name}`;
    if (!isColorToken(token)) return MISSING;
    if (parts.length === 2) return Object.freeze({ kind: 'face' as const, fill: color(token) });
    const variant = parts[2] ?? '';
    if (!/^[0-3]$/.test(variant)) return MISSING;
    return Object.freeze({ kind: 'face' as const, fill: color(token), texture: name, variant: Number(variant) });
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

  if (namespace === 'belt' && parts.length === 4) {
    const text = parts[1] ?? '';
    const phaseText = parts[2] ?? '';
    const joinedText = parts[3] ?? '';
    if (!/^[0-3]$/.test(text) || !/^\d+$/.test(phaseText) || !/^j[1-3]$/.test(joinedText)) return MISSING;
    return Object.freeze({
      kind: 'belt' as const,
      rotation: Number(text) as Rotation,
      phase: Number(phaseText) % BELT_CHEVRON_PHASES,
      joined: Number(joinedText.slice(1)),
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
    // read as one line whatever stage it is at. Since C29 the *shape* says
    // what stage — see `itemShape` — and the colour keeps saying which metal.
    const flat = itemId.endsWith('_plate');
    const token = itemId.replace(/_(ore|plate|wire)$/, '');
    return Object.freeze({
      kind: 'item' as const,
      fill: color(isColorToken(token) ? token : DEFAULT_ITEM_COLOR),
      flat,
      shape: itemShape(itemId),
    });
  }

  if (namespace === 'player' && (parts.length === 3 || parts.length === 4)) {
    const activity = parts[1] ?? '';
    if (!isPlayerActivity(activity)) return MISSING;
    // Matched as text for the same reason the belt rotation is: `Number('')`
    // is 0, and a facing of "north" is not the right answer to a typo.
    const text = parts[2] ?? '';
    if (!/^[0-3]$/.test(text)) return MISSING;
    if (parts.length === 3) return Object.freeze({ kind: 'player' as const, activity, facing: Number(text) as Rotation });
    const frame = parts[3] ?? '';
    if (!/^[0-3]$/.test(frame)) return MISSING;
    return Object.freeze({ kind: 'player' as const, activity, facing: Number(text) as Rotation, frame: Number(frame) });
  }

  // The activity frame is a tail, `:f<n>`, stripped before the rest is read:
  // the `f` is what keeps it from being mistaken for a footprint or a bulk.
  const frameTail = namespace === 'building' ? /^f([0-3])$/.exec(parts[parts.length - 1] ?? '') : null;
  if (frameTail !== null) parts.pop();

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

    const machine = {
      kind: 'machine' as const,
      fill: color(CATEGORY_COLORS[category] ?? DEFAULT_CATEGORY_COLOR),
      code,
      width: footprint.width,
      height: footprint.height,
      bulk,
    };
    // Only a framed id carries the field, so a plain id's descriptor is the
    // one it was before C29 (and compares equal to it).
    return Object.freeze(frameTail === null ? machine : { ...machine, frame: Number(frameTail[1]) });
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
 * Everything painted by code on every call, no images. See §11's
 * placeholder-first pipeline.
 *
 * Since C29 this is the *live* half of the pair rather than the placeholder:
 * `ImageAtlas` bakes these same paintings into one image and copies cells out
 * of it, and hands anything it has no cell for — terrain, which the terrain
 * layer caches anyway, and zooms above its largest bake — back to this.
 */
export class ProceduralAtlas implements SpriteAtlas {
  readonly kind = 'procedural' as const;

  draw(ctx: CanvasRenderingContext2D, id: SpriteId, sx: number, sy: number, zoom: number): void {
    paintSprite(ctx, describeSprite(id), sx, sy, zoom);
  }
}
