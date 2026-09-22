import { describe, expect, it } from 'vitest';

import { Camera } from '../../src/renderer/camera.js';
import { ScenePicker } from '../../src/renderer/picker.js';
import { RenderLayer, type RenderEntity } from '../../src/renderer/render-state.js';

/**
 * Picking an entity out of a scene. See ironflow.md C04 task 5 and C27A.
 *
 * This file was written for §5 hazard 2 — pointing at the roof of a three-tile
 * power plant used to highlight a tile three rows behind the building, because
 * `screenToTile` answers with the *ground* tile and the sprite was drawn
 * standing up. C27A removed the third dimension and with it the hazard: a
 * sprite covers its footprint and nothing else.
 *
 * What survives is the rest of the job, and it is still worth pinning. A
 * multi-tile building must name the tile actually pointed at rather than its
 * anchor; a pick must never name a tile the building does not stand on; and
 * two things sharing a tile must resolve to whichever one is drawn last,
 * decided by the depth key rather than by array order.
 *
 * Every case runs at three zooms, because a picker that forgets to divide by
 * zoom passes at 1x and nowhere else.
 */

const ZOOMS = [0.25, 1, 3.5];

function camera(zoom: number): Camera {
  const view = new Camera({ x: 6, y: 6, zoom, viewportWidth: 800, viewportHeight: 600 });
  view.setZoom(zoom); // no ease: tests want the zoom they asked for
  return view;
}

function building(id: number, x: number, y: number, width: number, height: number, bulk: number): RenderEntity {
  return {
    id,
    x,
    y,
    width,
    height,
    sprite: `building:production:XX:${width}x${height}:${bulk}`,
    layer: RenderLayer.Building,
  };
}

function belt(id: number, x: number, y: number): RenderEntity {
  return { id, x, y, width: 1, height: 1, sprite: 'belt:1', layer: RenderLayer.Belt };
}

describe('picking bare ground', () => {
  it.each(ZOOMS)('agrees with the camera when nothing is drawn (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const picker = new ScenePicker(view, () => []);

    for (const [sx, sy] of [
      [0, 0],
      [400, 300],
      [799, 599],
      [123, 457],
    ] as const) {
      const pick = picker.pick(sx, sy);
      expect(pick.entityId).toBeNull();
      expect(pick.tile).toEqual(view.screenToTile(sx, sy));
    }
  });

  it.each(ZOOMS)('ignores a building the cursor is not on (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const far = building(1, 40, 40, 1, 1, 3);
    const picker = new ScenePicker(view, () => [far]);

    const pick = picker.pick(400, 300);
    expect(pick.entityId).toBeNull();
    expect(pick.tile).toEqual(view.screenToTile(400, 300));
  });
});

describe('picking a building', () => {
  it.each(ZOOMS)('returns it from anywhere inside its footprint (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    for (const [dx, dy] of [
      [0.5, 0.5],
      [0.02, 0.02],
      [0.98, 0.98],
      [0.02, 0.98],
    ] as const) {
      const point = view.worldToScreen(5 + dx, 5 + dy);
      expect(picker.pick(point.x, point.y), `${dx},${dy}`).toEqual({ tile: { x: 5, y: 5 }, entityId: 1 });
    }
  });

  it.each(ZOOMS)('agrees with the camera about which tile that is (zoom %s)', (zoom) => {
    // The hazard-2 regression, from the other side: since C27A the entity
    // under a pixel always stands on the tile under that same pixel, so the
    // two answers can no longer disagree. A projection that grew a vertical
    // component again would break this immediately.
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    const point = view.worldToScreen(5.5, 5.5);
    expect(picker.pick(point.x, point.y).tile).toEqual(view.screenToTile(point.x, point.y));
  });

  it.each(ZOOMS)('misses the tiles around it (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    for (const [dx, dy] of [
      [-0.5, 0.5],
      [1.5, 0.5],
      [0.5, -0.5],
      [0.5, 1.5],
    ] as const) {
      const point = view.worldToScreen(5 + dx, 5 + dy);
      expect(picker.pick(point.x, point.y).entityId, `${dx},${dy}`).toBeNull();
    }
  });
});

describe('picking a multi-tile building', () => {
  it.each(ZOOMS)('names the tile of the footprint being pointed at (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const hall = building(1, 4, 4, 3, 3, 2);
    const picker = new ScenePicker(view, () => [hall]);

    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        const point = view.worldToScreen(4 + dx + 0.5, 4 + dy + 0.5);
        const pick = picker.pick(point.x, point.y);
        expect(pick, `tile ${dx},${dy}`).toEqual({ tile: { x: 4 + dx, y: 4 + dy }, entityId: 1 });
      }
    }
  });

  it.each(ZOOMS)('never names a tile outside the footprint (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const hall = building(1, 4, 4, 3, 3, 2);
    const picker = new ScenePicker(view, () => [hall]);

    for (let sx = 0; sx < 800; sx += 7) {
      for (let sy = 0; sy < 600; sy += 11) {
        const pick = picker.pick(sx, sy);
        if (pick.entityId === null) continue;
        expect(pick.tile.x).toBeGreaterThanOrEqual(4);
        expect(pick.tile.x).toBeLessThanOrEqual(6);
        expect(pick.tile.y).toBeGreaterThanOrEqual(4);
        expect(pick.tile.y).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('picking between overlapping entities', () => {
  it('prefers the higher layer when two entities share a tile', () => {
    const view = camera(1);
    const road = belt(1, 6, 6);
    // Same tile, same depth row, drawn later because Building > Belt.
    const box = building(2, 6, 6, 1, 1, 1);
    const picker = new ScenePicker(view, () => [box, road]);

    const anchor = view.worldToScreen(6.5, 6.5);
    expect(picker.pick(anchor.x, anchor.y).entityId).toBe(2);
  });

  it('prefers the larger id when layer and row tie, whatever the array order', () => {
    const view = camera(1);
    // Two ghosts of the same thing on the same tile cannot happen in the
    // world, but the tie-break must still be the id rather than the array —
    // §5's "never leave tie-break to array order".
    const first = building(1, 6, 6, 1, 1, 1);
    const second = building(2, 6, 6, 1, 1, 1);
    const anchor = view.worldToScreen(6.5, 6.5);

    expect(new ScenePicker(view, () => [first, second]).pick(anchor.x, anchor.y).entityId).toBe(2);
    expect(new ScenePicker(view, () => [second, first]).pick(anchor.x, anchor.y).entityId).toBe(2);
  });

  it('resolves a belt running under a multi-tile building to the building', () => {
    const view = camera(1);
    // A 1x3 hall over the middle of a line of belt. Each tile answers with
    // what is actually drawn on top of it — the hall where they overlap, the
    // belt where it runs clear.
    const hall = building(9, 6, 4, 1, 3, 2);
    const under = belt(1, 6, 5);
    const clear = belt(2, 6, 7);
    const picker = new ScenePicker(view, () => [under, clear, hall]);

    const shared = view.worldToScreen(6.5, 5.5);
    expect(picker.pick(shared.x, shared.y).entityId).toBe(9);

    const past = view.worldToScreen(6.5, 7.5);
    expect(picker.pick(past.x, past.y).entityId).toBe(2);
  });
});

describe('picking a flat entity', () => {
  it.each(ZOOMS)('covers its own tile and nothing beside it (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const road = belt(1, 6, 6);
    const picker = new ScenePicker(view, () => [road]);

    const anchor = view.worldToScreen(6.5, 6.5);
    expect(picker.pick(anchor.x, anchor.y)).toEqual({ tile: { x: 6, y: 6 }, entityId: 1 });

    const above = view.worldToScreen(6.5, 5.5);
    expect(picker.pick(above.x, above.y).entityId).toBeNull();
  });
});
