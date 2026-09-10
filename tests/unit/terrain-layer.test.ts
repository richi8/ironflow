import { describe, expect, it, vi } from 'vitest';

import { CHUNK_SIZE } from '../../src/game/world/chunk.js';
import { TileType } from '../../src/game/world/tile.js';
import { createCheckerboardGenerator } from '../../src/game/world/world-generator.js';
import { World } from '../../src/game/world/world.js';
import { Camera } from '../../src/renderer/camera.js';
import { TerrainLayer, type TerrainSurface } from '../../src/renderer/layers/terrain-layer.js';
import type { SpriteAtlas, SpriteId } from '../../src/renderer/sprite-atlas.js';

/**
 * C03 — the terrain layer, wired up. See ironflow.md C03 task 4.
 *
 * `terrain-cache.test.ts` proves the cache's rules in isolation. This proves
 * the layer obeys them: the failure it exists to catch is a layer that builds a
 * perfectly good bitmap and then stamps it with a constant, or looks it up
 * without the revision — either of which passes every unit test of the cache
 * and freezes the terrain on screen the first time a tile changes.
 *
 * §17 says not to test renderer pixel output, and this does not look at a
 * pixel. The surfaces are counters.
 */

const VIEWPORT = 640;

/** A drawing surface that records nothing and allocates nothing. */
function fakeSurface(width: number, height: number): TerrainSurface {
  return { ctx: fakeCtx(), image: {} as CanvasImageSource, width, height, release: () => {} };
}

function fakeCtx(): CanvasRenderingContext2D {
  return {} as CanvasRenderingContext2D;
}

/** Counts what it was asked to draw, and where. */
function countingAtlas(): SpriteAtlas & { calls: SpriteId[] } {
  const calls: SpriteId[] = [];
  return {
    kind: 'procedural',
    calls,
    draw: (_ctx, id) => {
      calls.push(id);
    },
  };
}

function setup(zoom: number) {
  const atlas = countingAtlas();
  const surfaces: { width: number; height: number }[] = [];
  const layer = new TerrainLayer({
    atlas,
    createSurface: (w, h) => {
      surfaces.push({ width: w, height: h });
      return fakeSurface(w, h);
    },
  });
  const world = new World(createCheckerboardGenerator());
  const camera = new Camera({ x: 0, y: 0, zoom, viewportWidth: VIEWPORT, viewportHeight: VIEWPORT });
  const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  const bounds = camera.visibleTileBounds();
  return { atlas, surfaces, layer, world, camera, ctx, bounds };
}

describe('TerrainLayer', () => {
  it('builds a world chunk once and blits it afterwards', () => {
    const { atlas, surfaces, layer, world, camera, ctx, bounds } = setup(1);

    layer.draw(ctx, world, camera, bounds, 1);
    const built = layer.getStats().built;
    expect(built).toBeGreaterThan(0);
    expect(surfaces).toHaveLength(built);
    expect(atlas.calls.length).toBeGreaterThanOrEqual(built * CHUNK_SIZE * CHUNK_SIZE);

    atlas.calls.length = 0;
    layer.draw(ctx, world, camera, bounds, 1);

    expect(layer.getStats().built).toBe(0);
    expect(layer.getStats().direct).toBe(0);
    // Not one path drawn on the second frame: every world chunk came from cache.
    expect(atlas.calls).toHaveLength(0);
  });

  it('rebuilds only the world chunk whose terrain changed', () => {
    const { layer, world, camera, ctx, bounds } = setup(1);
    layer.draw(ctx, world, camera, bounds, 1);
    const cached = layer.getStats().cached;

    world.setTile(1, 1, TileType.Water);
    layer.draw(ctx, world, camera, bounds, 1);

    expect(layer.getStats().built).toBe(1);
    expect(layer.getStats().cached).toBe(cached);
  });

  it('rebuilds again on the second change, which `dirty` alone could not tell it', () => {
    const { layer, world, camera, ctx, bounds } = setup(1);
    layer.draw(ctx, world, camera, bounds, 1);

    world.setTile(1, 1, TileType.Water);
    layer.draw(ctx, world, camera, bounds, 1);
    world.setTile(2, 1, TileType.Water);
    layer.draw(ctx, world, camera, bounds, 1);

    expect(layer.getStats().built).toBe(1);
  });

  it('does not rebuild when a write changed nothing', () => {
    const { layer, world, camera, ctx, bounds } = setup(1);
    layer.draw(ctx, world, camera, bounds, 1);

    world.setTile(1, 1, world.getTile(1, 1));
    layer.draw(ctx, world, camera, bounds, 1);

    expect(layer.getStats().built).toBe(0);
  });

  it('rebuilds at a zoom bucket it has not drawn before, and reuses the old one on the way back', () => {
    const { layer, world, camera, ctx } = setup(1);
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);
    const atZoomOne = layer.getStats().cached;

    camera.setZoom(0.5);
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);
    expect(layer.getStats().built).toBeGreaterThan(0);

    camera.setZoom(1);
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);
    expect(layer.getStats().built).toBe(0);
    expect(layer.getStats().cached).toBeGreaterThan(atZoomOne);
  });

  it('draws directly instead of caching when a world chunk would not fit a bitmap', () => {
    // At maximum zoom a world chunk is 8192x4096 — 32 MB to avoid drawing the
    // handful of tiles actually on screen.
    const { atlas, surfaces, layer, world, camera, ctx } = setup(4);
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);

    expect(surfaces).toHaveLength(0);
    expect(layer.getStats().direct).toBeGreaterThan(0);
    expect(layer.getStats().cached).toBe(0);
    // Bounded by the viewport, not by the 1,024 tiles each world chunk holds.
    expect(atlas.calls.length).toBeLessThan(CHUNK_SIZE * CHUNK_SIZE);
  });

  it('caps how many bitmaps it builds in one frame', () => {
    // Arriving somewhere new should cost a frame of direct drawing, not a stall
    // while fifty world chunks are rendered.
    const { layer, world, camera, ctx } = setup(0.25);
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);

    const stats = layer.getStats();
    expect(stats.built).toBeLessThanOrEqual(8);
    expect(stats.direct).toBeGreaterThan(0);
  });

  it('releases every surface it holds when destroyed', () => {
    const released: number[] = [];
    const layer = new TerrainLayer({
      atlas: countingAtlas(),
      createSurface: (w, h) => ({
        ctx: fakeCtx(),
        image: {} as CanvasImageSource,
        width: w,
        height: h,
        release: () => released.push(w * h),
      }),
    });
    const world = new World(createCheckerboardGenerator());
    const camera = new Camera({ x: 0, y: 0, zoom: 1, viewportWidth: VIEWPORT, viewportHeight: VIEWPORT });
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;

    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);
    const held = layer.getStats().cached;
    layer.destroy();

    expect(released).toHaveLength(held);
    expect(layer.getStats().cached).toBe(0);
  });
});
