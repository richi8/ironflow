import { describe, expect, it } from 'vitest';

import { Camera, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../../src/renderer/camera.js';
import type { ScreenPoint } from '../../src/renderer/projection.js';
import { createSeededRandom, seededInt } from '../fixtures/seeded-random.js';

const VIEW_W = 800;
const VIEW_H = 600;

/** The five zoom levels the C01 acceptance criterion asks for. */
const ZOOM_LEVELS = [0.25, 0.5, 1, 2, 4] as const;

/** A 60 fps frame, in milliseconds. */
const FRAME_MS = 1000 / 60;

function makeCamera(options: { x?: number; y?: number; zoom?: number } = {}): Camera {
  const camera = new Camera({
    x: options.x ?? 0,
    y: options.y ?? 0,
    zoom: options.zoom ?? 1,
    viewportWidth: VIEW_W,
    viewportHeight: VIEW_H,
  });
  return camera;
}

/** Run the zoom ease to completion, calling `onFrame` after every frame. */
function settle(camera: Camera, onFrame?: (frame: number) => void): number {
  let frames = 0;
  while (camera.isZooming()) {
    camera.update(FRAME_MS);
    frames++;
    onFrame?.(frames);
    if (frames > 600) throw new Error('zoom ease did not settle within 10 seconds');
  }
  return frames;
}

describe('Camera transforms', () => {
  it('shows its own position at the centre of the viewport', () => {
    for (const zoom of ZOOM_LEVELS) {
      const camera = makeCamera({ x: 12.5, y: -7.25, zoom });
      const centre = camera.worldToScreen(12.5, -7.25);
      expect(centre.x).toBeCloseTo(VIEW_W / 2, 9);
      expect(centre.y).toBeCloseTo(VIEW_H / 2, 9);
    }
  });

  it('round-trips 10,000 tiles across five zoom levels', () => {
    const random = createSeededRandom(0xb0a7);
    let checked = 0;

    for (const zoom of ZOOM_LEVELS) {
      const camera = makeCamera({ x: 40.5, y: -12.25, zoom });
      for (let i = 0; i < 2000; i++) {
        const x = seededInt(random, -5000, 5000);
        const y = seededInt(random, -5000, 5000);

        const screen = camera.worldToScreen(x, y);
        const back = camera.screenToWorld(screen.x, screen.y);

        // Not exact like the raw projection: the camera divides by a zoom that
        // is not always a power of two, so this is float-close, not identical.
        expect(back.x).toBeCloseTo(x, 6);
        expect(back.y).toBeCloseTo(y, 6);
        checked++;
      }
    }

    expect(checked).toBe(10_000);
  });

  it('reports the ground tile under a pixel', () => {
    const camera = makeCamera({ x: 0, y: 0, zoom: 1 });
    const screen = camera.worldToScreen(6.5, 9.5);
    expect(camera.screenToTile(screen.x, screen.y)).toEqual({ x: 6, y: 9 });
  });

  it('picks the same tile for every pixel inside that tile', () => {
    const random = createSeededRandom(0x7113);
    const camera = makeCamera({ x: 3.5, y: 3.5, zoom: 2 });
    for (let i = 0; i < 2000; i++) {
      const tx = seededInt(random, -5, 12);
      const ty = seededInt(random, -5, 12);
      const screen = camera.worldToScreen(tx + 0.01 + random() * 0.98, ty + 0.01 + random() * 0.98);
      expect(camera.screenToTile(screen.x, screen.y)).toEqual({ x: tx, y: ty });
    }
  });
});

describe('Camera.pan', () => {
  it('moves the world 1:1 with the cursor at every zoom level', () => {
    for (const zoom of ZOOM_LEVELS) {
      const camera = makeCamera({ x: 20, y: 30, zoom });
      const before = camera.worldToScreen(25, 33);

      camera.pan(37, -19);

      const after = camera.worldToScreen(25, 33);
      expect(after.x - before.x).toBeCloseTo(37, 6);
      expect(after.y - before.y).toBeCloseTo(-19, 6);
    }
  });

  it('keeps the grabbed point under the cursor through a whole drag', () => {
    for (const zoom of ZOOM_LEVELS) {
      const camera = makeCamera({ x: 0, y: 0, zoom });

      let cursor: ScreenPoint = { x: 210, y: 340 };
      const grabbed = camera.screenToWorld(cursor.x, cursor.y);

      const random = createSeededRandom(0x0dd);
      for (let step = 0; step < 60; step++) {
        const dx = seededInt(random, -25, 25);
        const dy = seededInt(random, -25, 25);
        camera.pan(dx, dy);
        cursor = { x: cursor.x + dx, y: cursor.y + dy };

        const now = camera.worldToScreen(grabbed.x, grabbed.y);
        expect(now.x).toBeCloseTo(cursor.x, 6);
        expect(now.y).toBeCloseTo(cursor.y, 6);
      }
    }
  });

  it('is reversible', () => {
    const camera = makeCamera({ x: -4.5, y: 8.25, zoom: 0.5 });
    camera.pan(123, -456);
    camera.pan(-123, 456);
    expect(camera.x).toBeCloseTo(-4.5, 9);
    expect(camera.y).toBeCloseTo(8.25, 9);
  });

  it('ignores a zero drag', () => {
    const camera = makeCamera({ x: 1.5, y: 2.5 });
    camera.pan(0, 0);
    expect(camera.x).toBe(1.5);
    expect(camera.y).toBe(2.5);
  });
});

describe('Camera.zoomAt', () => {
  it('steps multiplicatively', () => {
    const camera = makeCamera({ zoom: 1 });
    camera.zoomAt(400, 300, 1);
    expect(camera.targetZoom).toBeCloseTo(ZOOM_STEP, 9);

    camera.zoomAt(400, 300, 1);
    expect(camera.targetZoom).toBeCloseTo(ZOOM_STEP * ZOOM_STEP, 9);

    camera.zoomAt(400, 300, -2);
    expect(camera.targetZoom).toBeCloseTo(1, 9);
  });

  it('clamps to [0.25, 4] however hard the wheel is spun', () => {
    const camera = makeCamera({ zoom: 1 });

    for (let i = 0; i < 100; i++) camera.zoomAt(400, 300, 1);
    expect(camera.targetZoom).toBe(ZOOM_MAX);
    settle(camera);
    expect(camera.zoom).toBe(ZOOM_MAX);

    for (let i = 0; i < 100; i++) camera.zoomAt(400, 300, -1);
    expect(camera.targetZoom).toBe(ZOOM_MIN);
    settle(camera);
    expect(camera.zoom).toBe(ZOOM_MIN);
  });

  it('does nothing when already clamped', () => {
    const camera = makeCamera({ zoom: ZOOM_MAX });
    const x = camera.x;
    const y = camera.y;
    camera.zoomAt(10, 10, 5);
    expect(camera.targetZoom).toBe(ZOOM_MAX);
    expect(camera.x).toBe(x);
    expect(camera.y).toBe(y);
  });

  it('keeps the anchored point under the cursor on every frame of the ease', () => {
    const cursors: readonly ScreenPoint[] = [
      { x: 400, y: 300 }, // centre
      { x: 0, y: 0 }, // corner
      { x: VIEW_W, y: VIEW_H }, // opposite corner
      { x: 137, y: 511 }, // somewhere awkward
    ];

    for (const cursor of cursors) {
      for (const steps of [1, -1, 4, -4]) {
        const camera = makeCamera({ x: 17.3, y: -4.8, zoom: 1 });
        const anchored = camera.screenToWorld(cursor.x, cursor.y);

        camera.zoomAt(cursor.x, cursor.y, steps);

        const frames = settle(camera, () => {
          const now = camera.worldToScreen(anchored.x, anchored.y);
          // The criterion is "within 1 px". The re-solve makes it exact, so
          // hold it to float noise instead and the criterion follows.
          expect(Math.abs(now.x - cursor.x)).toBeLessThan(1e-6);
          expect(Math.abs(now.y - cursor.y)).toBeLessThan(1e-6);
        });

        expect(frames).toBeGreaterThan(1); // it really did ease, not jump
      }
    }
  });

  it('keeps the hovered tile under the cursor', () => {
    const camera = makeCamera({ x: 8.5, y: 8.5, zoom: 1 });
    const cursor = { x: 512, y: 208 };
    const hovered = camera.screenToTile(cursor.x, cursor.y);

    camera.zoomAt(cursor.x, cursor.y, 3);
    settle(camera, () => {
      expect(camera.screenToTile(cursor.x, cursor.y)).toEqual(hovered);
    });
  });

  it('stays anchored when the wheel is spun again mid-ease', () => {
    const camera = makeCamera({ x: 2.5, y: 2.5, zoom: 1 });
    const cursor = { x: 300, y: 200 };

    camera.zoomAt(cursor.x, cursor.y, 2);
    camera.update(FRAME_MS);
    camera.update(FRAME_MS);

    const anchored = camera.screenToWorld(cursor.x, cursor.y);
    camera.zoomAt(cursor.x, cursor.y, 2);

    settle(camera, () => {
      const now = camera.worldToScreen(anchored.x, anchored.y);
      expect(Math.abs(now.x - cursor.x)).toBeLessThan(1e-6);
      expect(Math.abs(now.y - cursor.y)).toBeLessThan(1e-6);
    });
  });

  it('lets a drag and a zoom ease run at the same time', () => {
    const camera = makeCamera({ x: 5, y: 5, zoom: 1 });
    let cursor: ScreenPoint = { x: 250, y: 250 };

    camera.zoomAt(cursor.x, cursor.y, 2);
    const anchored = camera.screenToWorld(cursor.x, cursor.y);

    while (camera.isZooming()) {
      camera.pan(3, -2);
      cursor = { x: cursor.x + 3, y: cursor.y - 2 };
      camera.update(FRAME_MS);

      const now = camera.worldToScreen(anchored.x, anchored.y);
      expect(Math.abs(now.x - cursor.x)).toBeLessThan(1e-6);
      expect(Math.abs(now.y - cursor.y)).toBeLessThan(1e-6);
    }
  });

  it('settles onto the target exactly, and quickly', () => {
    const camera = makeCamera({ zoom: 1 });
    camera.zoomAt(400, 300, 3);
    const frames = settle(camera);

    expect(camera.zoom).toBe(camera.targetZoom);
    expect(camera.isZooming()).toBe(false);
    expect(frames).toBeLessThan(30); // under half a second at 60 fps
  });

  it('eases at the same rate whether zooming in or out', () => {
    const zoomIn = makeCamera({ zoom: 1 });
    zoomIn.zoomAt(400, 300, 4);

    const zoomOut = makeCamera({ zoom: 1 });
    zoomOut.zoomAt(400, 300, -4);

    expect(settle(zoomIn)).toBe(settle(zoomOut));
  });

  it('does not move on a zero or negative frame time', () => {
    const camera = makeCamera({ zoom: 1 });
    camera.zoomAt(400, 300, 2);
    const zoom = camera.zoom;

    camera.update(0);
    camera.update(-16);

    expect(camera.zoom).toBe(zoom);
    expect(camera.isZooming()).toBe(true);
  });

  it('is inert once at rest', () => {
    const camera = makeCamera({ x: 3, y: 4, zoom: 2 });
    camera.update(FRAME_MS);
    expect(camera.x).toBe(3);
    expect(camera.y).toBe(4);
    expect(camera.zoom).toBe(2);
  });
});

describe('Camera.setZoom / setPosition', () => {
  it('setZoom jumps with no ease and respects the clamp', () => {
    const camera = makeCamera({ zoom: 1 });
    camera.setZoom(3);
    expect(camera.zoom).toBe(3);
    expect(camera.isZooming()).toBe(false);

    camera.setZoom(100);
    expect(camera.zoom).toBe(ZOOM_MAX);

    camera.setZoom(0);
    expect(camera.zoom).toBe(ZOOM_MIN);
  });

  it('setPosition cancels an in-flight zoom anchor', () => {
    const camera = makeCamera({ zoom: 1 });
    camera.zoomAt(100, 100, 3);
    camera.setPosition(50, 50);

    settle(camera);

    expect(camera.x).toBe(50);
    expect(camera.y).toBe(50);
  });
});

/* -------------------------------------------------------------------------- *
 * visibleTileBounds
 * -------------------------------------------------------------------------- */

/** Do two convex polygons overlap with positive area? Separating-axis test. */
function overlaps(a: readonly ScreenPoint[], b: readonly ScreenPoint[]): boolean {
  for (const polygon of [a, b]) {
    for (let i = 0; i < polygon.length; i++) {
      const p = polygon[i] as ScreenPoint;
      const q = polygon[(i + 1) % polygon.length] as ScreenPoint;
      const axis = { x: -(q.y - p.y), y: q.x - p.x };

      let aMin = Infinity;
      let aMax = -Infinity;
      for (const point of a) {
        const d = point.x * axis.x + point.y * axis.y;
        aMin = Math.min(aMin, d);
        aMax = Math.max(aMax, d);
      }

      let bMin = Infinity;
      let bMax = -Infinity;
      for (const point of b) {
        const d = point.x * axis.x + point.y * axis.y;
        bMin = Math.min(bMin, d);
        bMax = Math.max(bMax, d);
      }

      if (aMax - bMin <= 1e-9 || bMax - aMin <= 1e-9) return false;
    }
  }
  return true;
}

function tileQuad(camera: Camera, x: number, y: number): ScreenPoint[] {
  return [
    camera.worldToScreen(x, y),
    camera.worldToScreen(x + 1, y),
    camera.worldToScreen(x + 1, y + 1),
    camera.worldToScreen(x, y + 1),
  ];
}

describe('Camera.visibleTileBounds', () => {
  const cases = [
    { x: 0, y: 0, zoom: 1, w: 800, h: 600 },
    { x: 0, y: 0, zoom: 0.25, w: 800, h: 600 },
    { x: 0, y: 0, zoom: 4, w: 800, h: 600 },
    { x: 137.4, y: -88.9, zoom: 1.7, w: 1920, h: 1080 },
    { x: -12.5, y: 40.25, zoom: 0.6, w: 400, h: 900 }, // tall and narrow
    { x: 3, y: 3, zoom: 2.3, w: 1000, h: 120 }, // short and wide
  ] as const;

  it.each(cases)('omits no tile that is partly on screen (%o)', ({ x, y, zoom, w, h }) => {
    const camera = new Camera({ x, y, zoom, viewportWidth: w, viewportHeight: h });
    const bounds = camera.visibleTileBounds();
    const viewport: ScreenPoint[] = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ];

    let visible = 0;
    for (let tx = bounds.minX - 3; tx <= bounds.maxX + 3; tx++) {
      for (let ty = bounds.minY - 3; ty <= bounds.maxY + 3; ty++) {
        if (!overlaps(tileQuad(camera, tx, ty), viewport)) continue;
        visible++;
        expect(
          tx >= bounds.minX && tx <= bounds.maxX && ty >= bounds.minY && ty <= bounds.maxY,
          `tile (${tx}, ${ty}) is on screen but outside ${JSON.stringify(bounds)}`,
        ).toBe(true);
      }
    }

    expect(visible).toBeGreaterThan(0);

    // Conservative is fine; wildly conservative is a culling bug waiting to
    // happen. A 45-degree-rotated rectangle's bounding box roughly doubles the
    // area, so anything past 4x means the maths is wrong rather than loose.
    const covered = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
    expect(covered).toBeLessThanOrEqual(visible * 4 + 64);
  });

  it('returns whole tile coordinates', () => {
    const camera = makeCamera({ x: 1.37, y: -9.62, zoom: 1.3 });
    const bounds = camera.visibleTileBounds();
    for (const value of [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]) {
      expect(Number.isInteger(value)).toBe(true);
    }
    expect(bounds.maxX).toBeGreaterThanOrEqual(bounds.minX);
    expect(bounds.maxY).toBeGreaterThanOrEqual(bounds.minY);
  });

  it('covers fewer tiles as the camera zooms in', () => {
    const camera = makeCamera({ zoom: 1 });
    const area = (): number => {
      const b = camera.visibleTileBounds();
      return (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
    };

    const wide = area();
    camera.setZoom(4);
    expect(area()).toBeLessThan(wide);
  });

  it('follows the camera when it pans', () => {
    const camera = makeCamera({ x: 0, y: 0, zoom: 1 });
    const before = camera.visibleTileBounds();
    camera.setPosition(1000, 1000);
    const after = camera.visibleTileBounds();

    expect(after.minX).toBeGreaterThan(before.maxX);
    expect(after.minY).toBeGreaterThan(before.maxY);
  });

  it('reports an empty range for a viewport with no area', () => {
    const camera = new Camera({ viewportWidth: 0, viewportHeight: 0 });
    const bounds = camera.visibleTileBounds();
    expect(bounds.maxX).toBeLessThan(bounds.minX);
    expect(bounds.maxY).toBeLessThan(bounds.minY);
  });

  it('grows when the viewport does', () => {
    const camera = makeCamera({ zoom: 1 });
    const small = camera.visibleTileBounds();
    camera.setViewport(VIEW_W * 2, VIEW_H * 2);
    const large = camera.visibleTileBounds();

    expect(large.maxX - large.minX).toBeGreaterThan(small.maxX - small.minX);
    expect(large.maxY - large.minY).toBeGreaterThan(small.maxY - small.minY);
  });
});
