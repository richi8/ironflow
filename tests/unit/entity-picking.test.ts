import { describe, expect, it } from 'vitest';

import { Camera } from '../../src/renderer/camera.js';
import { ScenePicker } from '../../src/renderer/picker.js';
import { RenderLayer, type RenderEntity } from '../../src/renderer/render-state.js';
import { RISE_UNIT } from '../../src/renderer/sprite-atlas.js';

/**
 * Picking a tile under a tall building. See ironflow.md §5 hazard 2 and C04.
 *
 * The hazard is specific and it is the reason this file exists: `screenToTile`
 * answers with the *ground* tile, so pointing at the roof of a three-tile
 * power plant highlights a tile three rows behind the building. §5 says entity
 * picking must additionally test sprite bounds in reverse depth order and
 * prefer the topmost hit, and C04 says implement it. These tests are what
 * "implemented" means.
 *
 * The acceptance criterion they carry is "hovering highlights exactly the tile
 * under the cursor at every zoom level, including over tall buildings", so
 * every case below is checked at three zooms rather than one — a picker that
 * forgets to divide by zoom passes at 1x and nowhere else.
 */

const ZOOMS = [0.25, 1, 3.5];

function camera(zoom: number): Camera {
  const view = new Camera({ x: 6, y: 6, zoom, viewportWidth: 800, viewportHeight: 600 });
  view.setZoom(zoom); // no ease: tests want the zoom they asked for
  return view;
}

function building(id: number, x: number, y: number, width: number, height: number, rise: number): RenderEntity {
  return {
    id,
    x,
    y,
    width,
    height,
    sprite: `building:production:XX:${width}x${height}:${rise}`,
    layer: RenderLayer.Building,
  };
}

function belt(id: number, x: number, y: number): RenderEntity {
  return { id, x, y, width: 1, height: 1, sprite: 'belt:1', layer: RenderLayer.Belt };
}

/** The pixel at the centre of an entity's drawn top face. */
function topFaceCentre(view: Camera, entity: RenderEntity, rise: number): { x: number; y: number } {
  const anchor = view.worldToScreen(entity.x + entity.width * 0.5, entity.y + entity.height * 0.5);
  return { x: anchor.x, y: anchor.y - rise * RISE_UNIT * view.zoom };
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

describe('picking over a tall building (§5 hazard 2)', () => {
  it.each(ZOOMS)('returns the building tile, not the ground behind it (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    const point = topFaceCentre(view, tower, 3);
    const pick = picker.pick(point.x, point.y);

    expect(pick).toEqual({ tile: { x: 5, y: 5 }, entityId: 1 });
    // The naive answer, and the bug this file exists to prevent: three rise
    // units up the screen is three tiles back along the depth axis.
    expect(view.screenToTile(point.x, point.y)).toEqual({ x: 2, y: 2 });
  });

  it.each(ZOOMS)('still returns the building from its ground face (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    const anchor = view.worldToScreen(5.5, 5.5);
    expect(picker.pick(anchor.x, anchor.y)).toEqual({ tile: { x: 5, y: 5 }, entityId: 1 });
  });

  it.each(ZOOMS)('misses above the roof and below the base (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const tower = building(1, 5, 5, 1, 1, 3);
    const picker = new ScenePicker(view, () => [tower]);

    const roof = topFaceCentre(view, tower, 3);
    expect(picker.pick(roof.x, roof.y - RISE_UNIT * zoom).entityId).toBeNull();

    const base = view.worldToScreen(5.5, 5.5);
    expect(picker.pick(base.x, base.y + RISE_UNIT * zoom).entityId).toBeNull();
  });
});

describe('picking a multi-tile building', () => {
  it.each(ZOOMS)('names the tile of the footprint being pointed at (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const hall = building(1, 4, 4, 3, 3, 2);
    const picker = new ScenePicker(view, () => [hall]);

    // Every tile of a flat-topped footprint is reachable: point at the top
    // face above each one and expect that one back.
    for (let dx = 0; dx < 3; dx++) {
      for (let dy = 0; dy < 3; dy++) {
        const anchor = view.worldToScreen(4 + dx + 0.5, 4 + dy + 0.5);
        const pick = picker.pick(anchor.x, anchor.y - 2 * RISE_UNIT * zoom);
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
  it('prefers the one drawn in front, by depth key', () => {
    const view = camera(1);
    // The tall tower at (5,5) covers the tile at (2,2) on screen. Whichever
    // one is drawn last is the one the player sees and the one they mean.
    const tower = building(1, 5, 5, 1, 1, 3);
    const flat = building(2, 2, 2, 1, 1, 1);
    const picker = new ScenePicker(view, () => [flat, tower]);

    const point = topFaceCentre(view, tower, 3);
    expect(picker.pick(point.x, point.y).entityId).toBe(1);

    // Array order must not decide it. The same two entities, shuffled, give
    // the same answer — §5's "never leave tie-break to array order".
    const reversed = new ScenePicker(view, () => [tower, flat]);
    expect(reversed.pick(point.x, point.y).entityId).toBe(1);
  });

  it('prefers the higher layer when two entities share a tile', () => {
    const view = camera(1);
    const road = belt(1, 6, 6);
    // Same tile, same depth row, drawn later because Building > Belt.
    const box = building(2, 6, 6, 1, 1, 1);
    const picker = new ScenePicker(view, () => [box, road]);

    const anchor = view.worldToScreen(6.5, 6.5);
    expect(picker.pick(anchor.x, anchor.y).entityId).toBe(2);
  });
});

describe('picking a flat entity', () => {
  it.each(ZOOMS)('covers its own tile and nothing above it (zoom %s)', (zoom) => {
    const view = camera(zoom);
    const road = belt(1, 6, 6);
    const picker = new ScenePicker(view, () => [road]);

    const anchor = view.worldToScreen(6.5, 6.5);
    expect(picker.pick(anchor.x, anchor.y)).toEqual({ tile: { x: 6, y: 6 }, entityId: 1 });
    expect(picker.pick(anchor.x, anchor.y - RISE_UNIT * zoom).entityId).toBeNull();
  });
});
