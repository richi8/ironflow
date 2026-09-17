/**
 * The TypeScript mirror of `styles/tokens.css`. See ironflow.md §11.
 *
 * §11 requires the design tokens to be authored once and used by UI **and**
 * canvas. The DOM reads them as custom properties; canvas cannot, so the
 * renderer needs the same values as strings. Reading them back out with
 * `getComputedStyle` at start-up was the alternative and it is worse: it makes
 * every colour a runtime lookup against a stylesheet that may not have loaded,
 * it cannot be used from a test, and it silently yields `''` when a token is
 * renamed.
 *
 * So the values are duplicated here — and `tests/unit/palette.test.ts` parses
 * `tokens.css` and fails if the two ever disagree. Duplication that a test
 * pins is not drift; duplication nobody checks is.
 *
 * Keys are the token names with the `--if-` prefix removed, so the two files
 * can be compared mechanically rather than through a translation table.
 */

export const PALETTE = Object.freeze({
  /* surfaces */
  'bg-deep': '#0b111c',
  bg: '#131c2b',
  panel: '#1b2536',
  'panel-high': '#24334a',
  stroke: '#2c3a52',

  /* text */
  text: '#dbe4f0',
  'text-muted': '#8a9ab0',
  'text-dim': '#5d6b80',

  /* brand */
  accent: '#f2681f',
  'accent-high': '#ff8a3d',
  'accent-dim': '#a8481a',
  blue: '#3d7ebd',
  'blue-high': '#5aa3e0',

  /* status */
  ok: '#3fbf7f',
  warn: '#e8b13a',
  danger: '#e0523f',
  'ghost-valid': 'rgba(63, 191, 127, 0.45)',
  'ghost-invalid': 'rgba(224, 82, 63, 0.45)',

  /* terrain */
  'terrain-grass': '#4a6b3a',
  'terrain-dirt': '#6b5540',
  'terrain-sand': '#b09361',
  'terrain-stone': '#55606e',
  'terrain-water': '#23516e',

  /* resources. C20 pulled `iron` warmer and `stone` cooler and lighter: on a
     generated map the two sat four points apart in hue and iron ore on stone
     terrain (`#55606e`) was near-invisible, which C19 noticed and which is a
     §11 decision C20's pass owns. */
  iron: '#8fa6c6',
  copper: '#c96a3a',
  coal: '#2b3242',
  stone: '#b9b2a2',

  /* smelted goods (C15). A plate takes its ore's colour — `item:iron_plate`
     strips the suffix — so only the two that are nobody's ore need their own. */
  steel: '#b8c4d0',
  brick: '#a8543a',

  /* assembled goods (C16). `copper_wire` is not here for the same reason
     `iron_plate` is not: it strips to `copper` and is drawn as copper, which
     is what makes a belt of copper read as one line from ore to wire. */
  gear: '#8b96a4',
  circuit: '#3f8f6a',

  /* building items (C20). §15's building recipes make a building into a thing
     that rides a belt, so every one of them needs a colour — and one shared
     "machine grey" would make a mixed line of them unreadable, which is the
     one thing a placeholder palette still has to get right. The token *is* the
     item id, exactly as a resource's is, so adding a building adds a colour
     here and nothing anywhere else. */
  miner: '#e0913f',
  belt: '#4f7fa8',
  splitter: '#6b8fd4',
  inserter: '#7a6ec4',
  chest: '#8a7250',
  furnace: '#c25a4a',
  assembler: '#46a88f',
});

/** Every colour token the renderer may name. */
export type ColorToken = keyof typeof PALETTE;

/** The token used for the label on a placeholder building. Mirrors `--if-font`. */
export const FONT_STACK = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";

/** A colour by token name. Typed, so a renamed token is a compile error. */
export function color(token: ColorToken): string {
  return PALETTE[token];
}

/**
 * Multiply a `#rrggbb` colour's channels by `factor`, clamped to a byte.
 *
 * The placeholder prisms need three tones of one colour for their three faces,
 * and §11 defines one token per category rather than three. Deriving the
 * shades keeps the token list honest: a face tone is not a design decision,
 * it is what a light source does to the colour that *was* decided.
 *
 * Results are memoised because this is called from a draw path, and a factory
 * screen full of one building type asks for the same six strings every frame.
 */
const shadeCache = new Map<string, string>();

export function shade(hex: string, factor: number): string {
  const key = `${hex}|${factor}`;
  const cached = shadeCache.get(key);
  if (cached !== undefined) return cached;

  const parsed = parseHex(hex);
  const result =
    parsed === null
      ? hex
      : `#${channel(parsed.r * factor)}${channel(parsed.g * factor)}${channel(parsed.b * factor)}`;

  shadeCache.set(key, result);
  return result;
}

interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** `#rrggbb` only. Anything else — `rgba()`, a named colour — returns null. */
function parseHex(hex: string): Rgb | null {
  if (hex.length !== 7 || !hex.startsWith('#')) return null;
  const value = Number.parseInt(hex.slice(1), 16);
  if (!Number.isInteger(value)) return null;
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

function channel(value: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(value)));
  return clamped.toString(16).padStart(2, '0');
}
