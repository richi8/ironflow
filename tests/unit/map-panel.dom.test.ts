import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import type { MapPoint } from '../../src/game/views/map-view.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { MAP_CELL_TILES } from '../../src/game/views/map-view.js';
import { CHUNK_SIZE } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { GameUI } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * The map panel. See ironflow.md C23 task 4 and §13.
 *
 * The criteria this file carries:
 *
 * - the map shows **explored terrain and updates as the player travels**,
 *   which is C23's first acceptance criterion, asserted through the view model
 *   the panel is handed rather than through pixels;
 * - **click to jump** hands the camera a tile, and the tile is the one under
 *   the pointer — the transform and its inverse agree;
 * - it is the **fourth exclusive panel**, so opening it puts the others away;
 * - it draws with no stylesheet loaded, which is what jsdom is, because a
 *   panel that throws when a colour token is missing is a panel that breaks in
 *   a theme C30 has not written yet.
 *
 * Canvas in jsdom has no 2D context unless `canvas` is installed, and it is
 * not (§3's dependency policy would not take it for this). So `getContext`
 * answers `null`, `paint` returns early, and what is asserted here is
 * everything on either side of the drawing: the view, the footprint text, the
 * exclusivity and the click. The drawing itself is placeholder art that C29
 * replaces, and a test of it would be a test of `fillRect`.
 */

interface Harness {
  readonly root: HTMLElement;
  readonly ui: GameUI;
  readonly controller: GameController;
  readonly simulation: Simulation;
  readonly jumps: { x: number; y: number }[];
  readonly drawn: string[];
  viewport: readonly MapPoint[] | null;
}

/**
 * A 2D context that records the calls made on it instead of drawing.
 *
 * Only the viewport tests use it, and only for *geometry*: §17 says not to
 * test renderer pixel output, and this does not — where a `moveTo` lands is a
 * fact about a coordinate transform, which is the same kind of fact
 * `depth-key.test.ts` already pins. What is drawn at those coordinates is
 * placeholder art C29 replaces.
 */
function recordingContext(into: string[]): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get(_target, property: string) {
        if (property === 'canvas') return undefined;
        return (...args: unknown[]): unknown => {
          // `beginPath` resets the buffer, so what is left is always the most
          // recent path — which is what makes this robust against the panel
          // being repainted more than once while a test settles. Nothing else
          // the panel draws opens a path; the cells, the dots and the player
          // marker are all `fillRect`.
          if (property === 'beginPath') into.length = 0;
          if (property === 'moveTo' || property === 'lineTo' || property === 'stroke' || property === 'closePath') {
            into.push(`${property}(${args.map((value) => String(Math.round(Number(value)))).join(',')})`);
          }
          return undefined;
        };
      },
      set() {
        return true;
      },
    },
  ) as CanvasRenderingContext2D;
}

let harness: Harness;

function mountUi(): Harness {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const controller = new GameController({ game, cursor: new DetachedCursor() });

  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);

  const jumps: { x: number; y: number }[] = [];
  const drawn: string[] = [];
  const box: { viewport: readonly MapPoint[] | null } = { viewport: null };
  const ui = new GameUI({
    root,
    controller,
    onJumpTo: (x, y) => jumps.push({ x, y }),
    viewport: () => box.viewport,
  });
  ui.mount();
  return {
    root,
    ui,
    controller,
    simulation,
    jumps,
    drawn,
    get viewport() {
      return box.viewport;
    },
    set viewport(value: readonly MapPoint[] | null) {
      box.viewport = value;
    },
  };
}

const FRAME_MS = 1000 / 60;

function settle(): void {
  for (let i = 0; i < 20; i++) harness.ui.update(FRAME_MS);
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

function panel(): HTMLElement {
  return query<HTMLElement>(harness.root, '.if-map');
}

function canvas(): HTMLCanvasElement {
  return query<HTMLCanvasElement>(harness.root, '.if-map__canvas');
}

/**
 * jsdom has no 2D context and says so on stderr every time it is asked.
 *
 * Stubbed to `null`, which is the answer jsdom is trying to give: the panel
 * already handles a missing context — see `MapPanel.paint` on why the map
 * stays clickable without one — and §20 asks for a test run with no console
 * noise in it. Installing the `canvas` package to make this real would be a
 * runtime dependency for a picture that C29 replaces (§3).
 */
const realGetContext = HTMLCanvasElement.prototype.getContext;

/**
 * Swap what `getContext` hands back, with the cast in exactly one place.
 *
 * `HTMLCanvasElement['getContext']` is an overload set covering webgl and
 * bitmap renderers; a stub that only answers for '2d' cannot satisfy it and
 * does not need to, because the panel only ever asks for '2d'.
 */
function useContext(factory: () => CanvasRenderingContext2D | null): void {
  HTMLCanvasElement.prototype.getContext = factory as unknown as HTMLCanvasElement['getContext'];
}

beforeEach(() => {
  useContext(() => null);
  harness = mountUi();
});

afterEach(() => {
  harness.ui.destroy();
  harness.root.remove();
  HTMLCanvasElement.prototype.getContext = realGetContext;
});

describe('the panel', () => {
  it('is mounted shut, and opens from the toolbar and from M alike', () => {
    expect(panel().hidden).toBe(true);
    query<HTMLButtonElement>(harness.root, '.if-toolbar__menu[aria-label], .if-toolbar');

    const button = [...harness.root.querySelectorAll<HTMLButtonElement>('.if-toolbar__menu')].find(
      (element) => element.textContent === 'MAP',
    );
    expect(button).toBeDefined();
    button?.click();
    expect(panel().hidden).toBe(false);
    expect(harness.ui.isMapOpen()).toBe(true);
    expect(button?.getAttribute('aria-pressed')).toBe('true');

    // The same call the `ui.toggleMap` keybinding makes in `main.ts`.
    harness.ui.toggleMap();
    expect(panel().hidden).toBe(true);
  });

  it('is the fourth panel to want the same half of the screen', () => {
    harness.ui.toggleResearch();
    expect(harness.ui.isResearchOpen()).toBe(true);
    harness.ui.toggleMap();
    expect(harness.ui.isResearchOpen()).toBe(false);

    harness.ui.toggleInventory();
    expect(harness.ui.isMapOpen()).toBe(false);
    harness.ui.toggleMap();
    expect(harness.ui.isInventoryOpen()).toBe(false);
  });

  it('says so while nothing has been explored, and stops saying so once something has', () => {
    harness.ui.toggleMap();
    expect(query<HTMLElement>(harness.root, '.if-inventory__slots, .if-map .if-inventory__slots'));
    const footprint = query<HTMLElement>(panel(), '.if-inventory__slots');
    expect(footprint.textContent).toBe('unexplored');
    expect(query<HTMLElement>(panel(), '.if-map__hint').hidden).toBe(false);

    // One tick is all it takes: phase 9 reveals the world chunks the player is
    // standing in the middle of.
    harness.simulation.tick();
    settle();
    expect(footprint.textContent).toMatch(/\d+ areas seen/);
    expect(query<HTMLElement>(panel(), '.if-map__hint').hidden).toBe(true);
  });
});

describe('the view it is handed', () => {
  it('grows as the player travels, which is C23’s first acceptance criterion', () => {
    harness.simulation.tick();
    const before = harness.controller.getMapView();
    expect(before.chunks.length).toBeGreaterThan(0);
    expect(before.minCx).toBeLessThanOrEqual(0);

    harness.simulation.player.setTilePosition(CHUNK_SIZE * 4, CHUNK_SIZE * 4);
    harness.simulation.tick();
    const after = harness.controller.getMapView();
    expect(after.chunks.length).toBeGreaterThan(before.chunks.length);
    expect(after.maxCx).toBeGreaterThan(before.maxCx);
    expect(after.playerX).toBeGreaterThan(before.playerX);
  });

  it('carries palette-token names rather than colours, so §4 holds', () => {
    harness.simulation.tick();
    const view = harness.controller.getMapView();
    // `ResourceProperties.name` is the §11 token, the sprite id and the
    // readout — one word, three uses, and the reason `ui/` never has to import
    // `renderer/palette.ts`, which the boundary test forbids.
    expect(view.terrainNames).toContain('grass');
    expect(view.resourceNames[0]).toBe('none');
    expect(view.resourceNames).toContain('iron');
    for (const name of [...view.terrainNames, ...view.resourceNames]) {
      expect(name).not.toMatch(/^#/);
    }
  });

  it('downsamples a world chunk to whole cells', () => {
    harness.simulation.tick();
    const view = harness.controller.getMapView();
    const cells = view.chunkTiles / view.cellTiles;
    expect(view.cellTiles).toBe(MAP_CELL_TILES);
    expect(Number.isInteger(cells)).toBe(true);
    for (const chunk of view.chunks) {
      expect(chunk.terrain).toHaveLength(cells * cells);
      expect(chunk.resource).toHaveLength(cells * cells);
    }
  });

  it('shows only the buildings standing on explored ground', () => {
    harness.simulation.tick();
    harness.simulation.player.setTilePosition(2, 2);
    harness.simulation.inventory.add('chest', 1);
    harness.simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 2, y: 2, rotation: NORTH });
    harness.simulation.tick();

    const view = harness.controller.getMapView();
    const dot = view.entities.find((entity) => entity.x === 2 && entity.y === 2);
    expect(dot).toBeDefined();
    // The id, which is also the §11 token `--if-chest`, for the cells' reason.
    expect(dot?.buildingId).toBe('chest');
    expect(dot?.width).toBe(1);
  });

  it('rebuilds a world chunk only when its contents have moved', () => {
    harness.simulation.tick();
    const first = harness.controller.getMapView();
    const second = harness.controller.getMapView();
    const key = (view: ReturnType<GameController['getMapView']>): unknown =>
      view.chunks.find((chunk) => chunk.cx === 0 && chunk.cy === 0)?.terrain;
    // The same object, not an equal one: the cache is keyed on
    // `WorldChunk.revision`, and nothing has changed between the two calls.
    expect(key(second)).toBe(key(first));

    harness.simulation.world.setTile(1, 1, harness.simulation.world.getTile(1, 1) === 0 ? 1 : 0);
    expect(key(harness.controller.getMapView())).not.toBe(key(first));
  });
});

describe('the viewport outline', () => {
  /**
   * Record exactly one repaint and return the path it stroked.
   *
   * The panel is opened *before* the recorder goes in, because opening it is
   * itself a repaint (§13's "repaint on the way in") and two paints in the
   * buffer would make every count twice what it should be.
   */
  function strokeWith(corners: readonly MapPoint[] | null): string[] {
    harness.viewport = corners;
    harness.simulation.tick();
    harness.ui.toggleMap();
    settle();

    harness.drawn.length = 0;
    useContext(() => recordingContext(harness.drawn));
    // One beat of the 5 Hz lane, which is one repaint.
    settle();
    useContext(() => null);
    return harness.drawn;
  }

  it('draws a closed four-sided figure through the corners it is handed', () => {
    const view = (): ReturnType<GameController['getMapView']> => harness.controller.getMapView();
    harness.simulation.tick();
    const snapshot = view();
    const originX = snapshot.minCx * snapshot.chunkTiles;
    const originY = snapshot.minCy * snapshot.chunkTiles;

    // A deliberately rotated quad — what an unprojected screen rectangle
    // actually is in tile space, and the reason the panel takes corners rather
    // than the camera's axis-aligned cull box.
    const corners: MapPoint[] = [
      { x: originX + 8, y: originY + 0 },
      { x: originX + 16, y: originY + 8 },
      { x: originX + 8, y: originY + 16 },
      { x: originX + 0, y: originY + 8 },
    ];
    const path = strokeWith(corners);

    const moves = path.filter((call) => call.startsWith('moveTo'));
    const lines = path.filter((call) => call.startsWith('lineTo'));
    expect(moves).toHaveLength(1);
    expect(lines).toHaveLength(3);
    expect(path).toContain('closePath()');
    expect(path.at(-1)).toBe('stroke()');

    // The first corner, through the same transform the cells use: tiles from
    // the map's origin, divided into cells, times pixels per cell.
    const cellPx = 6;
    expect(moves[0]).toBe(`moveTo(${String((8 / snapshot.cellTiles) * cellPx)},0)`);
  });

  it('draws nothing when there is no view to draw', () => {
    expect(strokeWith(null).filter((call) => call.startsWith('moveTo'))).toHaveLength(0);
  });

  it('keeps following the camera while the game is paused', () => {
    // The map is the one panel with a lane that survives a pause, because the
    // camera is a view control and keeps moving (C07). Everything else it
    // draws is simulation state and cannot change while nothing ticks.
    harness.simulation.tick();
    harness.ui.toggleMap();
    settle();

    harness.controller.setPaused(true);
    harness.viewport = [
      { x: 0, y: 0 },
      { x: 8, y: 0 },
      { x: 8, y: 8 },
      { x: 0, y: 8 },
    ];
    harness.drawn.length = 0;
    useContext(() => recordingContext(harness.drawn));
    settle();
    useContext(() => null);

    expect(harness.drawn.filter((call) => call.startsWith('moveTo'))).not.toHaveLength(0);
    harness.controller.setPaused(false);
  });
});

describe('click to jump', () => {
  it('hands the camera the tile under the pointer', () => {
    harness.simulation.tick();
    harness.ui.toggleMap();
    settle();

    const element = canvas();
    // jsdom lays nothing out, so the canvas has no box and the panel's own
    // guard refuses the click rather than dividing by zero — which is the
    // behaviour a collapsed panel should have. Stub the box the way a browser
    // would report it, matching the backing store one for one.
    const width = element.width > 0 ? element.width : 64;
    const height = element.height > 0 ? element.height : 64;
    element.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;

    element.dispatchEvent(new MouseEvent('click', { clientX: 0, clientY: 0, bubbles: true }));
    const jump = harness.jumps[0];
    expect(jump).toBeDefined();
    // The north-west corner of the explored rectangle, which is where the
    // pixel at (0, 0) is. The panel drew nothing — jsdom has no 2D context —
    // but the transform it remembered is the one the click inverts.
    const view = harness.controller.getMapView();
    expect(jump?.x).toBe(view.minCx * view.chunkTiles);
    expect(jump?.y).toBe(view.minCy * view.chunkTiles);
  });

  it('does nothing before anything has been explored', () => {
    harness.ui.toggleMap();
    settle();
    canvas().dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5, bubbles: true }));
    expect(harness.jumps).toHaveLength(0);
  });
});
