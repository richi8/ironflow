import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { buildingSprite } from '../../src/renderer/entity-view.js';
import { ITEMS } from '../../src/game/data/items.js';
import {
  NOMINAL_RESOURCE_AMOUNT,
  RESOURCE_BUCKET_COUNT,
  RESOURCE_TYPES,
  ResourceType,
  resourceName,
} from '../../src/game/world/resource.js';
import { TILE_TYPE_COUNT, TileType, tileProperties } from '../../src/game/world/tile.js';
import { PALETTE, color, shade } from '../../src/renderer/palette.js';
import {
  INSERTER_SWING_STEPS,
  RESOURCE_SPRITES,
  TERRAIN_SPRITES,
  describeSprite,
  inserterSprite,
  playerSprite,
  resourceSprite,
  terrainSprite,
  undergroundSprite,
} from '../../src/renderer/sprite-atlas.js';

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

  it('gives every resource a sprite per fullness bucket, named after the resource', () => {
    for (const type of RESOURCE_TYPES) {
      const sprites = RESOURCE_SPRITES[type];
      expect(sprites, resourceName(type)).toHaveLength(RESOURCE_BUCKET_COUNT);
      for (let bucket = 0; bucket < RESOURCE_BUCKET_COUNT; bucket++) {
        expect(sprites?.[bucket]).toBe(`resource:${resourceName(type)}:${bucket}`);
      }
    }
  });

  it('gives every resource a colour, so none can draw as missing', () => {
    // §11 names one tint token per resource. The failure this catches is C19
    // adding a resource and a whole ore field turning magenta at the far edge
    // of the map, months later.
    for (const type of RESOURCE_TYPES) {
      for (let bucket = 0; bucket < RESOURCE_BUCKET_COUNT; bucket++) {
        expect(describeSprite(RESOURCE_SPRITES[type]?.[bucket] ?? '').kind, resourceName(type)).toBe('resource');
      }
    }
  });

  it('resolves ore to its palette tint and its fullness', () => {
    expect(describeSprite('resource:copper:2')).toEqual({ kind: 'resource', fill: color('copper'), bucket: 2 });
  });

  it('draws nothing at all on bare or exhausted ground', () => {
    // C09 acceptance 2 and 3, as one string-level fact: an exhausted tile is
    // not a thin pile, it is no pile.
    expect(resourceSprite(ResourceType.Iron, 0)).toBeNull();
    expect(resourceSprite(ResourceType.None, 0)).toBeNull();
  });

  it('picks a thinner pile as a tile is worked out', () => {
    const full = resourceSprite(ResourceType.Iron, NOMINAL_RESOURCE_AMOUNT);
    const nearlyGone = resourceSprite(ResourceType.Iron, 1);
    expect(full).toBe('resource:iron:3');
    expect(nearlyGone).toBe('resource:iron:0');
  });

  it('marks ore with a type nothing defines rather than drawing it as plain ground', () => {
    // A tile carrying an amount but no type is a corrupt world chunk, and a
    // magenta tile is how a save bug gets noticed instead of absorbed.
    expect(resourceSprite(ResourceType.None, 100)).toBe('missing');
  });

  it('resolves a building with its category colour and code', () => {
    expect(describeSprite('building:extraction:MI')).toEqual({
      kind: 'machine',
      fill: color('accent'),
      code: 'MI',
      width: 1,
      height: 1,
      bulk: 1,
    });
  });

  it('reads footprint and bulk off the id', () => {
    // The fourth field was an extrusion height until C27A and is the shadow's
    // length now. The grammar did not move, so neither did `data/buildings.ts`.
    expect(describeSprite('building:power:PP:2x3:4')).toMatchObject({
      kind: 'machine',
      width: 2,
      height: 3,
      bulk: 4,
    });
  });

  it('falls back to a neutral colour for a category nobody has coloured yet', () => {
    expect(describeSprite('building:teleportation:TP')).toMatchObject({
      kind: 'machine',
      fill: color('panel-high'),
    });
  });

  it('resolves each belt direction, with and without an animation phase', () => {
    for (const rotation of [0, 1, 2, 3]) {
      // A belt named without a phase is a still one: the ghost has a direction
      // and no animation, and must not have to invent a frame number (C13).
      expect(describeSprite(`belt:${rotation}`)).toEqual({ kind: 'belt', rotation, phase: 0 });
      expect(describeSprite(`belt:${rotation}:5`)).toEqual({ kind: 'belt', rotation, phase: 5 });
    }
    // Out-of-range phases wrap rather than draw a magenta marker: the phase is
    // a wall-clock frame counter, and a renderer that stopped drawing belts
    // because a counter ran past eight would be the worst kind of bug.
    expect(describeSprite('belt:1:11')).toEqual({ kind: 'belt', rotation: 1, phase: 3 });
    expect(describeSprite('belt:1:x')).toEqual({ kind: 'missing' });
    // 2026-09-23: which sides another belt feeds in from.
    expect(describeSprite('belt:1:3:j2')).toEqual({ kind: 'belt', rotation: 1, phase: 3, joined: 2 });
    expect(describeSprite('belt:1:3:j0')).toEqual({ kind: 'missing' });
    expect(describeSprite('belt:1:3:2')).toEqual({ kind: 'missing' });
  });

  it('resolves an underground mouth at each facing, and each end of a run', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      expect(describeSprite(undergroundSprite(rotation, true))).toEqual({
        kind: 'underground',
        rotation,
        entrance: true,
      });
      expect(describeSprite(undergroundSprite(rotation, false))).toEqual({
        kind: 'underground',
        rotation,
        entrance: false,
      });
    }
    // The two ends must be **different pictures** — C22's argument against the
    // fast belt, one building later: a player tracing a buried line has to see
    // which way it goes without counting chevrons.
    expect(undergroundSprite(1, true)).not.toBe(undergroundSprite(1, false));
    expect(describeSprite('underground:1')).toEqual({ kind: 'missing' });
    expect(describeSprite('underground:1:sideways')).toEqual({ kind: 'missing' });
    expect(describeSprite('underground:4:in')).toEqual({ kind: 'missing' });
  });

  it('resolves an inserter arm at each facing, with and without an item in it', () => {
    for (const rotation of [0, 1, 2, 3] as const) {
      expect(describeSprite(inserterSprite(rotation, 0, false))).toEqual({
        kind: 'inserter',
        rotation,
        swing: 0,
        holding: false,
      });
      expect(describeSprite(inserterSprite(rotation, INSERTER_SWING_STEPS, true))).toEqual({
        kind: 'inserter',
        rotation,
        swing: INSERTER_SWING_STEPS,
        holding: true,
      });
    }
  });

  it('clamps a swing past the far end rather than wrapping it back to the near one', () => {
    // Unlike the belt's phase, a swing is a sweep with two ends. An arm that
    // wrapped would snap from the destination back to the source mid-drop,
    // which reads as an inserter that dropped the item on the floor (C14).
    expect(describeSprite(`inserter:1:${INSERTER_SWING_STEPS + 40}`)).toEqual({
      kind: 'inserter',
      rotation: 1,
      swing: INSERTER_SWING_STEPS,
      holding: false,
    });
    expect(describeSprite('inserter:1:x')).toEqual({ kind: 'missing' });
    expect(describeSprite('inserter:1:4:z')).toEqual({ kind: 'missing' });
  });

  it('draws a marker rather than throwing on an id it cannot parse', () => {
    // A missing sprite is a content bug. One that takes the frame down with it
    // is a content bug you cannot see the rest of the screen to diagnose.
    for (const id of [
      '',
      'nonsense',
      'terrain:lava',
      'belt:9',
      'belt:',
      'building:power',
      'building::PP',
      'resource:iron',
      'resource:iron:',
      'resource:iron:4',
      'resource:unobtanium:1',
    ]) {
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

describe('the player sprite (C10)', () => {
  it('names the state and the facing, which is how an atlas cell is addressed', () => {
    expect(playerSprite('walk', 1)).toBe('player:walk:1');
    expect(describeSprite(playerSprite('work', 3))).toEqual({ kind: 'player', activity: 'work', facing: 3 });
  });

  it('resolves all three states at all four facings', () => {
    for (const activity of ['idle', 'walk', 'work'] as const) {
      for (const facing of [0, 1, 2, 3] as const) {
        expect(describeSprite(playerSprite(activity, facing)).kind, `${activity}:${facing}`).toBe('player');
      }
    }
  });

  it('refuses a state or a facing it does not have, rather than inventing one', () => {
    expect(describeSprite('player:sprint:0').kind).toBe('missing');
    expect(describeSprite('player:idle:4').kind).toBe('missing');
    // `Number('')` is 0, so an empty facing must not parse as north.
    expect(describeSprite('player:idle:').kind).toBe('missing');
    expect(describeSprite('player:idle').kind).toBe('missing');
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
  for (const match of css.matchAll(/--if-([a-z0-9_-]+)\s*:\s*([^;]+);/g)) {
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

/**
 * Every sprite the content tables name (C16).
 *
 * The atlas draws a magenta marker rather than throwing on an id it cannot
 * parse, which is the right behaviour in a frame and the wrong one in a test
 * suite: a building added with a typo in its sprite id would ship, and the
 * first anybody heard of it would be a magenta box where the assembler is.
 * This is the check that makes it a content error at build time instead.
 */
describe('the shipped content draws', () => {
  it.each(BUILDINGS.map((building) => [building.id, building]))('%s has a sprite', (_id, building) => {
    // Through `buildingSprite`, because that is the path a frame takes: a
    // belt's content sprite is the *stem* `belt` and only `entity-view.ts` is
    // allowed to know it becomes `belt:2` (§4). Asking the atlas about the
    // stem would be asking it a question the renderer never asks.
    const rotations: readonly Rotation[] = [NORTH, EAST, SOUTH, WEST];
    for (const rotation of rotations) {
      expect(describeSprite(buildingSprite(building, rotation)).kind).not.toBe('missing');
    }
  });

  it.each(ITEMS.map((item) => [item.id, item.sprite]))('%s has a sprite', (_id, sprite) => {
    expect(describeSprite(sprite).kind).toBe('item');
  });

  it('gives every item a colour of its own family, never the fallback grey', () => {
    // An item whose name does not reach a palette token draws as muted text,
    // which is legible and anonymous — fine as a guard, wrong as an answer for
    // something the player sorts by colour on a belt.
    for (const item of ITEMS) {
      const sprite = describeSprite(item.sprite);
      expect(sprite.kind === 'item' && sprite.fill, item.id).not.toBe(color('text-muted'));
    }
  });
});
