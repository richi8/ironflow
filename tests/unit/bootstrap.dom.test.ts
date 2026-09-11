import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebugOverlay } from '../../src/debug/debug-overlay.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createCheckerboardGenerator } from '../../src/game/world/world-generator.js';
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
  const stats = {
    fps: 60,
    frameMs: 1.5,
    simMs: 0.2,
    renderMs: 0.4,
    steps: 2,
    alpha: 0.25,
    shedCount: 0,
    frameCount: 10,
  };

  it('builds its DOM once and updates by assignment', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root);

    const node = root.querySelector('.debug-overlay');
    expect(node).not.toBeNull();
    const rowCount = node?.childElementCount ?? 0;
    const firstValue = node?.querySelector('.debug-overlay__value');

    const rows = { size: '800x600 @2x', world: '1 chunk(s)', terrain: '4 cached' };
    overlay.update(stats, 123, rows, 200);
    overlay.update({ ...stats, fps: 30 }, 456, rows, 200);

    // §13: no panel rebuilds its subtree on update. The extra rows are added
    // the first time they are seen, so the count is compared after that.
    const grownCount = node?.childElementCount ?? 0;
    expect(grownCount).toBe(rowCount + Object.keys(rows).length);
    expect(node?.querySelector('.debug-overlay__value')).toBe(firstValue);
    expect(node?.textContent).toContain('456');
    expect(node?.textContent).toContain('1 chunk(s)');
    // C03's readout: terrain-cache residency, which is the only way to see
    // from inside the page whether the world-chunk bitmaps are being reused.
    expect(node?.textContent).toContain('4 cached');
  });

  it('throttles updates rather than writing every frame', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root);

    overlay.update(stats, 1, { size: 'x' }, 200); // crosses the interval
    const after = root.textContent ?? '';

    overlay.update(stats, 999, { size: 'x' }, 5); // well inside the interval: ignored
    expect(root.textContent).toBe(after);
    expect(root.textContent).not.toContain('999');
  });

  it('writes nothing while hidden', () => {
    const root = document.createElement('div');
    document.body.append(root);
    const overlay = new DebugOverlay(root);

    overlay.toggle();
    expect(overlay.isVisible()).toBe(false);

    overlay.update(stats, 777, { size: 'x' }, 500);
    expect(root.textContent).not.toContain('777');
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
