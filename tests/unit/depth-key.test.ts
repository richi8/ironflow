import { describe, expect, it } from 'vitest';

import {
  DEPTH_ID_LIMIT,
  DEPTH_LAYER_STRIDE,
  DEPTH_TILE_STRIDE,
  depthKey,
  overlapsBounds,
} from '../../src/renderer/layers/entity-layer.js';
import { RenderLayer, type RenderEntity } from '../../src/renderer/render-state.js';

/**
 * C03 — depth sorting. See ironflow.md §5 and §18 risk 2.
 *
 * Risk 2 is "isometric depth sorting breaks with tall multi-tile buildings",
 * rated high likelihood. The failure is not a crash: it is a power plant that
 * looks correct until the day a belt runs behind it, at which point the belt
 * draws on top and the picture stops making sense. So the key is tested as an
 * ordering, not as a set of magic numbers.
 */

function entity(partial: Partial<RenderEntity> & { id: number }): RenderEntity {
  return {
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    sprite: 'building:storage:CH',
    layer: RenderLayer.Building,
    ...partial,
  };
}

describe('depthKey', () => {
  it('draws things further along x + y later', () => {
    expect(depthKey(entity({ id: 1, x: 0, y: 0 }))).toBeLessThan(depthKey(entity({ id: 1, x: 1, y: 0 })));
    expect(depthKey(entity({ id: 1, x: 0, y: 0 }))).toBeLessThan(depthKey(entity({ id: 1, x: 0, y: 1 })));
  });

  it('treats x and y as the same depth axis', () => {
    // (3, 1) and (1, 3) are the same distance along the depth axis, so only the
    // layer and the id may separate them — never the coordinates themselves.
    const a = depthKey(entity({ id: 7, x: 3, y: 1 }));
    const b = depthKey(entity({ id: 7, x: 1, y: 3 }));
    expect(a).toBe(b);
  });

  it('orders equal-depth entities by layer bias', () => {
    const belt = entity({ id: 900, x: 4, y: 4, layer: RenderLayer.Belt });
    const building = entity({ id: 1, x: 4, y: 4, layer: RenderLayer.Building });
    // The belt has the far larger id and still sorts behind: layer beats id.
    expect(depthKey(belt)).toBeLessThan(depthKey(building));
  });

  it('breaks remaining ties by entity id, not by array order', () => {
    const first = entity({ id: 12, x: 2, y: 2 });
    const second = entity({ id: 11, x: 2, y: 2 });
    expect(depthKey(second)).toBeLessThan(depthKey(first));

    const sorted = [first, second].sort((a, b) => depthKey(a) - depthKey(b));
    const reversed = [second, first].sort((a, b) => depthKey(a) - depthKey(b));
    expect(sorted.map((e) => e.id)).toEqual([11, 12]);
    expect(reversed.map((e) => e.id)).toEqual([11, 12]);
  });

  it('is injective over (depth, layer, id), so the ordering is total', () => {
    // Not over (x, y): two tiles on the same depth row are *meant* to collide,
    // which is what the layer bias and the id are there to resolve.
    const seen = new Set<number>();
    let count = 0;
    for (let depth = -6; depth <= 6; depth++) {
      for (const layer of [RenderLayer.Belt, RenderLayer.Building, RenderLayer.ItemOnBelt]) {
        for (const id of [0, 1, 2, DEPTH_ID_LIMIT - 1]) {
          seen.add(depthKey(entity({ id, x: depth, y: 0, layer })));
          count += 1;
        }
      }
    }
    expect(seen.size).toBe(count);
  });

  it('sorts a multi-tile building by its nearest corner', () => {
    // A 3x3 at (11, 3) reaches (13, 5): depth 18. A 1x1 at (14, 4) is also 18,
    // and a 1x1 at (15, 4) is 19 and must draw in front of the big building.
    const assembler = entity({ id: 1, x: 11, y: 3, width: 3, height: 3 });
    const same = entity({ id: 2, x: 14, y: 4 });
    const nearer = entity({ id: 3, x: 15, y: 4 });

    expect(depthKey(assembler)).toBeLessThan(depthKey(same)); // equal depth, id breaks it
    expect(depthKey(same)).toBeLessThan(depthKey(nearer));
    expect(depthKey(assembler)).toBeLessThan(depthKey(nearer));
  });

  it('never lets a nearer entity sort behind a further one, whatever its id', () => {
    const far = entity({ id: DEPTH_ID_LIMIT - 1, x: 5, y: 5, layer: RenderLayer.Overlay });
    const near = entity({ id: 0, x: 6, y: 5, layer: RenderLayer.Terrain });
    expect(depthKey(far)).toBeLessThan(depthKey(near));
  });

  it('stays exact in float64 at the extremes of tile space', () => {
    const key = depthKey(entity({ id: DEPTH_ID_LIMIT - 1, x: 32767, y: 32767, layer: RenderLayer.InserterArm }));
    expect(Number.isSafeInteger(key)).toBe(true);
    expect(key).toBe(65534 * DEPTH_TILE_STRIDE + RenderLayer.InserterArm * DEPTH_LAYER_STRIDE + DEPTH_ID_LIMIT - 1);
  });

  it('works west and north of the origin', () => {
    const key = depthKey(entity({ id: 4, x: -20, y: -20 }));
    expect(Number.isSafeInteger(key)).toBe(true);
    expect(key).toBeLessThan(depthKey(entity({ id: 4, x: -19, y: -20 })));
  });

  it('refuses an id it cannot encode rather than colliding silently', () => {
    expect(() => depthKey(entity({ id: DEPTH_ID_LIMIT }))).toThrow(RangeError);
    expect(() => depthKey(entity({ id: -1 }))).toThrow(RangeError);
    expect(() => depthKey(entity({ id: 1.5 }))).toThrow(RangeError);
  });
});

describe('overlapsBounds', () => {
  const bounds = { minX: 0, minY: 0, maxX: 9, maxY: 9 };

  it('includes an entity that only just touches the rectangle', () => {
    expect(overlapsBounds(entity({ id: 1, x: 9, y: 9 }), bounds)).toBe(true);
    expect(overlapsBounds(entity({ id: 1, x: 10, y: 9 }), bounds)).toBe(false);
  });

  it('includes a multi-tile building whose far corner reaches in', () => {
    expect(overlapsBounds(entity({ id: 1, x: -2, y: -2, width: 3, height: 3 }), bounds)).toBe(true);
    expect(overlapsBounds(entity({ id: 1, x: -3, y: -3, width: 3, height: 3 }), bounds)).toBe(false);
  });
});
