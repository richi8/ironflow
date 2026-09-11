/**
 * The eight HUD icons. See ironflow.md §11.
 *
 * §11 names them — **resource, building, power, research, inventory, alert,
 * map, pause** — and is specific about how they arrive: "inline SVG in `ui/`,
 * one file, with `currentColor`. No icon font, no sprite sheet for UI." So
 * there are no image requests here and nothing to load: each icon is a single
 * path on a 16×16 grid, filled with `currentColor`, which means an icon takes
 * the colour of whatever it sits in and a disabled tile dims its icon with it.
 *
 * They are drawn with `createElementNS` rather than assigned as markup. The
 * DOM is built once and updated by assignment (§13), and an `innerHTML` on a
 * panel is exactly the subtree rebuild that rule exists to prevent — so the
 * habit is worth keeping even where the string is a constant in this file.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

export type IconName =
  | 'resource'
  | 'building'
  | 'power'
  | 'research'
  | 'inventory'
  | 'alert'
  | 'map'
  | 'pause'
  | 'play';

/**
 * One path per icon, on a 16×16 grid, `evenodd` so a hole is a hole.
 *
 * `play` is a ninth, and it is the pause button's other face rather than a new
 * icon: a control that toggles has to show what the next press will do, and a
 * pause glyph that stays put while the game is stopped is the classic "is it
 * paused or not?" button. §11's eight are all above it.
 */
const PATHS: Readonly<Record<IconName, string>> = Object.freeze({
  /** An ore chunk, as on the reference sheet's resource nodes. */
  resource: 'M8 1 14 5.5 11.8 14H4.2L2 5.5Zm0 2.4L4.3 6.1l1.5 5.9h4.4l1.5-5.9Z',
  /** A factory roofline: two saw-teeth and a stack. */
  building: 'M1 14V6l4 3V6l4 3V3h2v2h4v9Zm2-2h10V7h-4V6.9L5.1 10H5V9.1L3 7.6Z',
  /** A bolt. */
  power: 'M10 1 3 9.5h3.6L6 15l7-8.5H9.4Z',
  /** A flask. */
  research: 'M5.5 1h5v2H10v3.2l3.8 6.3A1.5 1.5 0 0 1 12.5 15h-9a1.5 1.5 0 0 1-1.3-2.3L6 6.2V3H5.5Zm2.5 2v3.8L5.6 11h4.8L8 6.8Z',
  /** A crate with a lid. */
  inventory: 'M1 2h14v3.5H1Zm1 5h12v7H2Zm2 2v3h3V9Z',
  /** A warning triangle. */
  alert: 'M8 1 15.5 14.5H.5Zm0 3.4L3.4 12.9h9.2ZM7.1 7h1.8v3.2H7.1Zm0 4h1.8v1.3H7.1Z',
  /** A folded map. */
  map: 'M5.5 1.6 10.5 3.4 15 1.6v11.2l-4.5 1.8-5-1.8L1 14.6V3.4Zm-1 2v8.8l1-.4V3.2Zm3 .3v8.8l1 .4V3.5Z',
  pause: 'M4 3h3v10H4Zm5 0h3v10H9Z',
  play: 'M4 2.5 13 8l-9 5.5Z',
});

/**
 * A 16×16 icon element, ready to be appended once and left alone.
 *
 * `aria-hidden`, because every icon in this UI sits beside its own text label
 * and a screen reader repeating "alert alert" is worse than silence. C30 is
 * where accessibility gets a proper pass.
 */
export function createIcon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'if-icon');

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PATHS[name]);
  path.setAttribute('fill', 'currentColor');
  path.setAttribute('fill-rule', 'evenodd');
  svg.append(path);

  return svg;
}

/** Swap an existing icon's glyph without replacing the element (§13). */
export function setIcon(svg: SVGSVGElement, name: IconName): void {
  const path = svg.firstElementChild;
  if (path === null) return;
  const next = PATHS[name];
  if (path.getAttribute('d') !== next) path.setAttribute('d', next);
}
