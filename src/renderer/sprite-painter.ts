/**
 * The drawings. See ironflow.md C29's art pass and §11's asset spec.
 *
 * Everything the game shows is painted here, by code, from a parsed sprite
 * id. There is still no image asset in the repository: C29's `ImageAtlas`
 * bakes these paintings into one image at startup and copies cells out of it,
 * and `ProceduralAtlas` calls them directly. Both draw the same picture
 * because there is one painter.
 *
 * ## The model
 *
 * Every building is a stack of **boxes and cylinders** standing on its
 * footprint, seen from §11's raised camera. A box shows its top and its near
 * (south) face and nothing else, because the camera is tilted and not turned.
 * The top is lit, the face is two thirds as bright, and every edge gets the
 * same dark outline. That is the reference sheet's silhouette language: steel
 * bodies, a dark plinth, the category colour as trim, and orange where energy
 * is.
 *
 * Coordinates below are in **tiles**, relative to the anchor, which is the
 * centre of the footprint's ground face: `u` runs east, `v` runs south, and
 * `h` is height in bulk units (§11: one unit is 0.45 tiles up the screen).
 * Nothing here knows how many pixels a tile is. The two basis vectors do.
 *
 * ## The rules a drawing must keep
 *
 * - **Stay inside the footprint horizontally.** The picker sweeps the
 *   footprint up the screen (§11 "Silhouette"), so anything wider would be
 *   drawn where it cannot be picked.
 * - **Stay inside `spriteExtent`** (`image-atlas.ts`). The baker clips each
 *   cell to it, so paint outside it is cut off.
 * - **Draw back to front**: north before south, low before high. Painter's
 *   order inside one sprite is this file's job, as between sprites it is the
 *   depth key's.
 */

import { DIRECTION_OFFSETS, type Rotation } from '../game/world/coordinates.js';

import { FONT_STACK, color, shade } from './palette.js';
import type { ItemShape, PlayerActivity, SpriteDescriptor } from './sprite-atlas.js';
import {
  BELT_CHEVRON_PHASES,
  BELT_DECK,
  DETAIL_ZOOM,
  EAST_STEP,
  INSERTER_SWING_STEPS,
  RISE_UNIT,
  SHADOW_ALPHA,
  SHADOW_SLANT,
  SOUTH_STEP,
  groundFacePath,
} from './sprite-geometry.js';

/* -------------------------------------------------------------------------- *
 * The pen
 *
 * Module state rather than an object passed around: a painting is a few dozen
 * primitive calls, each needing the same eight numbers, and threading them
 * through every call would be most of the code. `begin` sets them and nothing
 * outside this file can see them.
 * -------------------------------------------------------------------------- */

let C: CanvasRenderingContext2D;
let OX = 0;
let OY = 0;
let Z = 1;
let EX = 0;
let EY = 0;
let GX = 0;
let GY = 0;
let RISE = 0;
let DETAIL = true;
let LINE = 1;

function begin(ctx: CanvasRenderingContext2D, sx: number, sy: number, zoom: number, detail: boolean): void {
  C = ctx;
  OX = sx;
  OY = sy;
  Z = zoom;
  EX = EAST_STEP.x * zoom;
  EY = EAST_STEP.y * zoom;
  GX = SOUTH_STEP.x * zoom;
  GY = SOUTH_STEP.y * zoom;
  RISE = RISE_UNIT * zoom;
  DETAIL = detail;
  LINE = Math.max(1, zoom * 0.9);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
}

/** Screen x of tile-space `(u, v)`. Height does not move a point sideways. */
function X(u: number, v: number): number {
  return OX + u * EX + v * GX;
}

/** Screen y of tile-space `(u, v)` at height `h` bulk units. */
function Y(u: number, v: number, h: number): number {
  return OY + u * EY + v * GY - h * RISE;
}

/* -------------------------------------------------------------------------- *
 * Tones
 * -------------------------------------------------------------------------- */

/** A top face, facing the light. */
const TOP_TONE = 1;
/** A near face, turned away from it. §11: "about two thirds as bright". */
const FACE_TONE = 0.66;

function outline(): string {
  return color('bg-deep');
}

function paint(fill: string, stroke = true): void {
  C.fillStyle = fill;
  C.fill();
  if (stroke) {
    C.strokeStyle = outline();
    C.lineWidth = LINE;
    C.stroke();
  }
}

/* -------------------------------------------------------------------------- *
 * Primitives
 * -------------------------------------------------------------------------- */

/** A four-point polygon in the vertical plane `v`, from `h0` up to `h1`. */
function faceQuad(u0: number, u1: number, v: number, h0: number, h1: number): void {
  C.beginPath();
  C.moveTo(X(u0, v), Y(u0, v, h0));
  C.lineTo(X(u1, v), Y(u1, v, h0));
  C.lineTo(X(u1, v), Y(u1, v, h1));
  C.lineTo(X(u0, v), Y(u0, v, h1));
  C.closePath();
}

/** A four-point polygon in the horizontal plane `h`. */
function topQuad(u0: number, v0: number, u1: number, v1: number, h: number): void {
  C.beginPath();
  C.moveTo(X(u0, v0), Y(u0, v0, h));
  C.lineTo(X(u1, v0), Y(u1, v0, h));
  C.lineTo(X(u1, v1), Y(u1, v1, h));
  C.lineTo(X(u0, v1), Y(u0, v1, h));
  C.closePath();
}

/**
 * A box on `[u0, u1] x [v0, v1]` from height `h0` to `h1`: its near face, then
 * its top. The two faces the camera can see, and only those.
 */
function box(u0: number, v0: number, u1: number, v1: number, h0: number, h1: number, fill: string, top?: string): void {
  if (h1 > h0) {
    faceQuad(u0, u1, v1, h0, h1);
    paint(shade(fill, FACE_TONE));
  }
  topQuad(u0, v0, u1, v1, h1);
  paint(top ?? shade(fill, TOP_TONE));
}

/** A flat panel painted on a south face at `v`. A door, a stripe, a window. */
function facePanel(u0: number, u1: number, v: number, h0: number, h1: number, fill: string): void {
  faceQuad(u0, u1, v, h0, h1);
  paint(fill, DETAIL);
}

/** A flat panel painted on a top at height `h`. */
function topPanel(u0: number, v0: number, u1: number, v1: number, h: number, fill: string): void {
  topQuad(u0, v0, u1, v1, h);
  paint(fill, DETAIL);
}

/** A circle lying in the horizontal plane `h`, radius `r` tiles. */
function disc(u: number, v: number, r: number, h: number, fill: string, stroke = true): void {
  C.beginPath();
  C.arc(X(u, v), Y(u, v, h), r * EX, 0, Math.PI * 2);
  paint(fill, stroke);
}

/**
 * An upright cylinder: its near side, then its top. A tank, a chimney, a turret.
 *
 * The side is the rectangle between the two centres plus the near half of the
 * base circle — the half facing the camera, which is the south half, which in
 * canvas angles runs from π through π/2 to 0.
 */
function cylinder(u: number, v: number, r: number, h0: number, h1: number, fill: string, top?: string): void {
  const x = X(u, v);
  const radius = r * EX;
  C.beginPath();
  C.moveTo(x - radius, Y(u, v, h1));
  C.lineTo(x - radius, Y(u, v, h0));
  C.arc(x, Y(u, v, h0), radius, Math.PI, 0, true);
  C.lineTo(x + radius, Y(u, v, h1));
  C.closePath();
  paint(shade(fill, FACE_TONE));
  disc(u, v, r, h1, top ?? shade(fill, TOP_TONE));
}

/**
 * The shadow of a box `h` bulk units tall standing on `[u0, u1] x [v0, v1]`.
 *
 * The footprint swept south-east by the lift times §11's slant: the hull of
 * the rectangle and its offset copy, which is a hexagon. Before C29 a shadow
 * was the footprint *moved*, which floats a tall thing off the ground; the
 * hull keeps it attached at the base the way a real one is.
 */
function shadowBox(u0: number, v0: number, u1: number, v1: number, h: number): void {
  const d = h * RISE * SHADOW_SLANT;
  C.beginPath();
  C.moveTo(X(u0, v0), Y(u0, v0, 0));
  C.lineTo(X(u1, v0), Y(u1, v0, 0));
  C.lineTo(X(u1, v0) + d, Y(u1, v0, 0) + d);
  C.lineTo(X(u1, v1) + d, Y(u1, v1, 0) + d);
  C.lineTo(X(u0, v1) + d, Y(u0, v1, 0) + d);
  C.lineTo(X(u0, v1), Y(u0, v1, 0));
  C.closePath();
  const previousAlpha = C.globalAlpha;
  C.globalAlpha = previousAlpha * SHADOW_ALPHA;
  C.fillStyle = color('bg-deep');
  C.fill();
  C.globalAlpha = previousAlpha;
}

/** A thick line from one tile-space point to another, outlined. An arm, a post. */
function strut(u0: number, v0: number, h0: number, u1: number, v1: number, h1: number, width: number, fill: string): void {
  C.beginPath();
  C.moveTo(X(u0, v0), Y(u0, v0, h0));
  C.lineTo(X(u1, v1), Y(u1, v1, h1));
  C.strokeStyle = outline();
  C.lineWidth = width * EX + LINE * 2;
  C.stroke();
  C.strokeStyle = fill;
  C.lineWidth = width * EX;
  C.stroke();
}

/** Below this many pixels a two-letter code is a smudge, so it is skipped. */
const MIN_LABEL_PX = 7;

function label(code: string, u: number, v: number, h: number, scale: number): void {
  const size = Math.round(11 * Z * scale);
  if (size < MIN_LABEL_PX) return;
  const x = X(u, v);
  const y = Y(u, v, h);
  C.font = `${size}px ${FONT_STACK}`;
  C.textAlign = 'center';
  C.textBaseline = 'middle';
  C.fillStyle = color('bg-deep');
  C.fillText(code, x, y + Math.max(1, Z * scale));
  C.fillStyle = color('text');
  C.fillText(code, x, y);
}

/* -------------------------------------------------------------------------- *
 * Entry point
 * -------------------------------------------------------------------------- */

/**
 * Paint one parsed sprite with its anchor at `(sx, sy)`, scaled by `zoom`.
 *
 * `detail` is whether to draw small details, and defaults to what the zoom
 * says (`DETAIL_ZOOM`). The baker passes it explicitly: its plain levels are
 * painted at a scale above the threshold for displays with more than one
 * device pixel per CSS pixel, and must still be plain.
 *
 * Leaves the context as it found it, apart from the path and the styles every
 * draw call sets before it uses them: a painter that changed `globalAlpha` or
 * the transform would be a bug three sprites later.
 */
export function paintSprite(
  ctx: CanvasRenderingContext2D,
  sprite: SpriteDescriptor,
  sx: number,
  sy: number,
  zoom: number,
  detail = zoom >= DETAIL_ZOOM,
): void {
  begin(ctx, sx, sy, zoom, detail);
  switch (sprite.kind) {
    case 'face':
      paintTerrain(sprite.fill, sprite.texture, sprite.variant);
      return;
    case 'resource':
      paintResource(sprite.fill, sprite.bucket);
      return;
    case 'machine':
      paintMachine(sprite);
      return;
    case 'belt':
      paintBelt(sprite.rotation, sprite.phase, sprite.joined ?? 0);
      return;
    case 'splitter':
      paintSplitter(sprite.rotation, sprite.phase);
      return;
    case 'underground':
      paintUnderground(sprite.rotation, sprite.entrance);
      return;
    case 'inserter':
      paintInserter(sprite.rotation, sprite.swing, sprite.holding);
      return;
    case 'item':
      paintItem(sprite.fill, sprite.shape);
      return;
    case 'player':
      paintPlayer(sprite.activity, sprite.facing, sprite.frame ?? 0);
      return;
    case 'missing':
      topQuad(-0.5, -0.5, 0.5, 0.5, 0);
      paint('#ff00ff');
      label('??', 0, 0, 0, 1);
      return;
  }
}

/* -------------------------------------------------------------------------- *
 * Terrain and ore
 * -------------------------------------------------------------------------- */

/**
 * Where a tile's texture marks sit, per variant, in tile fractions.
 *
 * A fixed table, not noise: two tiles with the same variant are the same
 * picture, so the terrain cache and the direct path agree and a screenshot is
 * reproducible. The *variant* is what varies, and the terrain layer picks it
 * from the tile's position, so a field of grass does not read as wallpaper.
 * Every mark stays inside ±0.4 of the centre, because terrain is drawn into
 * per-world-chunk bitmaps and anything crossing a tile edge at a chunk seam
 * would be clipped.
 */
const MARKS: readonly (readonly (readonly [number, number])[])[] = Object.freeze([
  [[-0.28, -0.22], [0.18, -0.3], [0.3, 0.12], [-0.12, 0.26], [0.02, 0.0]],
  [[-0.3, 0.05], [0.05, -0.26], [0.28, -0.05], [-0.05, 0.3], [0.22, 0.28]],
  [[-0.2, -0.3], [0.3, -0.25], [-0.3, 0.3], [0.1, 0.12], [-0.05, -0.05]],
  [[0.26, 0.3], [-0.26, -0.05], [0.0, -0.3], [0.3, 0.02], [-0.2, 0.22]],
]);

/**
 * A terrain tile: a flat face, and — above `DETAIL_ZOOM`, for a tile named with
 * a variant — a few marks that say what the ground is made of.
 *
 * The outline in the fill colour is not decoration. Two faces sharing an edge
 * are each antialiased against transparency along it, and the two
 * half-covered pixels do not add up to one opaque one — so a hairline of the
 * background shows through every tile boundary. Widening each face by half a
 * line covers its neighbour's gap.
 */
function paintTerrain(fill: string, texture: string | undefined, variant: number | undefined): void {
  groundFacePath(C, OX, OY, 1, 1, Z);
  C.fillStyle = fill;
  C.fill();
  C.strokeStyle = fill;
  C.lineWidth = 1;
  C.stroke();
  if (texture === undefined || variant === undefined || !DETAIL) return;

  const marks = MARKS[variant % MARKS.length] ?? [];
  const dark = shade(fill, 0.82);
  const light = shade(fill, 1.16);
  C.lineWidth = Math.max(1, Z * 1.2);

  for (let i = 0; i < marks.length; i++) {
    const mark = marks[i];
    if (mark === undefined) continue;
    const u = mark[0];
    const v = mark[1];
    const x = X(u, v);
    const y = Y(u, v, 0);
    const s = EX * 0.06;
    switch (texture) {
      case 'grass':
        // Tufts: two blades, dark then light, so they read as standing up.
        C.beginPath();
        C.moveTo(x - s, y + s);
        C.lineTo(x - s * 0.4, y - s);
        C.moveTo(x + s * 0.2, y + s);
        C.lineTo(x + s * 0.8, y - s * 0.6);
        C.strokeStyle = i % 2 === 0 ? dark : light;
        C.stroke();
        break;
      case 'water':
        // Ripples: short light arcs, fewer of them, because water is calm.
        if (i % 2 === 1) break;
        C.beginPath();
        C.arc(x, y + s, s * 1.6, Math.PI * 1.15, Math.PI * 1.85);
        C.strokeStyle = light;
        C.stroke();
        break;
      case 'stone':
        // Cracks, and a loose chip beside the first.
        if (i === 0) {
          C.beginPath();
          C.moveTo(x - s * 2, y - s);
          C.lineTo(x, y);
          C.lineTo(x + s, y + s * 2);
          C.strokeStyle = dark;
          C.stroke();
        } else {
          C.fillStyle = i % 2 === 0 ? light : dark;
          C.fillRect(x - s * 0.6, y - s * 0.6, s * 1.2, s * 1.2);
        }
        break;
      default:
        // Sand, dirt and anything added later: grain.
        C.fillStyle = i % 2 === 0 ? dark : light;
        C.fillRect(x - s * 0.5, y - s * 0.5, s, s);
        break;
    }
  }
}

/** Ground tint opacity per fullness bucket, thinnest first. */
const TINT_ALPHA: readonly number[] = Object.freeze([0.3, 0.45, 0.6, 0.78]);

/** Where each rock sits, and how big it is, back to front. One per bucket. */
const ROCKS: readonly (readonly [number, number, number])[] = Object.freeze([
  [-0.16, -0.18, 0.15],
  [0.2, -0.08, 0.13],
  [-0.22, 0.16, 0.12],
  [0.12, 0.24, 0.14],
]);

/** Below this many pixels across, rocks are skipped and the tint carries alone. */
const MIN_ROCK_PX = 3;

/**
 * Ore on a tile: a tint over the ground, plus one rock per unit of fullness.
 *
 * Two readings of the same number (C09 task 3). The tint survives to the far
 * end of the zoom range, where a rock is a fraction of a pixel; the rocks are
 * what tell a half-mined tile from a full one when the player is standing
 * over it. Since C29 the rocks stand up — a lit top and a dark front, like
 * everything else — which is the reference sheet's resource nodes, a tile's
 * worth at a time.
 */
function paintResource(fill: string, bucket: number): void {
  const alpha = TINT_ALPHA[bucket] ?? TINT_ALPHA[TINT_ALPHA.length - 1] ?? 1;
  const previousAlpha = C.globalAlpha;
  C.globalAlpha = previousAlpha * alpha;
  groundFacePath(C, OX, OY, 1, 1, Z);
  C.fillStyle = fill;
  C.fill();
  C.strokeStyle = fill;
  C.lineWidth = 1;
  C.stroke();
  C.globalAlpha = previousAlpha;

  if (0.15 * EX < MIN_ROCK_PX) return;

  // A dark ore needs its top lifted further to read at all: coal at 1.2 is
  // still black.
  const dark = isDark(fill);
  const top = shade(fill, dark ? 2 : 1.18);
  const face = shade(fill, dark ? 1.2 : 0.68);
  for (let i = 0; i <= bucket; i++) {
    const rock = ROCKS[i];
    if (rock === undefined) continue;
    paintRock(rock[0], rock[1], rock[2], top, face);
  }
}

/** A lump of rock: a front face and an irregular lit top. */
function paintRock(u: number, v: number, s: number, top: string, face: string): void {
  const h = s * 1.1;
  C.beginPath();
  C.moveTo(X(u - s, v), Y(u - s, v, 0));
  C.lineTo(X(u + s, v), Y(u + s, v, 0));
  C.lineTo(X(u + s * 0.8, v), Y(u + s * 0.8, v, h));
  C.lineTo(X(u - s * 0.8, v), Y(u - s * 0.8, v, h));
  C.closePath();
  paint(face);
  C.beginPath();
  C.moveTo(X(u - s * 0.8, v), Y(u - s * 0.8, v, h));
  C.lineTo(X(u - s * 0.9, v - s * 0.7), Y(u - s * 0.9, v - s * 0.7, h));
  C.lineTo(X(u - s * 0.2, v - s * 1.05), Y(u - s * 0.2, v - s * 1.05, h));
  C.lineTo(X(u + s * 0.75, v - s * 0.8), Y(u + s * 0.75, v - s * 0.8, h));
  C.lineTo(X(u + s * 0.8, v), Y(u + s * 0.8, v, h));
  C.closePath();
  paint(top);
}

function isDark(hex: string): boolean {
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isFinite(value)) return false;
  return ((value >> 16) & 0xff) + ((value >> 8) & 0xff) + (value & 0xff) < 200;
}

/* -------------------------------------------------------------------------- *
 * Machines
 * -------------------------------------------------------------------------- */

interface Machine {
  readonly fill: string;
  readonly code: string;
  readonly width: number;
  readonly height: number;
  readonly bulk: number;
  readonly frame?: number;
}

/** Plinth height, in bulk units: the dark base every building stands on. */
const PLINTH = 0.15;

/**
 * A building, by its two-letter code.
 *
 * Per-building drawing is the one place a per-building case is right: §19
 * rule 17 forbids it in *systems*, and a picture is not a rule of the game.
 * Every building still reads its size and bulk off the id, so a 2x2 assembler
 * would be drawn at 2x2, and an unknown code falls back to a generic machine
 * with its code on the roof — a content addition shows up as a labelled box
 * rather than as nothing.
 */
function paintMachine(machine: Machine): void {
  const hw = machine.width / 2;
  const hh = machine.height / 2;
  shadowBox(-hw + 0.04, -hh + 0.04, hw - 0.04, hh - 0.04, machine.bulk * 0.8);
  // The category colour is the trim. A tier-2 building (`M2`, `A2`) takes a
  // lighter tone of it: near enough to say "that is a miner", far enough to
  // say "not the same miner" — the rule §11's palette comment gives the items.
  const trim = machine.code.endsWith('2') ? shade(machine.fill, 1.25) : machine.fill;
  const frame = machine.frame ?? 0;

  switch (machine.code) {
    case 'MI':
    case 'M2':
      paintMiner(hw, hh, machine.bulk, trim, frame);
      return;
    case 'FU':
      paintFurnace(hw, hh, machine.bulk, trim, frame, false);
      return;
    case 'EF':
      paintFurnace(hw, hh, machine.bulk, trim, frame, true);
      return;
    case 'AS':
    case 'A2':
      paintAssembler(hw, hh, machine.bulk, trim, frame);
      return;
    case 'CH':
      paintChest(hw, hh, machine.bulk);
      return;
    case 'GE':
      paintGenerator(hw, hh, machine.bulk, trim, frame);
      return;
    case 'PP':
      paintPole(machine.bulk);
      return;
    case 'LA':
      paintLab(hw, hh, machine.bulk, trim, frame);
      return;
    case 'RA':
      paintRadar(hw, hh, machine.bulk, trim, frame);
      return;
    default:
      paintGenericMachine(hw, hh, machine.bulk, trim, machine.code, Math.min(machine.width, machine.height));
      return;
  }
}

function plinth(hw: number, hh: number): void {
  box(-hw + 0.04, -hh + 0.04, hw - 0.04, hh - 0.04, 0, PLINTH, color('panel-high'));
}

/** A steel body with a trim-coloured roof and its code. Anything not drawn below. */
function paintGenericMachine(hw: number, hh: number, bulk: number, trim: string, code: string, scale: number): void {
  plinth(hw, hh);
  box(-hw + 0.14, -hh + 0.14, hw - 0.14, hh - 0.1, PLINTH, bulk * 0.82, color('steel'));
  box(-hw + 0.26, -hh + 0.26, hw - 0.26, hh - 0.3, bulk * 0.82, bulk, trim);
  label(code, 0, -0.1, bulk, scale);
}

/** How far a working drill head rises on each frame, in bulk units. */
const DRILL_BOB: readonly number[] = Object.freeze([0, 0.18, 0.34, 0.18]);

/**
 * A miner: a housing at the back, an engine at the front, and a drill rig
 * whose head rises and falls while it works (C29 art task 3).
 */
function paintMiner(hw: number, hh: number, bulk: number, trim: string, frame: number): void {
  plinth(hw, hh);
  box(-hw + 0.18, -hh + 0.14, hw - 0.18, -0.1, PLINTH, bulk * 0.55, color('steel'));
  if (DETAIL) topPanel(-hw + 0.34, -hh + 0.28, hw - 0.34, -0.3, bulk * 0.55, shade(color('steel'), 0.85));

  // The rig: two posts and a beam, trim-coloured, over a dark pit.
  const bob = DRILL_BOB[frame % DRILL_BOB.length] ?? 0;
  topPanel(-0.32, -0.02, 0.32, 0.5, PLINTH, color('bg-deep'));
  box(-0.4, 0.02, -0.28, 0.14, PLINTH, bulk * 0.95, trim);
  box(0.28, 0.02, 0.4, 0.14, PLINTH, bulk * 0.95, trim);
  box(-0.4, 0.02, 0.4, 0.14, bulk * 0.85, bulk * 0.95, trim);
  // The drill head, riding up and down the posts, and its bit.
  const head = PLINTH + 0.25 + bob;
  if (DETAIL) strut(0, 0.26, PLINTH, 0, 0.26, head, 0.07, color('steel'));
  box(-0.2, 0.12, 0.2, 0.4, head, head + 0.4, color('panel-high'), shade(color('steel'), 0.9));

  // The engine block in front, with a trim stripe.
  box(-hw + 0.18, 0.42, -0.5, hh - 0.12, PLINTH, bulk * 0.45, color('steel'));
  box(0.5, 0.42, hw - 0.18, hh - 0.12, PLINTH, bulk * 0.45, color('steel'));
  if (DETAIL) {
    facePanel(-hw + 0.26, -0.58, hh - 0.12, PLINTH + 0.25, PLINTH + 0.4, trim);
    facePanel(0.58, hw - 0.26, hh - 0.12, PLINTH + 0.25, PLINTH + 0.4, trim);
  }
}

/** A lit furnace mouth's colour per frame. Frame 0 is cold. */
function glow(frame: number, electric: boolean): string {
  if (frame === 0) return color('panel');
  if (electric) return frame === 2 ? color('blue-high') : shade(color('blue-high'), 1.2);
  return frame === 2 ? color('accent-high') : frame === 3 ? color('warn') : color('accent');
}

/**
 * A furnace: a steel body with a mouth that glows while it smelts, and a
 * chimney — or, for the electric one, a coil where the chimney would be.
 */
function paintFurnace(hw: number, hh: number, bulk: number, trim: string, frame: number, electric: boolean): void {
  plinth(hw, hh);
  const top = bulk * 0.62;
  // The chimney stands at the back, so it is drawn before the body in front of it.
  if (electric) {
    box(-hw + 0.16, -hh + 0.14, hw - 0.16, hh - 0.14, PLINTH, top, color('steel'));
    cylinder(0.28, -0.3, 0.3, top, top + 0.3, color('blue'), color('blue-high'));
    if (DETAIL) disc(0.28, -0.3, 0.14, top + 0.3, frame === 0 ? color('panel') : color('blue-high'), false);
  } else {
    cylinder(0.5, -0.5, 0.22, PLINTH, bulk, color('steel'));
    if (DETAIL) disc(0.5, -0.5, 0.14, bulk, color('bg-deep'), false);
    box(-hw + 0.16, -hh + 0.14, hw - 0.16, hh - 0.14, PLINTH, top, color('steel'));
    // The chimney's top half shows over the roof.
    cylinder(0.5, -0.5, 0.22, top, bulk, color('steel'));
    disc(0.5, -0.5, 0.14, bulk, color('bg-deep'), false);
    if (DETAIL) box(0.28, -0.72, 0.72, -0.28, bulk * 0.78, bulk * 0.84, trim);
  }
  // Roof hatch in the trim colour.
  topPanel(-0.62, -0.62, 0.05, 0.05, top, trim);
  // The mouth, and a sill under it.
  facePanel(-0.5, 0.5, hh - 0.14, PLINTH + 0.1, top - 0.2, color('panel-high'));
  facePanel(-0.4, 0.4, hh - 0.14, PLINTH + 0.16, top - 0.28, glow(frame, electric));
  if (DETAIL && frame !== 0) {
    // Heat on the ground in front of a working mouth.
    const previousAlpha = C.globalAlpha;
    C.globalAlpha = previousAlpha * 0.35;
    topPanel(-0.4, hh - 0.14, 0.4, hh - 0.04, 0, glow(frame, electric));
    C.globalAlpha = previousAlpha;
  }
}

/** Gear teeth, and how far a working gear turns per frame as a fraction of one. */
const GEAR_TEETH = 8;

/** A gear lying flat at height `h`, turned by `turn` teeth. */
function gear(u: number, v: number, r: number, h: number, turn: number, fill: string): void {
  const x = X(u, v);
  const y = Y(u, v, h);
  const outer = r * EX;
  const inner = outer * 0.74;
  const step = (Math.PI * 2) / GEAR_TEETH;
  const offset = turn * step;
  C.beginPath();
  for (let i = 0; i < GEAR_TEETH; i++) {
    const a = offset + i * step;
    C.lineTo(x + Math.cos(a - step * 0.28) * inner, y + Math.sin(a - step * 0.28) * inner);
    C.lineTo(x + Math.cos(a - step * 0.16) * outer, y + Math.sin(a - step * 0.16) * outer);
    C.lineTo(x + Math.cos(a + step * 0.16) * outer, y + Math.sin(a + step * 0.16) * outer);
    C.lineTo(x + Math.cos(a + step * 0.28) * inner, y + Math.sin(a + step * 0.28) * inner);
  }
  C.closePath();
  paint(fill);
  C.beginPath();
  C.arc(x, y, outer * 0.3, 0, Math.PI * 2);
  paint(color('bg-deep'), false);
}

/**
 * An assembler: a big steel block, trim stripes on its face, and a gear on the
 * roof that turns a third of a tooth per frame while it builds.
 */
function paintAssembler(hw: number, hh: number, bulk: number, trim: string, frame: number): void {
  plinth(hw, hh);
  const top = bulk * 0.65;
  // A vent stack at the back corner.
  cylinder(hw - 0.4, -hh + 0.42, 0.16, PLINTH, bulk, color('steel'));
  box(-hw + 0.14, -hh + 0.2, hw - 0.14, hh - 0.14, PLINTH, top, color('steel'));
  cylinder(hw - 0.4, -hh + 0.42, 0.16, top, bulk, color('steel'), color('bg-deep'));
  // The roof machinery.
  box(-hw + 0.4, -hh + 0.44, hw - 0.7, hh - 0.5, top, top + 0.18, color('panel-high'));
  gear(-0.15, -0.1, Math.min(hw, hh) * 0.5, top + 0.18, frame / 3, trim);
  // Face: two trim stripes and a door.
  if (DETAIL) {
    facePanel(-hw + 0.28, -hw + 0.52, hh - 0.14, PLINTH + 0.1, top - 0.12, trim);
    facePanel(hw - 0.52, hw - 0.28, hh - 0.14, PLINTH + 0.1, top - 0.12, trim);
  }
  facePanel(-0.42, 0.42, hh - 0.14, PLINTH, top - 0.4, color('panel-high'));
  if (frame !== 0) facePanel(-0.3, 0.3, hh - 0.14, top - 0.36, top - 0.28, color('ok'));
}

/** A storage chest: a steel crate under a lighter lid, banded, with a latch. */
function paintChest(hw: number, hh: number, bulk: number): void {
  const w = hw - 0.1;
  const d = hh - 0.1;
  shadowBox(-w, -d, w, d, bulk * 0.2);
  box(-w, -d, w, d, 0, bulk * 0.7, color('steel'));
  box(-w - 0.03, -d - 0.03, w + 0.03, d + 0.03, bulk * 0.7, bulk * 0.9, shade(color('steel'), 1.12));
  if (!DETAIL) return;
  // Corner posts and a band across the face; one band over the lid.
  facePanel(-w, -w + 0.07, d, 0, bulk * 0.7, color('panel-high'));
  facePanel(w - 0.07, w, d, 0, bulk * 0.7, color('panel-high'));
  facePanel(-w, w, d, bulk * 0.28, bulk * 0.38, color('panel-high'));
  topPanel(-w + 0.08, -d + 0.08, w - 0.08, d - 0.08, bulk * 0.9, color('steel'));
  facePanel(-0.07, 0.07, d + 0.03, bulk * 0.72, bulk * 0.86, color('accent'));
}

/**
 * A generator: a boiler house with two banded tanks and a tall stack. Its
 * firebox glows while it burns.
 */
function paintGenerator(hw: number, hh: number, bulk: number, trim: string, frame: number): void {
  plinth(hw, hh);
  const top = bulk * 0.42;
  // The stack at the back, full height.
  cylinder(hw - 0.55, -hh + 0.55, 0.3, PLINTH, bulk, color('steel'));
  box(-hw + 0.14, -hh + 0.2, hw - 0.14, hh - 0.14, PLINTH, top, color('steel'));
  cylinder(hw - 0.55, -hh + 0.55, 0.3, top, bulk, color('steel'), color('bg-deep'));
  if (DETAIL) cylinder(hw - 0.55, -hh + 0.55, 0.31, bulk * 0.7, bulk * 0.78, trim);
  // Two tanks on the roof, banded in the trim colour.
  for (const u of [-0.75, 0.05]) {
    cylinder(u, -0.3, 0.34, top, top + 0.75, color('steel'));
    if (DETAIL) cylinder(u, -0.3, 0.35, top + 0.3, top + 0.42, trim);
    disc(u, -0.3, 0.34, top + 0.75, shade(color('steel'), 1.1));
  }
  // The firebox.
  facePanel(-0.9, 0.9, hh - 0.14, PLINTH + 0.08, top - 0.1, color('panel-high'));
  facePanel(-0.75, 0.75, hh - 0.14, PLINTH + 0.14, top - 0.16, glow(frame, false));
}

/** A power pole: a post, a crossbar and two insulators. */
function paintPole(bulk: number): void {
  shadowBox(-0.07, -0.07, 0.07, 0.07, bulk * 0.9);
  box(-0.16, -0.16, 0.16, 0.16, 0, 0.12, color('panel-high'));
  box(-0.07, -0.07, 0.07, 0.07, 0.12, bulk * 0.92, color('steel'));
  box(-0.38, -0.06, 0.38, 0.06, bulk * 0.8, bulk * 0.86, color('panel-high'));
  box(-0.36, -0.05, -0.26, 0.05, bulk * 0.86, bulk * 0.96, color('accent'));
  box(0.26, -0.05, 0.36, 0.05, bulk * 0.86, bulk * 0.96, color('accent'));
}

/** A lab: a steel base under a glass dome that lights up while it researches. */
function paintLab(hw: number, hh: number, bulk: number, trim: string, frame: number): void {
  plinth(hw, hh);
  const top = bulk * 0.36;
  box(-hw + 0.14, -hh + 0.14, hw - 0.14, hh - 0.14, PLINTH, top, color('steel'));
  if (DETAIL) {
    facePanel(-hw + 0.3, -hw + 0.55, hh - 0.14, PLINTH + 0.08, top - 0.1, trim);
    facePanel(hw - 0.55, hw - 0.3, hh - 0.14, PLINTH + 0.08, top - 0.1, trim);
  }
  // An antenna at the back corner.
  box(hw - 0.42, -hh + 0.3, hw - 0.3, -hh + 0.42, top, bulk, color('panel-high'));
  disc(hw - 0.36, -hh + 0.36, 0.08, bulk, trim);
  // The dome: a ring, then a lit cap.
  const lit = frame !== 0;
  const glass = lit ? color('data_core') : color('blue');
  cylinder(0, -0.05, 0.95, top, top + 0.35, color('panel-high'));
  cylinder(0, -0.05, 0.82, top + 0.35, top + 0.85, glass, shade(glass, lit ? 1.15 : 1));
  if (DETAIL) {
    const previousAlpha = C.globalAlpha;
    C.globalAlpha = previousAlpha * 0.5;
    disc(-0.28, -0.3, 0.2, top + 0.85, color('text'), false);
    C.globalAlpha = previousAlpha;
  }
}

/** How far the dish has turned on each frame, in radians. */
const DISH_TURN: readonly number[] = Object.freeze([0, (Math.PI * 2) / 3, (Math.PI * 4) / 3, 0]);

/** A radar: a housing, a mast, and a dish that turns while it sweeps. */
function paintRadar(hw: number, hh: number, bulk: number, trim: string, frame: number): void {
  plinth(hw, hh);
  box(-hw + 0.2, -hh + 0.2, hw - 0.2, hh - 0.16, PLINTH, bulk * 0.28, color('steel'));
  if (DETAIL) facePanel(-0.5, 0.5, hh - 0.16, PLINTH + 0.1, bulk * 0.22, trim);
  cylinder(0, -0.05, 0.13, bulk * 0.28, bulk * 0.68, color('panel-high'));

  // The dish: an ellipse whose width follows the turn, so a sweep reads.
  const angle = frame === 0 ? 0 : (DISH_TURN[frame % DISH_TURN.length] ?? 0);
  const x = X(0, -0.05);
  const y = Y(0, -0.05, bulk * 0.82);
  const rx = Math.max(0.25, Math.abs(Math.cos(angle))) * 0.78 * EX;
  const ry = 0.5 * EX;
  C.beginPath();
  C.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  paint(shade(color('steel'), 1.08));
  if (DETAIL) {
    C.beginPath();
    C.ellipse(x, y, rx * 0.72, ry * 0.72, 0, 0, Math.PI * 2);
    paint(shade(color('steel'), 0.8), false);
  }
  C.beginPath();
  C.moveTo(x, y);
  C.lineTo(x + Math.sin(angle) * rx * 0.4, y - ry * 0.55);
  C.strokeStyle = trim;
  C.lineWidth = Math.max(1, 0.05 * EX);
  C.stroke();
}

/* -------------------------------------------------------------------------- *
 * Belts
 * -------------------------------------------------------------------------- */

/**
 * A point along a lane, in tile space: `a` along the flow, `c` across it, and
 * the lane itself `across` tiles to the side. Written into two scratch numbers
 * rather than returned, because a belt is drawn by the thousand.
 */
let LU = 0;
let LV = 0;
function lanePoint(rotation: Rotation, a: number, c: number): void {
  const forward = DIRECTION_OFFSETS[rotation];
  const side = DIRECTION_OFFSETS[(rotation + 1) % 4];
  if (forward === undefined || side === undefined) return;
  LU = forward.x * a + side.x * c;
  LV = forward.y * a + side.y * c;
}

/** Stroke a line across or along a lane at height `h`. */
function laneLine(rotation: Rotation, a0: number, c0: number, a1: number, c1: number, h = 0): void {
  lanePoint(rotation, a0, c0);
  C.moveTo(X(LU, LV), Y(LU, LV, h));
  lanePoint(rotation, a1, c1);
  C.lineTo(X(LU, LV), Y(LU, LV, h));
}

/** The axis-aligned tile-space rectangle covering a lane-space one. */
function laneRect(rotation: Rotation, a0: number, a1: number, c0: number, c1: number): [number, number, number, number] {
  lanePoint(rotation, a0, c0);
  const u0 = LU;
  const v0 = LV;
  lanePoint(rotation, a1, c1);
  return [Math.min(u0, LU), Math.min(v0, LV), Math.max(u0, LU), Math.max(v0, LV)];
}

/** Slats per tile. Their spacing divides the tile, so the pattern tiles. */
const SLATS = 4;

/** How far a splitter's housing and a tunnel mouth's hood rise above the tread, in bulk units. */
export const SPLITTER_HOUSING = 0.32;
export const TUNNEL_HOOD = 0.2;

/** How wide the frame's edge is either side of the tread, in tiles. */
const BELT_EDGE = 0.07;

/** A box's near face and top with no outline, so tiles of one belt join without a seam. */
function slab(u0: number, v0: number, u1: number, v1: number, h0: number, h1: number, face: string, top: string): void {
  faceQuad(u0, u1, v1, h0, h1);
  paint(face, false);
  topQuad(u0, v0, u1, v1, h1);
  paint(top, false);
}

/**
 * A belt tile's shadow: its footprint pushed south-east, but only across the
 * flow. `shadowBox`'s hull would reach into the next tile along, and two
 * translucent shadows overlapping there would notch a line of belts at every
 * seam.
 */
function laneShadow(rotation: Rotation, u0: number, v0: number, u1: number, v1: number): void {
  const d = BELT_DECK * RISE * SHADOW_SLANT;
  const alongU = rotation === 1 || rotation === 3;
  const dx = alongU ? 0 : d;
  const dy = alongU ? d : 0;
  C.beginPath();
  C.moveTo(X(u0, v0) + dx, Y(u0, v0, 0) + dy);
  C.lineTo(X(u1, v0) + dx, Y(u1, v0, 0) + dy);
  C.lineTo(X(u1, v1) + dx, Y(u1, v1, 0) + dy);
  C.lineTo(X(u0, v1) + dx, Y(u0, v1, 0) + dy);
  C.closePath();
  const previousAlpha = C.globalAlpha;
  C.globalAlpha = previousAlpha * SHADOW_ALPHA;
  C.fillStyle = color('bg-deep');
  C.fill();
  C.globalAlpha = previousAlpha;
}

/**
 * One lane of belt, `across` tiles to the side of the anchor.
 *
 * Raised since 2026-09-23: the whole belt is a steel body standing
 * `BELT_DECK` off the ground, with the tread flush on top of it. It had side
 * rails for an hour, which read as a wall where another belt joined from the
 * side, so the height is in the body now and the top is open on every side.
 * The tread has a lighter middle band and slats drawn as ridges (a lit line
 * and its shadow); a thin lit lip along each side of the top is what makes the
 * body read as raised. Nothing is outlined per tile, so a line of belts reads
 * as one conveyor. Only near faces are drawn, as for every box here: the next
 * tile along covers the end face of the one before it.
 *
 * The slats are the animation — the reference sheet's belts are a tread, not
 * an arrow — and the chevron stays because a still belt (below `DETAIL_ZOOM`,
 * or a ghost) has to say which way it runs too (pillar 3).
 */
function lane(rotation: Rotation, phase: number, across: number, joined = 0): void {
  const body = shade(color('blue'), 0.55);
  const [f0, g0, f1, g1] = laneRect(rotation, -0.5, 0.5, across - 0.5, across + 0.5);
  laneShadow(rotation, f0, g0, f1, g1);
  slab(f0, g0, f1, g1, 0, BELT_DECK, shade(body, 0.6), body);

  // The tread, inside the frame's edge: dark at the sides, lighter down the
  // middle, so it reads as a band over rollers rather than a painted strip.
  const inner = 0.5 - BELT_EDGE;
  const tread = shade(color('panel'), 0.8);
  const [t0, s0, t1, s1] = laneRect(rotation, -0.5, 0.5, across - inner, across + inner);
  topQuad(t0, s0, t1, s1, BELT_DECK);
  paint(tread, false);
  const [m0, n0, m1, n1] = laneRect(rotation, -0.5, 0.5, across - inner * 0.55, across + inner * 0.55);
  topQuad(m0, n0, m1, n1, BELT_DECK);
  paint(shade(tread, 1.18), false);

  if (DETAIL) {
    // Slats as ridges: a lit edge and, just behind it, its shadow.
    const slide = (phase / BELT_CHEVRON_PHASES) / SLATS;
    const width = Math.max(1, 0.045 * EX);
    for (const [offset, tone] of [
      [0.035, color('bg-deep')],
      [0, shade(color('panel-high'), 1.45)],
    ] as const) {
      C.beginPath();
      for (let i = 0; i < SLATS; i++) {
        // Wrapped, so the slat sliding off the front edge comes back at the rear.
        const a = Math.min(0.5, (((i + 0.5) / SLATS + slide) % 1) - 0.5 + offset);
        laneLine(rotation, a, across - inner + 0.03, a, across + inner - 0.03, BELT_DECK);
      }
      C.strokeStyle = tone;
      C.lineWidth = width;
      C.stroke();
    }

    // The lip: a lit line along each side of the top, except a side another
    // belt feeds in from (`joined`, bit 1 left, bit 2 right).
    C.beginPath();
    if ((joined & 1) === 0) laneLine(rotation, -0.5, across - 0.5 + BELT_EDGE / 2, 0.5, across - 0.5 + BELT_EDGE / 2, BELT_DECK);
    if ((joined & 2) === 0) laneLine(rotation, -0.5, across + 0.5 - BELT_EDGE / 2, 0.5, across + 0.5 - BELT_EDGE / 2, BELT_DECK);
    C.strokeStyle = color('blue-high');
    C.lineWidth = Math.max(1, 0.035 * EX);
    C.stroke();
  }

  C.beginPath();
  laneLine(rotation, -0.08, across - 0.16, 0.1, across, BELT_DECK);
  lanePoint(rotation, -0.08, across + 0.16);
  C.lineTo(X(LU, LV), Y(LU, LV, BELT_DECK));
  C.strokeStyle = color('accent');
  C.lineWidth = Math.max(1, 0.06 * EX);
  C.stroke();
}

function paintBelt(rotation: Rotation, phase: number, joined: number): void {
  lane(rotation, phase, 0, joined);
}

/**
 * A splitter: one plate two tiles across the flow, a lane through each half,
 * and a housing over the middle where the decision is made (C17 task 4).
 *
 * The footprint is implied by the facing, as it always was: two tiles across
 * the flow and one deep.
 */
function paintSplitter(rotation: Rotation, phase: number): void {
  lane(rotation, phase, -0.5);
  lane(rotation, phase, 0.5);

  const top = BELT_DECK + SPLITTER_HOUSING;
  const [u0, v0, u1, v1] = laneRect(rotation, -0.16, 0.16, -0.98, 0.98);
  box(u0, v0, u1, v1, 0, top, color('panel-high'), shade(color('blue'), 0.9));
  if (DETAIL) {
    const [a0, b0, a1, b1] = laneRect(rotation, -0.05, 0.05, -0.7, 0.7);
    topPanel(a0, b0, a1, b1, top, color('blue-high'));
  }
}

/**
 * One mouth of an underground run: a belt plate running into a hood.
 *
 * Which end the hood is at is the one thing that makes the two mouths
 * different pictures (C23): an entrance swallows items, so its hood is ahead
 * of the flow; an exit spits them out, so its hood is behind it. There is
 * deliberately no moving tread: what is moving is underground.
 */
function paintUnderground(rotation: Rotation, entrance: boolean): void {
  lane(rotation, 0, 0);

  const sign = entrance ? 1 : -1;
  // The dark opening, then the hood over its outer part.
  const [h0, i0, h1, i1] = laneRect(rotation, sign * 0.02, sign * 0.5, -0.38, 0.38);
  topQuad(h0, i0, h1, i1, BELT_DECK);
  paint(color('bg-deep'), false);
  const [u0, v0, u1, v1] = laneRect(rotation, sign * 0.2, sign * 0.5, -0.44, 0.44);
  box(u0, v0, u1, v1, 0, BELT_DECK + TUNNEL_HOOD, color('underground_belt'), shade(color('underground_belt'), 1.3));
  if (DETAIL) {
    const [s0, t0, s1, t1] = laneRect(rotation, sign * 0.3, sign * 0.4, -0.3, 0.3);
    topPanel(s0, t0, s1, t1, BELT_DECK + TUNNEL_HOOD, color('accent'));
  }
}

/* -------------------------------------------------------------------------- *
 * Inserters
 * -------------------------------------------------------------------------- */

/** Where the shoulder sits, in bulk units. */
const SHOULDER = 0.42;
/** How far the hand reaches from the base, in tiles, at each end of the sweep. */
const ARM_REACH = 0.52;
/** How high the hand is carried at the middle of the sweep, in bulk units. */
const ARM_LIFT = 0.9;

/**
 * An inserter: a dark base, an orange turret, a two-part arm and a claw.
 *
 * The sweep is an arc, as it has been since C14: along the facing axis by
 * `cos`, up by `sin`, so the hand is over the source at one end, over the
 * destination at the other, and raised clear of the base in between. The
 * elbow rides above both ends, which is what makes it read as an arm and not
 * a stick.
 */
function paintInserter(rotation: Rotation, swing: number, holding: boolean): void {
  const forward = DIRECTION_OFFSETS[rotation];
  if (forward === undefined) return;

  shadowBox(-0.2, -0.2, 0.2, 0.2, 0.4);
  box(-0.22, -0.22, 0.22, 0.22, 0, 0.16, color('panel-high'));
  cylinder(0, 0, 0.13, 0.16, SHOULDER, color('accent'));

  const angle = Math.PI * (1 - swing / INSERTER_SWING_STEPS);
  const along = Math.cos(angle) * ARM_REACH;
  const hu = forward.x * along;
  const hv = forward.y * along;
  const handH = SHOULDER + Math.sin(angle) * ARM_LIFT;
  const eu = hu * 0.45;
  const ev = hv * 0.45;
  const elbowH = Math.max(SHOULDER, handH) + 0.45;

  strut(0, 0, SHOULDER, eu, ev, elbowH, 0.09, color('accent-high'));
  strut(eu, ev, elbowH, hu, hv, handH, 0.07, color('accent'));
  if (DETAIL) disc(eu, ev, 0.05, elbowH, color('panel-high'), false);

  // The claw, and what is in it.
  if (holding) box(hu - 0.08, hv - 0.08, hu + 0.08, hv + 0.08, handH - 0.34, handH - 0.16, color('steel'));
  box(hu - 0.07, hv - 0.07, hu + 0.07, hv + 0.07, handH - 0.16, handH, color('blue-high'));
}

/* -------------------------------------------------------------------------- *
 * Items
 * -------------------------------------------------------------------------- */

/** Half an item's width, in tiles. Four fit along a tile (§9). */
const ITEM_HALF = 0.14;

/**
 * One item, sitting on whatever it rides.
 *
 * Its shape says what kind of thing it is and its colour says what it is made
 * of — ore is a rock, a plate is a slab, a gear is a gear — so a mixed belt
 * reads by silhouette as well as by colour, which is also what makes it
 * readable to a player who cannot tell the colours apart (C30).
 */
function paintItem(fill: string, shape: ItemShape): void {
  // Every item drawn is riding a belt, a splitter or a tunnel mouth, so it
  // sits on the tread (2026-09-23): the whole drawing moves up by the deck.
  const lift = BELT_DECK * RISE;
  OY -= lift;
  paintItemShape(fill, shape);
  OY += lift;
}

function paintItemShape(fill: string, shape: ItemShape): void {
  const s = ITEM_HALF;
  const lift = shape === 'plate' || shape === 'chip' ? 0.08 : 0.24;
  shadowBox(-s, -s, s, s, lift);

  if (!DETAIL) {
    box(-s, -s, s, s, 0, lift, fill);
    return;
  }

  switch (shape) {
    case 'lump': {
      const dark = isDark(fill);
      paintRock(0, s * 0.7, s * 1.05, shade(fill, dark ? 2 : 1.2), shade(fill, dark ? 1.2 : 0.7));
      return;
    }
    case 'plate':
      box(-s, -s * 0.9, s, s * 0.9, 0, 0.08, fill, shade(fill, 1.1));
      return;
    case 'ingot':
      box(-s, -s * 0.6, s, s * 0.6, 0, 0.22, fill, shade(fill, 1.12));
      return;
    case 'gear':
      cylinder(0, 0, s * 0.9, 0, 0.08, fill);
      gear(0, 0, s * 1.05, 0.12, 0, fill);
      return;
    case 'coil':
      cylinder(0, 0, s * 0.95, 0, 0.2, fill);
      disc(0, 0, s * 0.45, 0.2, shade(fill, 0.55), false);
      return;
    case 'chip':
      box(-s, -s * 0.8, s, s * 0.8, 0, 0.08, fill);
      topPanel(-s * 0.6, -s * 0.4, s * 0.6, -s * 0.2, 0.08, color('warn'));
      topPanel(-s * 0.6, s * 0.1, s * 0.6, s * 0.3, 0.08, color('warn'));
      return;
    case 'core':
      C.beginPath();
      C.moveTo(X(0, -s), Y(0, -s, 0.25));
      C.lineTo(X(s, 0), Y(s, 0, 0.12));
      C.lineTo(X(0, s), Y(0, s, 0));
      C.lineTo(X(-s, 0), Y(-s, 0, 0.12));
      C.closePath();
      paint(shade(fill, 1.1));
      disc(0, 0, s * 0.3, 0.14, color('text'), false);
      return;
    case 'crate':
      box(-s, -s * 0.9, s, s * 0.9, 0, 0.24, color('steel'), shade(color('steel'), 1.08));
      topPanel(-s * 0.55, -s * 0.9, s * 0.55, s * 0.9, 0.24, fill);
      return;
  }
}

/* -------------------------------------------------------------------------- *
 * The player
 * -------------------------------------------------------------------------- */

/**
 * The figure is drawn in its own units and scaled about its anchor by this.
 * The reference sheet's worker stands about half as tall as a furnace; at 1
 * it stood a third as tall and read as a marker rather than as a person.
 */
const PLAYER_SCALE = 1.3;

/** How far each leg is stepped forward per walk frame, in tiles. */
const STRIDE: readonly number[] = Object.freeze([0, 0.08, 0, -0.08]);
/** The idle breath, in bulk units. */
const BREATH: readonly number[] = Object.freeze([0, 0.02, 0.035, 0.02]);
/** The pick's angle per work frame, in radians above the horizontal. */
const SWING: readonly number[] = Object.freeze([0.2, 1.1, 1.4, -0.3]);

/**
 * The worker: orange helmet, dark suit, backpack — the reference sheet's
 * character — in three activities with four frames each (C29 art task 3).
 *
 * Which way they face is still the thing read most often, so it is carried
 * three ways: the visor shows on the side they look to, the backpack on the
 * side they turn from, and walking steps along the facing axis.
 */
function paintPlayer(activity: PlayerActivity, facing: Rotation, frame: number): void {
  const forward = DIRECTION_OFFSETS[facing];
  const side = DIRECTION_OFFSETS[(facing + 1) % 4];
  if (forward === undefined || side === undefined) return;
  // Scaling the pen's basis scales every point about the anchor, shadow and
  // all, which is the whole of what `PLAYER_SCALE` needs. `begin` resets it.
  EX *= PLAYER_SCALE;
  EY *= PLAYER_SCALE;
  GX *= PLAYER_SCALE;
  GY *= PLAYER_SCALE;
  RISE *= PLAYER_SCALE;
  const f = frame % 4;
  const bob = activity === 'idle' ? (BREATH[f] ?? 0) : activity === 'walk' && f % 2 === 1 ? 0.04 : 0;
  const crouch = activity === 'work' ? 0.82 : 1;

  // Shadow: an ellipse on the ground, south-east of the feet.
  const d = 0.9 * RISE * SHADOW_SLANT;
  const previousAlpha = C.globalAlpha;
  C.globalAlpha = previousAlpha * SHADOW_ALPHA;
  C.beginPath();
  C.ellipse(X(0, 0) + d, Y(0, 0, 0) + d * 0.5, 0.2 * EX, 0.13 * EX, 0, 0, Math.PI * 2);
  C.fillStyle = color('bg-deep');
  C.fill();
  C.globalAlpha = previousAlpha;

  const suit = color('text-dim');
  const ns = forward.x === 0; // facing north or south: the body is wide on u
  const bw = ns ? 0.13 : 0.08;
  const bd = ns ? 0.08 : 0.13;
  const stride = activity === 'walk' ? (STRIDE[f] ?? 0) : 0;
  const legTop = 0.42 * crouch;

  // Legs, the one further north first.
  const legs: [number, number][] = [
    [side.x * 0.06 + forward.x * stride, side.y * 0.06 + forward.y * stride],
    [0 - side.x * 0.06 - forward.x * stride, 0 - side.y * 0.06 - forward.y * stride],
  ];
  legs.sort((a, b) => a[1] - b[1]);
  for (const [lu, lv] of legs) box(lu - 0.045, lv - 0.045, lu + 0.045, lv + 0.045, 0, legTop, color('panel-high'));

  // The backpack is behind them: north of the body when they face south.
  const pack = (): void => {
    const pu = 0 - forward.x * (bd + 0.05);
    const pv = 0 - forward.y * (bd + 0.05);
    box(pu - 0.09, pv - 0.06, pu + 0.09, pv + 0.06, legTop + 0.1 + bob, legTop + 0.48 + bob, color('panel-high'));
  };
  if (forward.y > 0 || forward.x !== 0) pack();

  // Torso, with an orange chest stripe on the side facing the camera.
  const torsoTop = legTop + 0.55 * crouch + bob;
  box(-bw, -bd, bw, bd, legTop, torsoTop, suit);
  if (DETAIL) facePanel(-bw, bw, bd, torsoTop - 0.2, torsoTop - 0.1, color('accent'));
  if (forward.y < 0) pack();

  // Arms: at the sides, or swinging a pick.
  const handU = forward.x * 0.1 + side.x * (bw + 0.04);
  const handV = forward.y * 0.1 + side.y * (bw + 0.04);
  if (activity === 'work') {
    const lift = SWING[f] ?? 0;
    const tipH = torsoTop - 0.1 + Math.sin(lift) * 0.5;
    const reach = 0.12 + Math.cos(lift) * 0.22;
    strut(handU, handV, torsoTop - 0.15, forward.x * reach, forward.y * reach, tipH, 0.035, color('steel'));
    box(forward.x * reach - 0.05, forward.y * reach - 0.05, forward.x * reach + 0.05, forward.y * reach + 0.05, tipH - 0.06, tipH + 0.04, color('accent'));
  } else if (DETAIL) {
    const swingArm = activity === 'walk' ? (STRIDE[f] ?? 0) : 0;
    strut(side.x * (bw + 0.02) - forward.x * swingArm, side.y * (bw + 0.02) - forward.y * swingArm, torsoTop - 0.05,
      side.x * (bw + 0.03) + forward.x * swingArm, side.y * (bw + 0.03) + forward.y * swingArm, legTop + 0.1, 0.04, suit);
  }

  // Helmet, and the visor on the side they are looking.
  const headH = torsoTop + 0.22;
  disc(0, 0, 0.12, headH - 0.02, shade(color('accent'), FACE_TONE));
  disc(0, 0, 0.115, headH, color('accent'));
  if (forward.y >= 0 || forward.x !== 0) {
    const vu = forward.x * 0.06;
    const vv = forward.y * 0.06;
    C.beginPath();
    C.ellipse(X(vu, vv), Y(vu, vv, headH - 0.1), (ns ? 0.08 : 0.04) * EX, 0.04 * EX, 0, 0, Math.PI * 2);
    paint(color('blue-high'), false);
  }
}
