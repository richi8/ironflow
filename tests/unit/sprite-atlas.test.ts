import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TILE_TYPE_COUNT, TileType, tileProperties } from '../../src/game/world/tile.js';
import { PALETTE, color, shade } from '../../src/renderer/palette.js';
import { TERRAIN_SPRITES, describeSprite, terrainSprite } from '../../src/renderer/sprite-atlas.js';

/**
 * C03 — the placeholder atlas. See ironflow.md C03 task 3 and §11.
 *
 * §17 says not to test renderer pixel output, and this does not: it tests the
 * part that is not pixels. A sprite id resolving to the wrong descriptor draws
 * the wrong thing at every zoom in every layer, and that is a fact about a
 * string, not about a canvas.
 */

describe('sprite ids', () => {
  it('gives every terrain type a sprite named after the type itself', () => {
    expect(TERRAIN_SPRITES).toHaveLength(TILE_TYPE_COUNT);
    for (let type = 0; type < TILE_TYPE_COUNT; type++) {
      expect(terrainSprite(type)).toBe(`terrain:${tileProperties(type).name}`);
    }
  });

  it('gives every terrain type a colour, so none can draw as missing', () => {
    // The failure this catches is C19 adding a terrain type and the world
    // filling with magenta at the far edge of the map, months later.
    for (let type = 0; type < TILE_TYPE_COUNT; type++) {
      expect(describeSprite(terrainSprite(type)).kind).toBe('face');
    }
  });

  it('resolves terrain to its palette colour', () => {
    const grass = describeSprite(terrainSprite(TileType.Grass));
    expect(grass).toEqual({ kind: 'face', fill: color('terrain-grass') });
  });

  it('resolves a building with its category colour and code', () => {
    expect(describeSprite('building:extraction:MI')).toEqual({
      kind: 'prism',
      fill: color('accent'),
      code: 'MI',
      width: 1,
      height: 1,
      rise: 1,
    });
  });

  it('reads footprint and height off the id', () => {
    expect(describeSprite('building:power:PP:2x3:4')).toMatchObject({
      kind: 'prism',
      width: 2,
      height: 3,
      rise: 4,
    });
  });

  it('falls back to a neutral colour for a category nobody has coloured yet', () => {
    expect(describeSprite('building:teleportation:TP')).toMatchObject({
      kind: 'prism',
      fill: color('panel-high'),
    });
  });

  it('resolves each belt direction', () => {
    for (const rotation of [0, 1, 2, 3]) {
      expect(describeSprite(`belt:${rotation}`)).toEqual({ kind: 'belt', rotation });
    }
  });

  it('draws a marker rather than throwing on an id it cannot parse', () => {
    // A missing sprite is a content bug. One that takes the frame down with it
    // is a content bug you cannot see the rest of the screen to diagnose.
    for (const id of ['', 'nonsense', 'terrain:lava', 'belt:9', 'belt:', 'building:power', 'building::PP']) {
      expect(describeSprite(id), id).toEqual({ kind: 'missing' });
    }
  });

  it('rejects a malformed footprint instead of drawing a zero-size building', () => {
    for (const id of ['building:power:PP:0x2', 'building:power:PP:2', 'building:power:PP:2x2:0']) {
      expect(describeSprite(id), id).toEqual({ kind: 'missing' });
    }
  });

  it('memoises, so the draw path parses each id once', () => {
    expect(describeSprite('building:storage:CH')).toBe(describeSprite('building:storage:CH'));
  });
});

describe('shade', () => {
  it('darkens and lightens without leaving the byte range', () => {
    expect(shade('#808080', 0.5)).toBe('#404040');
    expect(shade('#808080', 4)).toBe('#ffffff');
    expect(shade('#808080', 0)).toBe('#000000');
  });

  it('leaves a colour it cannot parse alone rather than producing garbage', () => {
    expect(shade('rgba(63, 191, 127, 0.45)', 0.5)).toBe('rgba(63, 191, 127, 0.45)');
  });
});

/**
 * §11: "author these once in styles/tokens.css and use them everywhere — UI
 * **and** canvas. The renderer reads them from a TS constant mirror so canvas
 * and DOM never drift." A mirror nobody checks drifts the first time a colour
 * is nudged in one file; this is the check.
 */
describe('the palette mirrors tokens.css', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');
  const declared = new Map<string, string>();
  for (const match of css.matchAll(/--if-([a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    declared.set(match[1] ?? '', (match[2] ?? '').trim());
  }

  // `--if-radius` and `--if-font` are layout, not colour; the font is mirrored
  // separately as FONT_STACK because the atlas draws text with it.
  const colours = [...declared].filter(([name]) => name !== 'radius' && name !== 'font');

  it('found the stylesheet, so an empty match is not a pass', () => {
    expect(colours.length).toBeGreaterThan(20);
  });

  it.each(colours)('%s matches', (name, value) => {
    expect(PALETTE[name as keyof typeof PALETTE]).toBe(value);
  });

  it('mirrors nothing that tokens.css does not declare', () => {
    for (const name of Object.keys(PALETTE)) {
      expect(declared.has(name), `--if-${name} is in the palette but not in tokens.css`).toBe(true);
    }
  });
});
