import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebugOverlay, type DebugRows } from '../../src/debug/debug-overlay.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createCheckerboardGenerator } from '../fixtures/world-fixtures.js';
import { World } from '../../src/game/world/world.js';
import { CanvasSurface } from '../../src/platform/canvas-surface.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * Covers the pieces that only exist once there is a page: canvas sizing, the
 * debug overlay's DOM, and the wiring in main.ts. jsdom has neither a real 2D
 * context nor ResizeObserver, so both are stubbed — which is fine, because what
 * is under test is the arithmetic and the DOM discipline, not the browser.
 */

interface FakeContext {
  fillStyle: string;
  fillRect: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
}

let ctx: FakeContext;
let resizeCallbacks: (() => void)[];

function makeCanvas(cssWidth: number, cssHeight: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.getBoundingClientRect = () =>
    ({ width: cssWidth, height: cssHeight, top: 0, left: 0, right: cssWidth, bottom: cssHeight, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  document.body.append(canvas);
  return canvas;
}

beforeEach(() => {
  resizeCallbacks = [];
  ctx = { fillStyle: '', fillRect: vi.fn(), setTransform: vi.fn() };

  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallbacks.push(cb);
      }
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('CanvasSurface', () => {
  it('sizes the backing store in device pixels and draws in CSS pixels', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const canvas = makeCanvas(800, 600);

    const surface = new CanvasSurface(canvas);
    const size = surface.getSize();

    expect(size.cssWidth).toBe(800);
    expect(size.cssHeight).toBe(600);
    expect(size.deviceWidth).toBe(1600);
    expect(size.deviceHeight).toBe(1200);
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    // The transform is what lets every caller think in CSS pixels.
    expect(ctx.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
  });

  it('handles a non-retina display without scaling the backing store', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const surface = new CanvasSurface(makeCanvas(1024, 768));
    expect(surface.getSize().deviceWidth).toBe(1024);
    expect(surface.getSize().deviceHeight).toBe(768);
  });

  it('notifies listeners and resizes the backing store when the layout changes', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    let cssWidth = 400;
    const canvas = document.createElement('canvas');
    canvas.getBoundingClientRect = () =>
      ({ width: cssWidth, height: 300, top: 0, left: 0, right: cssWidth, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.append(canvas);

    const surface = new CanvasSurface(canvas);
    const seen: number[] = [];
    surface.onResize((s) => seen.push(s.deviceWidth));

    cssWidth = 900;
    for (const cb of resizeCallbacks) cb();

    expect(seen).toEqual([900]);
    expect(canvas.width).toBe(900);
  });

  it('does no work when a resize does not change the pixel size', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const surface = new CanvasSurface(makeCanvas(500, 500));
    const calls = ctx.setTransform.mock.calls.length;

    let fired = 0;
    surface.onResize(() => fired++);
    for (const cb of resizeCallbacks) cb();

    expect(fired).toBe(0);
    expect(ctx.setTransform.mock.calls.length).toBe(calls);
  });

  it('fails loudly when a 2D context cannot be acquired', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(() => new CanvasSurface(makeCanvas(100, 100))).toThrow(/2D canvas context/);
  });
});

describe('DebugOverlay', () => {
  /** A collector writing two sections, as the composition root does. */
  function rows(tick: number, extra: Readonly<Record<string, string>> = {}) {
    return (out: DebugRows): void => {
      out.section('tick');
      out.row('mean', '1.50 ms', 'ok');
      out.row('p99', '40.0 ms', 'hard_fail');
      out.section('session');
      out.row('tick', String(tick));
      for (const [label, value] of Object.entries(extra)) out.row(label, value);
    };
  }

  it('builds its DOM once and updates by assignment', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root, true);

    const node = root.querySelector('.debug-overlay');
    expect(node).not.toBeNull();

    const extra = { size: '800x600 @2x', terrain: '4 cached' };
    overlay.update(200, rows(123, extra));
    const grownCount = node?.childElementCount ?? 0;
    const firstValue = node?.querySelector('.debug-overlay__value');
    overlay.update(200, rows(456, extra));

    // §13: no panel rebuilds its subtree on update. Rows and section headings
    // are added the first time they are seen, and never again.
    expect(node?.childElementCount).toBe(grownCount);
    expect(node?.querySelectorAll('.debug-overlay__section')).toHaveLength(2);
    expect(node?.querySelector('.debug-overlay__value')).toBe(firstValue);
    expect(node?.textContent).toContain('456');
    // C03's readout: terrain-cache residency, which is the only way to see
    // from inside the page whether the world-chunk bitmaps are being reused.
    expect(node?.textContent).toContain('4 cached');
  });

  it('colours a row by its budget verdict (C28)', () => {
    const root = document.createElement('div');
    const overlay = new DebugOverlay(root, true);
    overlay.update(200, rows(1));

    const values = [...root.querySelectorAll('.debug-overlay__value')];
    expect(values[0]?.classList.contains('debug-overlay__value--ok')).toBe(true);
    expect(values[1]?.classList.contains('debug-overlay__value--danger')).toBe(true);

    // A verdict that changes swaps the class rather than adding a second one.
    overlay.update(200, (out) => {
      out.section('tick');
      out.row('mean', '9.0 ms', 'over_target');
      out.row('p99', '12.0 ms', null);
    });
    expect(values[0]?.className).toBe('debug-overlay__value debug-overlay__value--warn');
    expect(values[1]?.className).toBe('debug-overlay__value');
  });

  it('throttles updates, and collects nothing on a frame it will not draw', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root, true);

    overlay.update(200, rows(1)); // crosses the interval
    const after = root.textContent ?? '';

    let collected = false;
    overlay.update(5, () => {
      collected = true;
    }); // well inside the interval: ignored
    expect(collected).toBe(false);
    expect(root.textContent).toBe(after);
  });

  it('starts hidden, writes nothing while hidden, and paints as soon as it opens', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root);
    expect(overlay.isVisible()).toBe(false);

    overlay.update(500, rows(777));
    expect(root.textContent).not.toContain('777');

    // Opening it paints on the next frame rather than a tenth of a second later.
    overlay.toggle();
    overlay.update(1, rows(778));
    expect(root.textContent).toContain('778');
  });
});

describe('bootstrap wiring', () => {
  it('advances the simulation at TPS and paints every frame', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const surface = new CanvasSurface(makeCanvas(800, 600));
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()) });
    const scheduler = new FakeScheduler();

    let painted = 0;
    const game = new Game({
      simulation,
      scheduler,
      render: () => {
        painted++;
        surface.ctx.fillStyle = '#0b111c';
        surface.ctx.fillRect(0, 0, surface.getSize().cssWidth, surface.getSize().cssHeight);
      },
    });

    game.start();
    scheduler.runFrames(60, 16_667); // ~1 second at 60 fps

    // One simulated second, allowing a single tick of frame-quantisation slack.
    expect(simulation.getTick()).toBeGreaterThanOrEqual(TPS - 1);
    expect(simulation.getTick()).toBeLessThanOrEqual(TPS);
    expect(painted).toBe(60);
    expect(ctx.fillRect).toHaveBeenLastCalledWith(0, 0, 800, 600);

    game.stop();
    expect(game.isRunning()).toBe(false);
  });
});
