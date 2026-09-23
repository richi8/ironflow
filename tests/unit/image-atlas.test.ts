import { describe, expect, it, vi } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { ITEMS } from '../../src/game/data/items.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import type { Rotation } from '../../src/game/world/coordinates.js';
import { atlasLevels, buildingSprite } from '../../src/renderer/entity-view.js';
import {
  ATLAS_GUTTER,
  ImageAtlas,
  layoutAtlas,
  layoutLevel,
  packShelves,
  spriteExtent,
  type AtlasLevel,
  type LevelSpec,
} from '../../src/renderer/image-atlas.js';
import {
  DETAIL_ZOOM,
  describeSprite,
  itemSprite,
  machineFrameSprite,
  playerSprite,
  type SpriteAtlas,
  type SpriteId,
} from '../../src/renderer/sprite-atlas.js';
import { EAST_STEP, SOUTH_STEP } from '../../src/renderer/sprite-geometry.js';
import { paintSprite } from '../../src/renderer/sprite-painter.js';

/**
 * C29 — the image atlas. See ironflow.md C29 art task 2 and §16 path 2.
 *
 * §17 says not to test pixels, and nothing here does. What is tested is the
 * arithmetic an image atlas lives or dies by — every sprite has a cell, no two
 * cells overlap, a cell is big enough for what is painted in it, and the right
 * level is drawn from at each zoom — which are facts about rectangles.
 */

const BUILDING_REGISTRY = new BuildingRegistry(BUILDINGS);
const ITEM_REGISTRY = new ItemRegistry(ITEMS);
const LEVELS = atlasLevels(BUILDING_REGISTRY, ITEM_REGISTRY);
const ROTATIONS: readonly Rotation[] = [0, 1, 2, 3];

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

describe('packShelves', () => {
  it('places every rectangle inside the sheet, with a gutter between any two', () => {
    const sizes = Array.from({ length: 60 }, (_unused, i) => ({ w: 10 + ((i * 37) % 50), h: 8 + ((i * 53) % 40) }));
    const packed = packShelves(sizes, 200);
    const rects = sizes.map((size, i) => ({ ...size, ...(packed.positions[i] ?? { x: 0, y: 0 }) }));
    for (const rect of rects) {
      expect(rect.x + rect.w).toBeLessThanOrEqual(packed.width);
      expect(rect.x + rect.w).toBeLessThanOrEqual(200);
      expect(rect.y + rect.h).toBeLessThanOrEqual(packed.height);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        if (a === undefined || b === undefined) continue;
        // Grown by the gutter, they still may not touch.
        const grown = { x: a.x, y: a.y, w: a.w + ATLAS_GUTTER, h: a.h + ATLAS_GUTTER };
        expect(overlaps(grown, b) || overlaps({ x: b.x, y: b.y, w: b.w + ATLAS_GUTTER, h: b.h + ATLAS_GUTTER }, a), `${i} ${j}`).toBe(false);
      }
    }
  });

  it('is deterministic, so the same content lays out the same sheet', () => {
    const sizes = [{ w: 5, h: 9 }, { w: 7, h: 9 }, { w: 3, h: 2 }];
    expect(packShelves(sizes, 20)).toEqual(packShelves(sizes, 20));
  });

  it('refuses a cell wider than the sheet rather than overflowing it', () => {
    expect(() => packShelves([{ w: 30, h: 1 }], 20)).toThrow(RangeError);
  });
});

describe('layoutLevel', () => {
  it('gives each id one cell, once, and skips ids that name nothing', () => {
    const level = layoutLevel({ scale: 1, detail: true, ids: ['belt:0:0', 'belt:0:0', 'nonsense', 'item:gear'] });
    expect(Object.keys(level.cells).sort()).toEqual(['belt:0:0', 'item:gear']);
  });

  it.each(LEVELS.map((spec) => [`${spec.scale}${spec.detail ? '' : ' plain'}`, spec] as const))(
    'lays out the shipped %s level without overlaps, anchors inside their cells',
    (_name, spec) => {
      const level = layoutLevel(spec);
      const cells = Object.values(level.cells);
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell.x + cell.w).toBeLessThanOrEqual(level.width);
        expect(cell.y + cell.h).toBeLessThanOrEqual(level.height);
        expect(cell.ax).toBeGreaterThan(0);
        expect(cell.ax).toBeLessThan(cell.w);
        expect(cell.ay).toBeGreaterThan(0);
        expect(cell.ay).toBeLessThan(cell.h);
      }
      // Sorted by row makes this linear-ish; the sheet has a few hundred cells.
      const sorted = [...cells].sort((a, b) => a.y - b.y || a.x - b.x);
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const a = sorted[i];
          const b = sorted[j];
          if (a === undefined || b === undefined) continue;
          if (b.y >= a.y + a.h) break;
          expect(overlaps(a, b)).toBe(false);
        }
      }
      // No browser refuses a canvas this size.
      expect(level.width).toBeLessThanOrEqual(8192);
      expect(level.height).toBeLessThanOrEqual(8192);
    },
  );

  it('produces a descriptor that survives JSON, so a painted sheet can ship one', () => {
    const descriptor = layoutAtlas(LEVELS);
    expect(JSON.parse(JSON.stringify(descriptor))).toEqual(descriptor);
    expect(descriptor.format).toBe('ironflow-atlas');
  });
});

describe('the atlas holds every sprite a frame asks for', () => {
  const [plain, detailed] = [LEVELS.find((spec) => !spec.detail), LEVELS.find((spec) => spec.detail)] as [LevelSpec, LevelSpec];

  it.each(BUILDINGS.map((building) => [building.id, building] as const))('%s, at every rotation, at rest and working', (_id, building) => {
    for (const rotation of ROTATIONS) {
      const still = buildingSprite(BUILDING_REGISTRY.get(building.id), rotation);
      expect(plain.ids, still).toContain(still);
      expect(detailed.ids, still).toContain(still);
    }
    if (building.sprite.startsWith('building:')) {
      for (let frame = 1; frame < 4; frame++) expect(detailed.ids).toContain(machineFrameSprite(building.sprite, frame));
    }
  });

  it('every item, and the player in every state, facing and frame', () => {
    for (const item of ITEMS) {
      expect(plain.ids).toContain(itemSprite(item.id));
      expect(detailed.ids).toContain(itemSprite(item.id));
    }
    for (const activity of ['idle', 'walk', 'work'] as const) {
      for (const facing of ROTATIONS) {
        expect(plain.ids).toContain(playerSprite(activity, facing, 0));
        for (let frame = 0; frame < 4; frame++) expect(detailed.ids).toContain(playerSprite(activity, facing, frame));
      }
    }
  });

  it('names nothing that parses to the missing marker', () => {
    for (const spec of LEVELS) {
      for (const id of spec.ids) expect(describeSprite(id).kind, id).not.toBe('missing');
    }
  });
});

/**
 * A 2D context that records the furthest any drawing call reached from the
 * anchor. Enough of the API for the painter; everything else is a no-op.
 */
function reachRecorder(): { ctx: CanvasRenderingContext2D; box: { minX: number; maxX: number; minY: number; maxY: number } } {
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const at = (x: number, y: number, r = 0): void => {
    box.minX = Math.min(box.minX, x - r);
    box.maxX = Math.max(box.maxX, x + r);
    box.minY = Math.min(box.minY, y - r);
    box.maxY = Math.max(box.maxY, y + r);
  };
  const noop = (): void => undefined;
  const ctx = {
    globalAlpha: 1,
    beginPath: noop,
    closePath: noop,
    fill: noop,
    stroke: noop,
    save: noop,
    restore: noop,
    fillText: noop,
    moveTo: at,
    lineTo: at,
    arc: (x: number, y: number, r: number) => at(x, y, r),
    ellipse: (x: number, y: number, rx: number, ry: number) => {
      at(x - rx, y - ry);
      at(x + rx, y + ry);
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      at(x, y);
      at(x + w, y + h);
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, box };
}

describe('the painter keeps inside each sprite’s extent', () => {
  // The baker clips every cell to its extent, so paint outside it would be
  // cut off in the game. This is the check that it never is: every sprite the
  // atlas bakes, painted around a known anchor, reaches no further than
  // `spriteExtent` says — at the detailed scale, where there is most to draw.
  const detailed = LEVELS.find((spec) => spec.detail && spec.scale === 1) as LevelSpec;
  const ids = [...new Set(detailed.ids)];

  it.each(ids.map((id) => [id]))('%s', (id) => {
    const { ctx, box } = reachRecorder();
    const sprite = describeSprite(id);
    paintSprite(ctx, sprite, 0, 0, 1, true);
    const extent = spriteExtent(sprite);
    // A pixel of slack for a line's own width, which the recorder does not see.
    const slack = 1;
    expect(box.minX, 'left').toBeGreaterThanOrEqual(0 - extent.left * EAST_STEP.x - slack);
    expect(box.maxX, 'right').toBeLessThanOrEqual(extent.right * EAST_STEP.x + slack);
    expect(box.minY, 'up').toBeGreaterThanOrEqual(0 - extent.up * SOUTH_STEP.y - slack);
    expect(box.maxY, 'down').toBeLessThanOrEqual(extent.down * SOUTH_STEP.y + slack);
  });
});

describe('ImageAtlas', () => {
  const descriptor = layoutAtlas([
    { scale: 0.25, detail: false, ids: ['belt:0:0'] },
    { scale: 0.5, detail: false, ids: ['belt:0:0'] },
    { scale: 1, detail: false, ids: ['belt:0:0'] },
    { scale: 0.5, detail: true, ids: ['belt:0:0', 'belt:0:3'] },
    { scale: 1, detail: true, ids: ['belt:0:0', 'belt:0:3'] },
    { scale: 2, detail: true, ids: ['belt:0:0', 'belt:0:3'] },
  ]);

  function atlas(): { atlas: ImageAtlas; fallback: SpriteAtlas & { calls: SpriteId[] }; made: AtlasLevel[] } {
    const calls: SpriteId[] = [];
    const fallback = { kind: 'procedural' as const, calls, draw: (_ctx: CanvasRenderingContext2D, id: SpriteId) => void calls.push(id) };
    const made: AtlasLevel[] = [];
    const image = new ImageAtlas(
      descriptor,
      (level) => {
        made.push(level);
        return { level } as unknown as CanvasImageSource;
      },
      fallback,
    );
    return { atlas: image, fallback, made };
  }

  it('draws from the smallest level at least as large as the screen needs', () => {
    const { atlas: image } = atlas();
    expect(image.levelFor(1)).toEqual({ scale: 1, detail: true });
    expect(image.levelFor(0.7)).toEqual({ scale: 1, detail: true });
    expect(image.levelFor(1.5)).toEqual({ scale: 2, detail: true });
    expect(image.levelFor(DETAIL_ZOOM)).toEqual({ scale: 0.5, detail: true });
  });

  it('uses the plain levels below DETAIL_ZOOM (C29 art task 4)', () => {
    const { atlas: image } = atlas();
    expect(image.levelFor(0.25)).toEqual({ scale: 0.25, detail: false });
    expect(image.levelFor(0.4)).toEqual({ scale: 0.5, detail: false });
  });

  it('counts device pixels: a 2x display at zoom 1 draws from the 2x level', () => {
    const { atlas: image } = atlas();
    image.setPixelRatio(2);
    expect(image.levelFor(1)).toEqual({ scale: 2, detail: true });
    // Below the threshold the plain set tops out at 1x, and is used anyway.
    expect(image.levelFor(0.45)).toEqual({ scale: 1, detail: false });
  });

  it('paints live above its largest level, and for an id it has no cell for', () => {
    const { atlas: image, fallback } = atlas();
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    expect(image.levelFor(3)).toBeNull();
    image.draw(ctx, 'belt:0:0', 0, 0, 3);
    image.draw(ctx, 'item:gear', 0, 0, 1);
    expect(fallback.calls).toEqual(['belt:0:0', 'item:gear']);
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it('copies the cell, scaled, with its anchor on the point asked for', () => {
    const { atlas: image } = atlas();
    const drawImage = vi.fn();
    const ctx = { drawImage } as unknown as CanvasRenderingContext2D;
    image.draw(ctx, 'belt:0:3', 100, 50, 0.5);
    const level = descriptor.levels.find((l) => l.detail && l.scale === 0.5) as AtlasLevel;
    const cell = level.cells['belt:0:3'];
    expect(cell).toBeDefined();
    if (cell === undefined) return;
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), cell.x, cell.y, cell.w, cell.h, 100 - cell.ax, 50 - cell.ay, cell.w, cell.h);
  });

  it('makes a level’s image only when it is first drawn from, and once', () => {
    const { atlas: image, made } = atlas();
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    expect(made).toHaveLength(0);
    image.draw(ctx, 'belt:0:0', 0, 0, 1);
    image.draw(ctx, 'belt:0:0', 0, 0, 1);
    expect(made.map((level) => [level.scale, level.detail])).toEqual([[1, true]]);
    image.prepare(2);
    expect(made.map((level) => [level.scale, level.detail])).toEqual([[1, true], [2, true]]);
  });
});
