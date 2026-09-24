import { describe, expect, it } from 'vitest';

import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { iconSpriteFor, paintedBox } from '../../src/renderer/item-icons.js';
import { describeSprite } from '../../src/renderer/sprite-atlas.js';

/**
 * Item pictures for the UI (C32): which sprite pictures an item, and how the
 * painted part of a scratch canvas is found. The baking itself needs a 2D
 * context and is checked in the running game.
 */

const buildings = new BuildingRegistry(BUILDINGS);

describe('which sprite pictures an item', () => {
  it('a building item is the building', () => {
    const miner = iconSpriteFor('miner', buildings);
    expect(miner.sprite).toBe(buildings.get('miner').sprite);
    expect(describeSprite(miner.sprite).kind).toBe('machine');
    // A 2x2 is painted at half the zoom of a 1x1, so both fill the scratch alike.
    expect(iconSpriteFor('chest', buildings).zoom).toBe(miner.zoom * 2);
  });

  it('anything else is the item as it rides a belt', () => {
    const plate = iconSpriteFor('iron_plate', buildings);
    expect(plate.sprite).toBe('item:iron_plate');
    expect(describeSprite(plate.sprite).kind).toBe('item');
  });

  it('names a real sprite for every building', () => {
    for (const definition of buildings.all()) {
      expect(describeSprite(iconSpriteFor(definition.id, buildings).sprite).kind).not.toBe('missing');
    }
  });
});

describe('the painted box', () => {
  it('is the smallest rectangle around every opaque pixel', () => {
    const side = 8;
    const pixels = new Uint8ClampedArray(side * side * 4);
    const paint = (x: number, y: number): void => {
      pixels[(y * side + x) * 4 + 3] = 255;
    };
    paint(2, 3);
    paint(5, 6);
    expect(paintedBox(pixels, side)).toEqual({ x: 2, y: 3, width: 4, height: 4 });
  });

  it('ignores antialiasing haze, and is null for an empty canvas', () => {
    const side = 4;
    const pixels = new Uint8ClampedArray(side * side * 4);
    pixels[3] = 2;
    expect(paintedBox(pixels, side)).toBeNull();
  });
});
