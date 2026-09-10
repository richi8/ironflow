/**
 * Hand-placed entities so C03's depth sorting can be checked by eye.
 *
 * **Scaffolding.** C05 introduces the entity store and C06 places real
 * buildings; both of those delete this file. It exists for the same reason
 * C02's checkerboard generator does — two of C03's acceptance criteria are
 * "entities render in correct front-to-back order" and "a building never draws
 * over a building nearer the camera", and neither can be looked at in a world
 * with nothing in it.
 *
 * The arrangement is chosen to break a naive sort rather than to look nice:
 *
 * - three tall buildings in a diagonal line, so a wrong sign in the depth axis
 *   is immediately obvious;
 * - a 3x3 building beside a 1x1 one that shares part of its depth row, which
 *   is the multi-tile "sort by the maximum corner" rule (§5);
 * - two buildings on the same tile-sum with different layers, which only the
 *   layer bias separates;
 * - a belt running through the middle, which must pass *under* the buildings
 *   it shares a depth row with.
 *
 * It lives in `debug/` because `game/` may not know what a sprite is (§4).
 */

import { RenderLayer, type RenderEntity } from '../renderer/render-state.js';
import { BELT_SPRITES } from '../renderer/sprite-atlas.js';

const EAST = 1;

export function createDemoEntities(): RenderEntity[] {
  const entities: RenderEntity[] = [
    building(1, 2, 2, 'extraction', 'MI', 1, 1, 2),
    building(2, 5, 5, 'production', 'FU', 1, 1, 2),
    building(3, 8, 8, 'power', 'PP', 2, 2, 3),
    building(4, 11, 3, 'production', 'AS', 3, 3, 2),
    building(5, 14, 0, 'storage', 'CH', 1, 1, 1),
    // Same nearest corner as the chest above (14 + 0). Nothing separates these
    // two but the entity-id tie-break, so the pole draws in front of the chest
    // on every frame, in every run — never "whichever came first in the array".
    building(6, 13, 1, 'power', 'PO', 1, 1, 3),
    building(7, 4, 12, 'research', 'LA', 2, 2, 2),
    building(8, 0, 0, 'unknown-category', 'XX', 1, 1, 1),
  ];

  // A belt running east through the buildings' depth rows. Belt tile (11, 7)
  // sums to 18, exactly the nearest corner of the 3x3 assembler at (11, 3), so
  // the two are separated by the layer bias alone: the assembler must cover
  // that belt tile, and only that rule makes it.
  for (let i = 0; i < 16; i++) {
    entities.push({
      id: 100 + i,
      x: i,
      y: 7,
      width: 1,
      height: 1,
      sprite: BELT_SPRITES[EAST] ?? 'belt:1',
      layer: RenderLayer.Belt,
    });
  }

  return entities;
}

function building(
  id: number,
  x: number,
  y: number,
  category: string,
  code: string,
  width: number,
  height: number,
  rise: number,
): RenderEntity {
  return {
    id,
    x,
    y,
    width,
    height,
    sprite: `building:${category}:${code}:${width}x${height}:${rise}`,
    layer: RenderLayer.Building,
  };
}
