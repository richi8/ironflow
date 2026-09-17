import { describe, expect, it } from 'vitest';

import { laneAccept, newBelt, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { newSplitter, splitterTile, type SplitterEntity } from '../../src/game/entities/splitter-entity.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { buildingSprite, describeBeltItems, describeEntities } from '../../src/renderer/entity-view.js';
import { RenderLayer } from '../../src/renderer/render-state.js';
import { describeSprite, splitterSprite } from '../../src/renderer/sprite-atlas.js';

/**
 * The splitter as the renderer sees it. C17 task 4.
 *
 * The task asks for "the splitter sprite, with the belt lane drawn
 * continuously through it", and the part of that a test can hold is the part
 * that is a *fact*: which layer it draws in, how wide it is at each rotation,
 * and where the items inside it are. What the chevrons actually look like is
 * placeholder art until C29 and is checked by looking at it.
 */

function simulation(): Simulation {
  return new Simulation({ world: new World((cx, cy) => createChunk(cx, cy)) });
}

const REGISTRY = new BuildingRegistry(BUILDINGS);
const SPLITTER = REGISTRY.get('splitter');

describe('the splitter sprite', () => {
  it('names a real picture at every rotation, ghost included', () => {
    for (const rotation of [0, 1, 2, 3] as Rotation[]) {
      expect(buildingSprite(SPLITTER, rotation)).toBe(splitterSprite(rotation));
      expect(describeSprite(splitterSprite(rotation)).kind).toBe('splitter');
    }
    // A malformed id draws the marker rather than a north-facing splitter.
    expect(describeSprite('splitter:').kind).toBe('missing');
    expect(describeSprite('splitter:4:0').kind).toBe('missing');
  });

  it('lies as flat as the belt it sits in, and takes its rotated extent', () => {
    const sim = simulation();
    sim.entities.create<SplitterEntity>(newSplitter(3, 3, NORTH));
    sim.entities.create<SplitterEntity>(newSplitter(6, 6, EAST));

    const drawn = describeEntities(sim.entities, sim.buildings);
    const north = drawn.find((entity) => entity.x === 3);
    const east = drawn.find((entity) => entity.x === 6);

    expect(north?.layer).toBe(RenderLayer.Belt);
    expect(east?.layer).toBe(RenderLayer.Belt);
    // Two across the flow, one deep — and the odd rotation swaps it, exactly
    // as `footprintExtent` does for the entity itself (C05).
    expect([north?.width, north?.height]).toEqual([2, 1]);
    expect([east?.width, east?.height]).toEqual([1, 2]);
  });

  it('animates on the belt chevron cycle, since an item does not change speed in it', () => {
    // Two ids one phase apart, taken a fraction of a second apart, which is
    // only possible if the splitter is read the same clock as the belt.
    const belt = REGISTRY.get('belt');
    const speed = SPLITTER.splitter?.tilesPerSecond;
    expect(speed).toBe(belt.belt?.tilesPerSecond);
    expect(buildingSprite(SPLITTER, EAST, 3)).toBe(splitterSprite(EAST, 3));
  });
});

describe('items inside a splitter', () => {
  it('draws each lane on its own footprint tile, alongside the belts', () => {
    const sim = simulation();
    const splitter = sim.entities.create<SplitterEntity>(newSplitter(6, 6, EAST));
    const belt = sim.entities.create<BeltEntity>(newBelt(5, 6, EAST));
    const iron = sim.items.idOf('iron_ore');

    laneAccept(belt.items, iron, 128);
    laneAccept(splitter.lanes[0], iron, 128);
    laneAccept(splitter.lanes[1], iron, 128);

    const drawn = describeBeltItems(sim.entities, sim.buildings, sim.items);
    expect(drawn.length).toBe(3);
    for (const item of drawn) expect(item.layer).toBe(RenderLayer.ItemOnBelt);

    // Halfway along a tile is that tile's own coordinate, because the anchor
    // a drawable carries is offset by half a tile either way.
    const lane0 = splitterTile(splitter, SPLITTER.size, 0);
    const lane1 = splitterTile(splitter, SPLITTER.size, 1);
    const tiles = drawn.map((item) => `${item.x},${item.y}`).sort();
    expect(tiles).toEqual([`${lane0.x},${lane0.y}`, `${lane1.x},${lane1.y}`, '5,6'].sort());
  });

  it('draws nothing for an empty splitter', () => {
    const sim = simulation();
    sim.entities.create<SplitterEntity>(newSplitter(6, 6, EAST));
    expect(describeBeltItems(sim.entities, sim.buildings, sim.items)).toEqual([]);
  });
});
