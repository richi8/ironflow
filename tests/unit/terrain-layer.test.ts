import { describe, expect, it, vi } from 'vitest';

import { CHUNK_SIZE, createChunk } from '../../src/game/world/chunk.js';
import { NOMINAL_RESOURCE_AMOUNT, ResourceType } from '../../src/game/world/resource.js';
import { TileType } from '../../src/game/world/tile.js';
import { createCheckerboardGenerator } from '../fixtures/world-fixtures.js';
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

function setup(zoom: number, generator = createCheckerboardGenerator()) {
  const atlas = countingAtlas();
  const surfaces: { width: number; height: number }[] = [];
  const layer = new TerrainLayer({
    atlas,
    createSurface: (w, h) => {
      surfaces.push({ width: w, height: h });
      return fakeSurface(w, h);
    },
  });
  const world = new World(generator);
  const camera = new Camera({ x: 0, y: 0, zoom, viewportWidth: VIEWPORT, viewportHeight: VIEWPORT });
  const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
  const bounds = camera.visibleTileBounds();
  return { atlas, surfaces, layer, world, camera, ctx, bounds };
}

/** One tile of ore at the origin, on an otherwise bare world. */
function oreAtOrigin(amount: number) {
  return (cx: number, cy: number) => {
    const chunk = createChunk(cx, cy);
    if (cx === 0 && cy === 0) {
      chunk.resource[0] = ResourceType.Iron;
      chunk.resourceAmount[0] = amount;
    }
    return chunk;
  };
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

/**
 * C09 task 3 — ore drawn over the terrain it sits on.
 *
 * It lives in this layer rather than the entity layer because a resource patch
 * is not an entity, and the interesting consequence is the cache: the bitmap
 * that holds the terrain holds the ore too, so a patch that thins as it is
 * mined has to invalidate the same entry a changed tile does. A layer that
 * drew ore correctly but never rebuilt would show a full patch over an empty
 * one for as long as the world chunk stayed on screen.
 */
describe('TerrainLayer resources', () => {
  it('draws an ore pile over the tile it sits on, and only there', () => {
    const { atlas, layer, world, camera, ctx, bounds } = setup(1, oreAtOrigin(NOMINAL_RESOURCE_AMOUNT));
    layer.draw(ctx, world, camera, bounds, 1);

    const ore = atlas.calls.filter((id) => id.startsWith('resource:'));
    expect(ore).toEqual(['resource:iron:3']);
  });

  it('draws nothing on a world with no ore in it', () => {
    const { atlas, layer, world, camera, ctx, bounds } = setup(1);
    layer.draw(ctx, world, camera, bounds, 1);

    expect(atlas.calls.some((id) => id.startsWith('resource:'))).toBe(false);
  });

  it('thins the pile as the tile is mined, and stops drawing it at zero', () => {
    // C09 acceptance 1 and 2, through the cache: `consumeResource` bumps the
    // world chunk's revision, which is the only reason the bitmap is rebuilt.
    const { atlas, layer, world, camera, ctx, bounds } = setup(1, oreAtOrigin(NOMINAL_RESOURCE_AMOUNT));
    layer.draw(ctx, world, camera, bounds, 1);

    atlas.calls.length = 0;
    world.consumeResource(0, 0, NOMINAL_RESOURCE_AMOUNT - 1);
    layer.draw(ctx, world, camera, bounds, 1);
    expect(layer.getStats().built).toBe(1);
    expect(atlas.calls.filter((id) => id.startsWith('resource:'))).toEqual(['resource:iron:0']);

    atlas.calls.length = 0;
    world.consumeResource(0, 0, 1);
    layer.draw(ctx, world, camera, bounds, 1);
    expect(layer.getStats().built).toBe(1);
    expect(atlas.calls.some((id) => id.startsWith('resource:'))).toBe(false);
  });

  it('draws ore on the uncached path too', () => {
    // At maximum zoom no bitmap is built at all (see above). A layer that only
    // drew ore into the cache would show bare ground when zoomed right in —
    // which is exactly when a player is looking at a patch.
    const { atlas, layer, world, camera, ctx } = setup(4, oreAtOrigin(NOMINAL_RESOURCE_AMOUNT));
    layer.draw(ctx, world, camera, camera.visibleTileBounds(), 1);

    expect(layer.getStats().direct).toBeGreaterThan(0);
    expect(atlas.calls).toContain('resource:iron:3');
  });
});
