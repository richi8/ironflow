/**
 * The map. See ironflow.md C23 task 4 and §13.
 *
 * > Map panel: rendered from the explored-world-chunk set, showing terrain
 * > colour, resource patches, and the player's entities as dots. Click to jump
 * > the camera.
 *
 * ```text
 *   MAP        a canvas, one pixel per map cell, scaled to fit the panel
 *   footprint  how much has been explored, and how
 *   click      jumps the camera to the tile under the pointer
 * ```
 *
 * ## It is a canvas, and it is the only panel that is
 *
 * Every other panel in `ui/` is DOM that updates by assignment, because what
 * it shows is a few dozen numbers. This one shows a few hundred thousand
 * cells, and a `<div>` each is not a panel. A canvas also makes "click to jump"
 * one coordinate transform rather than an event listener per cell.
 *
 * It is **not** the world renderer and shares nothing with it: no isometry, no
 * camera, no atlas (§5 — the word "diamond" does not appear here and the
 * projection boundary test checks that it does not). A map is a top-down
 * picture of tile space, which is the one space `game/` thinks in.
 *
 * ## Where the colours come from
 *
 * From `tokens.css`, read at repaint through `getComputedStyle`. §4 forbids
 * `ui/**` from importing `renderer/palette.ts`, and the alternative — a third
 * copy of §11's colours, in `ui/` — is the duplication that stylesheet exists
 * to prevent. The view model carries a **name** per cell ('grass', 'iron'),
 * which is the §11 palette token `--if-<name>`, the arrangement
 * `ResourceProperties.name` has documented since C09.
 *
 * A token that resolves to nothing — no stylesheet, a jsdom test — falls back
 * to a neutral grey rather than throwing, so the panel is still drawable and
 * still clickable where its colours are not.
 */

import type { MapView } from '../game/views/map-view.js';

import { createIcon } from './icons.js';

/** Device pixels per map cell at the smallest useful scale. */
const MIN_CELL_PX = 1;

/** The largest the map will zoom itself in, in device pixels per cell. */
const MAX_CELL_PX = 6;

/** What a cell whose colour token is missing is drawn in. See the file header. */
const FALLBACK_COLOR = '#3a4354';

/** How big a building's dot is drawn, in cells, whatever its footprint. */
const MIN_DOT_CELLS = 1;

export interface MapPanelOptions {
  /**
   * Centre the world view on a tile. Wired to the camera by the composition
   * root, because §4 will not let a panel hold one.
   */
  readonly onJumpTo: (x: number, y: number) => void;
  readonly onClose: () => void;
}

export class MapPanel {
  private readonly root = document.createElement('section');
  private readonly canvas = document.createElement('canvas');
  private readonly closeButton = document.createElement('button');
  private readonly footprint = document.createElement('span');
  private readonly hint = document.createElement('div');
  private readonly options: MapPanelOptions;

  /**
   * What the last repaint drew, so a click can be turned back into a tile.
   *
   * The inverse of the transform `paint` applies, remembered rather than
   * recomputed: recomputing it from a fresh view would answer for a map the
   * player is not looking at if anything changed between the paint and the
   * click.
   */
  private placement: { cellPx: number; originTileX: number; originTileY: number } | null = null;

  private open = false;

  constructor(options: MapPanelOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-map';
    this.root.hidden = true;

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = 'MAP';
    this.footprint.className = 'if-inventory__slots';
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (M)';
    this.closeButton.setAttribute('aria-label', 'Close the map');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('map'), title, this.footprint, this.closeButton);

    this.canvas.className = 'if-map__canvas';
    this.canvas.addEventListener('click', this.handleClick);

    this.hint.className = 'if-map__hint';
    this.hint.textContent = 'Click to look somewhere.';

    this.root.append(head, this.canvas, this.hint);
    parent.append(this.root);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.hidden = !open;
  }

  toggle(): boolean {
    this.setOpen(!this.open);
    return this.open;
  }

  /**
   * Repaint from a fresh snapshot.
   *
   * Called on the way open and on the HUD's 5 Hz lane while open (§13) — the
   * rate the inventory and the research panel run at, and for their reason:
   * what this shows changes at the speed of a walk or a radar sweep, not of a
   * machine.
   */
  update(view: MapView): void {
    const chunks = view.chunks.length;
    this.footprint.textContent = chunks === 0 ? 'unexplored' : `${chunks} areas seen`;
    this.hint.hidden = chunks > 0;
    if (chunks === 0) {
      this.placement = null;
      this.clear();
      return;
    }
    this.paint(view);
  }

  destroy(): void {
    this.canvas.removeEventListener('click', this.handleClick);
    this.closeButton.removeEventListener('click', this.handleClose);
    this.root.remove();
  }

  private readonly handleClose = (): void => {
    this.options.onClose();
  };

  /**
   * Turn a click into a tile and hand it to the camera.
   *
   * The inverse of `paint`'s transform, applied to the canvas's own CSS box
   * rather than to the page: the canvas is scaled to fit its panel, so the
   * ratio between its backing store and its layout size is the factor that
   * would otherwise put the jump a screen away from the click.
   */
  private readonly handleClick = (event: MouseEvent): void => {
    const placement = this.placement;
    if (placement === null) return;

    const box = this.canvas.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;

    const pixelX = ((event.clientX - box.left) / box.width) * this.canvas.width;
    const pixelY = ((event.clientY - box.top) / box.height) * this.canvas.height;
    const tileX = placement.originTileX + (pixelX / placement.cellPx) * this.cellTiles;
    const tileY = placement.originTileY + (pixelY / placement.cellPx) * this.cellTiles;
    this.options.onJumpTo(Math.floor(tileX), Math.floor(tileY));
  };

  /** Remembered from the last paint, so a click needs no view. */
  private cellTiles = 1;

  private clear(): void {
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * Size the canvas and work out where the map sits on it, then draw.
   *
   * The two halves are separate on purpose, and the seam is `getContext`: a
   * canvas with no 2D context — a headless test, a browser that has lost the
   * context — must still be **clickable**, because the placement is what
   * turns a pixel back into a tile and it is a fact about the view rather than
   * about the drawing. Drawing nothing is a blank panel; forgetting the
   * placement would be a map the player cannot use.
   */
  private paint(view: MapView): void {
    this.cellTiles = view.cellTiles;
    const cellsPerChunk = view.chunkTiles / view.cellTiles;
    const chunksWide = view.maxCx - view.minCx + 1;
    const chunksTall = view.maxCy - view.minCy + 1;
    const cellsWide = chunksWide * cellsPerChunk;
    const cellsTall = chunksTall * cellsPerChunk;

    // One integer scale factor for both axes, so the map is never stretched
    // and a cell is never a fraction of a pixel — the same reason §5's third
    // hazard rounds the world renderer's translate.
    const budget = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : 320;
    const cellPx = Math.max(
      MIN_CELL_PX,
      Math.min(MAX_CELL_PX, Math.floor(budget / Math.max(cellsWide, cellsTall))),
    );

    this.canvas.width = cellsWide * cellPx;
    this.canvas.height = cellsTall * cellPx;

    const originTileX = view.minCx * view.chunkTiles;
    const originTileY = view.minCy * view.chunkTiles;
    this.placement = { cellPx, originTileX, originTileY };

    const ctx = this.canvas.getContext('2d');
    if (ctx === null) return;

    const terrain = view.terrainNames.map((name) => this.token(`terrain-${name}`));
    const resource = view.resourceNames.map((name) => this.token(name));

    // Unexplored ground is the panel's own background rather than black: the
    // map is a hole in the fog, not a picture with a border.
    ctx.fillStyle = this.token('bg-deep');
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    for (const chunk of view.chunks) {
      const baseX = (chunk.cx - view.minCx) * cellsPerChunk;
      const baseY = (chunk.cy - view.minCy) * cellsPerChunk;
      for (let cellY = 0; cellY < cellsPerChunk; cellY++) {
        for (let cellX = 0; cellX < cellsPerChunk; cellX++) {
          const index = cellY * cellsPerChunk + cellX;
          const ore = chunk.resource[index] ?? 0;
          // Ore over terrain, not blended with it: a patch is what the player
          // is looking for, and a tint of it at map scale is a few grey pixels.
          const fill = ore > 0 ? resource[ore] : terrain[chunk.terrain[index] ?? 0];
          ctx.fillStyle = fill ?? FALLBACK_COLOR;
          ctx.fillRect((baseX + cellX) * cellPx, (baseY + cellY) * cellPx, cellPx, cellPx);
        }
      }
    }

    for (const entity of view.entities) {
      ctx.fillStyle = this.token(entity.buildingId);
      const dot = Math.max(MIN_DOT_CELLS, Math.round(entity.width / view.cellTiles)) * cellPx;
      const tall = Math.max(MIN_DOT_CELLS, Math.round(entity.height / view.cellTiles)) * cellPx;
      ctx.fillRect(
        ((entity.x - originTileX) / view.cellTiles) * cellPx,
        ((entity.y - originTileY) / view.cellTiles) * cellPx,
        dot,
        tall,
      );
    }

    // The player last, and in the accent colour nothing else on the map uses,
    // because "where am I" is the first question anyone opens a map to ask.
    ctx.fillStyle = this.token('accent');
    const markerX = ((view.playerX - originTileX) / view.cellTiles) * cellPx;
    const markerY = ((view.playerY - originTileY) / view.cellTiles) * cellPx;
    const marker = Math.max(3, cellPx + 2);
    ctx.fillRect(markerX - marker / 2, markerY - marker / 2, marker, marker);
  }

  /**
   * One §11 design token, as a colour string.
   *
   * Read from the document rather than from a table in this file — see the
   * header. Every call is one `getComputedStyle`, which is a handful per
   * repaint at 5 Hz; a cache would have to be invalidated by a theme change
   * that C30 has not designed yet.
   */
  private token(name: string): string {
    const value = getComputedStyle(document.documentElement).getPropertyValue(`--if-${name}`).trim();
    return value.length > 0 ? value : FALLBACK_COLOR;
  }
}
