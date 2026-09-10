import { describe, expect, it } from 'vitest';

import { CHUNK_SIZE, createChunk } from '../../src/game/world/chunk.js';
import { TileType } from '../../src/game/world/tile.js';
import { World } from '../../src/game/world/world.js';
import {
  TerrainCache,
  snapToDevicePixel,
  zoomBucketIndex,
  zoomBucketScale,
} from '../../src/renderer/layers/terrain-layer.js';
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '../../src/renderer/camera.js';

/**
 * C03 — terrain caching. See ironflow.md C03 task 4 and §18 risk 6.
 *
 * The cache is generic over its value precisely so this file can run in the
 * `sim` project, where there is no canvas: the rules worth testing are when an
 * entry is stale and what gets evicted, and neither needs pixels.
 *
 * The staleness rule is the one with history. C02's closing note pointed out
 * that C03 could not key this on `dirty`, because `dirty` latches on the first
 * divergence and never clears — a cache trusting it would show the world as it
 * was at the second change, forever.
 */

describe('TerrainCache staleness', () => {
  it('returns an entry whose revision still matches', () => {
    const cache = new TerrainCache<string>({ maxEntries: 8, maxPixels: 1000 });
    cache.set(0, 0, 0, 3, 'bitmap', 10);
    expect(cache.get(0, 0, 0, 3)).toBe('bitmap');
  });

  it('drops an entry once the world chunk has changed under it', () => {
    const cache = new TerrainCache<string>({ maxEntries: 8, maxPixels: 1000 });
    cache.set(0, 0, 0, 3, 'bitmap', 10);

    expect(cache.get(0, 0, 0, 4)).toBeUndefined();
    // Dropped, not merely refused: keeping a bitmap nobody can use only costs
    // an eviction of something that is still good.
    expect(cache.size).toBe(0);
    expect(cache.pixels).toBe(0);
  });

  it('keeps the same world chunk at different zoom buckets apart', () => {
    const cache = new TerrainCache<string>({ maxEntries: 8, maxPixels: 1000 });
    cache.set(2, 3, 0, 1, 'near', 10);
    cache.set(2, 3, -4, 1, 'far', 10);

    expect(cache.get(2, 3, 0, 1)).toBe('near');
    expect(cache.get(2, 3, -4, 1)).toBe('far');
  });

  it('keeps neighbouring world chunks apart, including negative ones', () => {
    const cache = new TerrainCache<string>({ maxEntries: 16, maxPixels: 1000 });
    for (const [cx, cy] of [
      [0, 0],
      [-1, 0],
      [0, -1],
      [-1, -1],
      [1, 1],
    ] as const) {
      cache.set(cx, cy, 0, 1, `${cx},${cy}`, 10);
    }
    expect(cache.get(-1, -1, 0, 1)).toBe('-1,-1');
    expect(cache.get(0, -1, 0, 1)).toBe('0,-1');
    expect(cache.size).toBe(5);
  });

  it('releases the backing store of everything it drops', () => {
    const released: string[] = [];
    const cache = new TerrainCache<string>({
      maxEntries: 2,
      maxPixels: 1000,
      dispose: (value) => released.push(value),
    });
    cache.set(0, 0, 0, 1, 'a', 10);
    cache.set(1, 0, 0, 1, 'b', 10);
    cache.set(2, 0, 0, 1, 'c', 10);
    expect(released).toEqual(['a']);

    cache.clear();
    expect(released).toEqual(['a', 'b', 'c']);
    expect(cache.size).toBe(0);
  });
});

describe('TerrainCache eviction', () => {
  it('evicts least-recently-used, not least-recently-inserted', () => {
    const cache = new TerrainCache<string>({ maxEntries: 2, maxPixels: 1000 });
    cache.set(0, 0, 0, 1, 'a', 10);
    cache.set(1, 0, 0, 1, 'b', 10);

    cache.get(0, 0, 0, 1); // touch 'a', so 'b' is now the oldest
    cache.set(2, 0, 0, 1, 'c', 10);

    expect(cache.get(0, 0, 0, 1)).toBe('a');
    expect(cache.get(1, 0, 0, 1)).toBeUndefined();
  });

  it('honours the pixel budget as well as the entry count', () => {
    const cache = new TerrainCache<string>({ maxEntries: 100, maxPixels: 25 });
    cache.set(0, 0, 0, 1, 'a', 10);
    cache.set(1, 0, 0, 1, 'b', 10);
    cache.set(2, 0, 0, 1, 'c', 10);

    expect(cache.size).toBe(2);
    expect(cache.pixels).toBe(20);
    expect(cache.get(0, 0, 0, 1)).toBeUndefined();
  });

  it('keeps a single entry that is larger than the whole budget', () => {
    // Otherwise the cache would evict the bitmap it was just asked to store and
    // rebuild it on the very next frame, forever.
    const cache = new TerrainCache<string>({ maxEntries: 4, maxPixels: 5 });
    cache.set(0, 0, 0, 1, 'huge', 500);
    expect(cache.get(0, 0, 0, 1)).toBe('huge');
  });
});

/**
 * The signal the cache is keyed on. C02 added `revision` for this and nothing
 * else, so its transitions are C03's business to pin.
 */
describe('world-chunk revision', () => {
  it('starts at zero and moves on every real change', () => {
    const world = new World((cx, cy) => createChunk(cx, cy));
    const chunk = world.getChunk(0, 0);
    expect(chunk.revision).toBe(0);

    world.setTile(1, 1, TileType.Water);
    expect(chunk.revision).toBe(1);

    world.setResource(2, 2, 1, 500);
    expect(chunk.revision).toBe(2);

    world.consumeResource(2, 2, 10);
    expect(chunk.revision).toBe(3);
  });

  it('does not move when nothing actually changed', () => {
    const world = new World((cx, cy) => createChunk(cx, cy));
    const chunk = world.getChunk(0, 0);

    world.setTile(1, 1, TileType.Grass); // already grass
    world.consumeResource(3, 3, 5); // no resource there
    expect(chunk.revision).toBe(0);
  });

  it('moves again after the world chunk is already dirty', () => {
    // The whole reason `dirty` could not be the cache key: it says the same
    // thing after the first change as after the hundredth.
    const world = new World((cx, cy) => createChunk(cx, cy));
    const chunk = world.getChunk(0, 0);

    world.setTile(1, 1, TileType.Water);
    world.setTile(2, 1, TileType.Water);
    world.setTile(3, 1, TileType.Water);

    expect(chunk.dirty).toBe(true);
    expect(chunk.revision).toBe(3);
  });

  it('only moves for the world chunk that changed', () => {
    const world = new World((cx, cy) => createChunk(cx, cy));
    const origin = world.getChunk(0, 0);
    const neighbour = world.getChunk(1, 0);

    world.setTile(CHUNK_SIZE, 0, TileType.Stone);
    expect(origin.revision).toBe(0);
    expect(neighbour.revision).toBe(1);
  });
});

describe('zoom buckets', () => {
  it('never scales a bitmap up', () => {
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom *= 1.03) {
      const scale = zoomBucketScale(zoomBucketIndex(zoom));
      expect(scale).toBeGreaterThanOrEqual(zoom - 1e-9);
      expect(scale).toBeLessThanOrEqual(ZOOM_MAX);
    }
  });

  it('puts a wheel notch exactly on its own bucket', () => {
    // Zoom starts at 1 and every notch multiplies by ZOOM_STEP, so the resting
    // zoom is always a power of it — and a resting camera should blit 1:1.
    for (let step = -6; step <= 6; step++) {
      const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.pow(ZOOM_STEP, step)));
      expect(zoomBucketScale(zoomBucketIndex(zoom))).toBeCloseTo(zoom, 10);
    }
  });

  it('is monotonic, so zooming in never picks a coarser bitmap', () => {
    let previous = zoomBucketIndex(ZOOM_MIN);
    for (let zoom = ZOOM_MIN; zoom <= ZOOM_MAX; zoom *= 1.05) {
      const index = zoomBucketIndex(zoom);
      expect(index).toBeGreaterThanOrEqual(previous);
      previous = index;
    }
  });

  it('does not change bucket for a zoom sitting on a boundary', () => {
    expect(zoomBucketIndex(1)).toBe(zoomBucketIndex(1 - 1e-12));
  });
});

describe('snapToDevicePixel', () => {
  it('lands on a whole device pixel at any ratio', () => {
    for (const dpr of [1, 1.5, 2, 3]) {
      const snapped = snapToDevicePixel(10.37, dpr);
      expect(Math.abs(snapped * dpr - Math.round(snapped * dpr))).toBeLessThan(1e-9);
      expect(Math.abs(snapped - 10.37)).toBeLessThanOrEqual(0.5 / dpr + 1e-9);
    }
  });

  it('leaves the value alone rather than producing NaN for a degenerate ratio', () => {
    expect(snapToDevicePixel(10.37, 0)).toBe(10.37);
  });
});
