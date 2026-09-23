import { describe, expect, it } from 'vitest';

import { newBelt } from '../../src/game/entities/belt-entity.js';
import { newChest } from '../../src/game/entities/chest-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH } from '../../src/game/world/coordinates.js';
import { TILE_TYPE_COUNT, TileType } from '../../src/game/world/tile.js';
import { World } from '../../src/game/world/world.js';
import { Camera } from '../../src/renderer/camera.js';
import { activityFrame, describeEntities, describePlayer, playerFrame } from '../../src/renderer/entity-view.js';
import { EntityLayer, depthKey } from '../../src/renderer/layers/entity-layer.js';
import { tileVariant } from '../../src/renderer/layers/terrain-layer.js';
import { RenderLayer, type RenderEntity } from '../../src/renderer/render-state.js';
import {
  JOINED_LEFT,
  JOINED_RIGHT,
  beltSprite,
  describeSprite,
  machineFrameSprite,
  playerSprite,
  terrainSprite,
  terrainVariantSprite,
  type SpriteAtlas,
  type SpriteId,
} from '../../src/renderer/sprite-atlas.js';

/**
 * C29 — animation, the grammar that carries it, and draw order.
 *
 * Animation is render-side time (§6), so what is testable is the part that is
 * a fact about state: a machine that is working names a working frame, one
 * that is not names its picture at rest, and nothing animates when asked not
 * to (C29 art task 4). How the frames *look* is checked by eye.
 */

function simulation(): Simulation {
  return new Simulation({ world: new World((cx, cy) => createChunk(cx, cy)) });
}

describe('the sprite grammar’s C29 tails', () => {
  it('names a working frame as a tail on the building id, and frame 0 as the id itself', () => {
    const base = 'building:extraction:MI:2x2:2';
    expect(machineFrameSprite(base, 0)).toBe(base);
    expect(machineFrameSprite(base, 2)).toBe(`${base}:f2`);
    expect(describeSprite(`${base}:f2`)).toEqual({ ...describeSprite(base), frame: 2 });
    // The tail works on a short id too, and is not mistaken for a footprint.
    expect(describeSprite('building:storage:CH:f1')).toMatchObject({ kind: 'machine', width: 1, height: 1, bulk: 1, frame: 1 });
    expect(describeSprite(`${base}:f4`).kind).toBe('missing');
  });

  it('gives the player a frame, and leaves C10’s id meaning frame 0', () => {
    expect(playerSprite('walk', 1, 3)).toBe('player:walk:1:3');
    expect(describeSprite('player:walk:1:3')).toEqual({ kind: 'player', activity: 'walk', facing: 1, frame: 3 });
    expect(describeSprite('player:walk:1:4').kind).toBe('missing');
    expect(describeSprite('player:walk:1:').kind).toBe('missing');
  });

  it('gives every terrain type four variants in its own colour', () => {
    for (let type = 0; type < TILE_TYPE_COUNT; type++) {
      const plain = describeSprite(terrainSprite(type));
      for (let variant = 0; variant < 4; variant++) {
        const sprite = describeSprite(terrainVariantSprite(type, variant));
        expect(sprite).toMatchObject({ kind: 'face', variant });
        expect(sprite.kind === 'face' && plain.kind === 'face' && sprite.fill === plain.fill).toBe(true);
      }
    }
    expect(describeSprite('terrain:grass:9').kind).toBe('missing');
  });

  it('picks a tile’s variant from where it is, the same way every time', () => {
    const seen = new Set<number>();
    for (let y = -20; y < 20; y++) {
      for (let x = -20; x < 20; x++) {
        const variant = tileVariant(x, y);
        expect(variant).toBe(tileVariant(x, y));
        seen.add(variant);
      }
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(terrainVariantSprite(TileType.Grass, tileVariant(3, 4))).toMatch(/^terrain:grass:[0-3]$/);
  });

  it('draws each item as a shape of its own kind', () => {
    const shape = (id: string): unknown => {
      const sprite = describeSprite(`item:${id}`);
      return sprite.kind === 'item' ? sprite.shape : null;
    };
    expect(shape('iron_ore')).toBe('lump');
    expect(shape('coal')).toBe('lump');
    expect(shape('copper_plate')).toBe('plate');
    expect(shape('gear')).toBe('gear');
    expect(shape('copper_wire')).toBe('coil');
    expect(shape('circuit')).toBe('chip');
    expect(shape('assembler')).toBe('crate');
  });
});

describe('a belt fed from the side (2026-09-23)', () => {
  it('names the sides another carrier faces into, and nothing else', () => {
    const sim = simulation();
    // An east line at y 2; one belt comes up into it from the south (its
    // right), one comes down from the north (its left), one points away.
    const line = sim.entities.create(newBelt(3, 2, EAST));
    const fromLeft = sim.entities.create(newBelt(5, 2, EAST));
    const plain = sim.entities.create(newBelt(7, 2, EAST));
    sim.entities.create(newBelt(3, 3, NORTH));
    sim.entities.create(newBelt(5, 1, SOUTH));
    sim.entities.create(newBelt(7, 3, SOUTH));

    const drawn = describeEntities(sim.entities, sim.buildings, 0, { animate: false });
    const sprite = (id: number): SpriteId => drawn.find((entity) => entity.id === id)?.sprite ?? '';
    expect(sprite(line.id)).toBe(beltSprite(EAST, 0, JOINED_RIGHT));
    expect(sprite(fromLeft.id)).toBe(beltSprite(EAST, 0, JOINED_LEFT));
    expect(sprite(plain.id)).toBe(beltSprite(EAST, 0));
  });
});

describe('machines animate while they work (C29 art task 3)', () => {
  it('only a working machine is drawn on its activity cycle', () => {
    const sim = simulation();
    const working = sim.entities.create<MinerEntity>(newMiner(0, 0, NORTH));
    const stalled = sim.entities.create<MinerEntity>(newMiner(4, 0, NORTH));
    working.status = MachineStatus.Running;
    stalled.status = MachineStatus.OutputFull;
    sim.entities.create(newChest(8, 0, NORTH));

    const drawn = describeEntities(sim.entities, sim.buildings, 1.25);
    const sprite = (id: number): SpriteId => drawn.find((entity) => entity.id === id)?.sprite ?? '';
    const base = sim.buildings.get('miner').sprite;
    expect(sprite(working.id)).toBe(machineFrameSprite(base, activityFrame(1.25)));
    expect(sprite(stalled.id)).toBe(base);
  });

  it('cycles through frames 1 to 3 and never shows the resting frame while working', () => {
    const frames = new Set<number>();
    for (let t = 0; t < 3; t += 0.01) frames.add(activityFrame(t));
    expect([...frames].sort()).toEqual([1, 2, 3]);
  });

  it('holds everything still when asked, belts included (art task 4)', () => {
    const sim = simulation();
    const miner = sim.entities.create<MinerEntity>(newMiner(0, 0, NORTH));
    miner.status = MachineStatus.Running;
    sim.entities.create(newBelt(4, 0, EAST));
    const still = describeEntities(sim.entities, sim.buildings, 0.37, { animate: false });
    expect(still.map((entity) => entity.sprite)).toEqual([sim.buildings.get('miner').sprite, 'belt:1:0']);
  });

  it('gives the player a frame per activity, and frame 0 when still', () => {
    const view = { x: 0, y: 0, facing: 2, activity: 'walk', buildRange: 10, mining: null } as const;
    expect(describePlayer(view as never, 0.3).sprite).toBe(playerSprite('walk', 2, playerFrame('walk', 0.3)));
    expect(describePlayer(view as never, 0.3, false).sprite).toBe(playerSprite('walk', 2, 0));
    const frames = new Set<number>();
    for (let t = 0; t < 2; t += 0.01) frames.add(playerFrame('walk', t));
    expect([...frames].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('the entity layer draws in depth order (§5)', () => {
  it('paints in ascending depth key, and items sharing a key in the order they came', () => {
    const drawn: SpriteId[] = [];
    const atlas: SpriteAtlas = { kind: 'procedural', draw: (_ctx, id) => void drawn.push(id) };
    const layer = new EntityLayer(atlas);
    const entity = (id: number, x: number, y: number, layerBias: RenderLayer, sprite: string, depthRow?: number): RenderEntity =>
      depthRow === undefined
        ? { id, x, y, width: 1, height: 1, sprite, layer: layerBias }
        : { id, x, y, width: 1, height: 1, sprite, layer: layerBias, depthRow };
    const entities = [
      entity(7, 0, 2, RenderLayer.Building, 'c'),
      entity(3, 0, 0, RenderLayer.Building, 'a'),
      entity(5, 0, 2, RenderLayer.Belt, 'b'),
      entity(9, 1, 0, RenderLayer.Building, 'a2'),
    ];
    const items = [entity(0, 0, 2, RenderLayer.ItemOnBelt, 'i1', 2), entity(0, 0.2, 2, RenderLayer.ItemOnBelt, 'i2', 2)];
    const camera = new Camera({ x: 0, y: 0, zoom: 1, viewportWidth: 800, viewportHeight: 600 });
    layer.draw({} as CanvasRenderingContext2D, entities, camera, { minX: -10, minY: -10, maxX: 10, maxY: 10 }, null, items);

    const order = [...entities, ...items].sort((a, b) => depthKey(a) - depthKey(b)).map((e) => e.sprite);
    expect(drawn).toEqual(order);
    expect(drawn).toEqual(['a', 'a2', 'b', 'c', 'i1', 'i2']);
  });
});
