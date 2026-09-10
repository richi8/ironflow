import { describe, expect, it } from 'vitest';

import type { TileBounds } from '../../src/game/world/coordinates.js';
import { Camera } from '../../src/renderer/camera.js';
import { TALLEST_SPRITE_TILES, padBounds } from '../../src/renderer/canvas-renderer.js';

/**
 * C03 — culling. See ironflow.md C03 task 6 and §5 hazard 1.
 *
 * The bug this guards against is a row of tiles that pops in at the edge of
 * the screen when the camera moves. It is invisible in a screenshot and
 * obvious in motion, which makes it exactly the kind of thing to assert rather
 * than to look for.
 *
 * The property tested is one-directional on purpose: **every tile that touches
 * the viewport must be inside the bounds.** The converse is false and is meant
 * to be — C01's closing note records that `visibleTileBounds` returns the
 * bounding box of a rotated rectangle, so it over-covers at the corners by up
 * to a factor of two. Over-covering costs work; under-covering loses tiles.
 */

const VIEWPORT_W = 400;
const VIEWPORT_H = 240;

function contains(bounds: TileBounds, x: number, y: number): boolean {
  return x >= bounds.minX && x <= bounds.maxX && y >= bounds.minY && y <= bounds.maxY;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Does tile `(x, y)`'s ground face genuinely overlap the viewport rectangle?
 *
 * Separating-axis test between the face and the viewport, not a comparison of
 * their bounding boxes. A face's bounding box sticks out well past the face at
 * every corner, and a tile the box says is visible when the face is not may
 * legitimately fall outside the cull rectangle — the first draft of this file
 * used boxes and accused the camera of losing tiles it had correctly skipped.
 *
 * Overlap must exceed `TOUCH_EPSILON`, so tiles that merely graze the edge —
 * where floating point decides the answer — are not asserted either way.
 */
const TOUCH_EPSILON = 1e-6;

function touchesViewport(camera: Camera, x: number, y: number): boolean {
  const face = [
    camera.worldToScreen(x, y),
    camera.worldToScreen(x + 1, y),
    camera.worldToScreen(x + 1, y + 1),
    camera.worldToScreen(x, y + 1),
  ];
  const viewport = [
    { x: 0, y: 0 },
    { x: VIEWPORT_W, y: 0 },
    { x: VIEWPORT_W, y: VIEWPORT_H },
    { x: 0, y: VIEWPORT_H },
  ];

  for (const axis of [...edgeNormals(face), { x: 1, y: 0 }, { x: 0, y: 1 }]) {
    const a = project(face, axis);
    const b = project(viewport, axis);
    if (a.max - b.min <= TOUCH_EPSILON || b.max - a.min <= TOUCH_EPSILON) return false;
  }
  return true;
}

function edgeNormals(polygon: readonly Point[]): Point[] {
  const normals: Point[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const from = polygon[i];
    const to = polygon[(i + 1) % polygon.length];
    if (from === undefined || to === undefined) continue;
    normals.push({ x: from.y - to.y, y: to.x - from.x });
  }
  return normals;
}

function project(polygon: readonly Point[], axis: Point): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const point of polygon) {
    const value = point.x * axis.x + point.y * axis.y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
}

describe('cull bounds cover every partially visible tile', () => {
  const cases = [
    { label: 'at rest on the origin', x: 0, y: 0, zoom: 1 },
    { label: 'on a fractional position', x: 3.37, y: -2.61, zoom: 1 },
    { label: 'zoomed out', x: 0, y: 0, zoom: 0.25 },
    { label: 'zoomed in', x: 0, y: 0, zoom: 4 },
    { label: 'north-west of the origin', x: -40.5, y: -37.25, zoom: 0.5 },
    { label: 'between zoom steps', x: 11.1, y: -4.9, zoom: 1.37 },
  ];

  it.each(cases)('$label', ({ x, y, zoom }) => {
    const camera = new Camera({ x, y, zoom, viewportWidth: VIEWPORT_W, viewportHeight: VIEWPORT_H });
    const bounds = camera.visibleTileBounds();

    // Sweep well outside the bounds, so a tile the cull *missed* is still
    // examined rather than being outside the loop that would have caught it.
    for (let ty = bounds.minY - 6; ty <= bounds.maxY + 6; ty++) {
      for (let tx = bounds.minX - 6; tx <= bounds.maxX + 6; tx++) {
        if (!touchesViewport(camera, tx, ty)) continue;
        expect(contains(bounds, tx, ty), `tile (${tx}, ${ty}) is on screen but was culled`).toBe(true);
      }
    }
  });

  it('reports nothing visible before the viewport is known', () => {
    const camera = new Camera();
    const bounds = camera.visibleTileBounds();
    expect(bounds.maxX).toBeLessThan(bounds.minX);
    // And padding an empty rectangle must not conjure a tile into it.
    expect(padBounds(bounds, TALLEST_SPRITE_TILES)).toEqual(bounds);
  });
});

describe('padBounds', () => {
  it('grows the rectangle on every side', () => {
    const padded = padBounds({ minX: 0, minY: 0, maxX: 9, maxY: 9 }, 4);
    expect(padded).toEqual({ minX: -4, minY: -4, maxX: 13, maxY: 13 });
  });

  it('covers the ground tile of a sprite tall enough to reach into view', () => {
    // A three-tile-tall building standing just below the bottom edge still
    // shows its roof (§5 hazard 1). Its ground tile is off-screen, so only the
    // margin keeps it drawn.
    const camera = new Camera({ x: 0, y: 0, zoom: 1, viewportWidth: VIEWPORT_W, viewportHeight: VIEWPORT_H });
    const bounds = camera.visibleTileBounds();
    const padded = padBounds(bounds, TALLEST_SPRITE_TILES);

    const groundX = bounds.maxX + 1;
    const groundY = bounds.maxY + 1;
    expect(contains(bounds, groundX, groundY)).toBe(false);
    expect(contains(padded, groundX, groundY)).toBe(true);
  });
});
