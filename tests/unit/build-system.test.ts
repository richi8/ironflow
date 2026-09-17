import { describe, expect, it } from 'vitest';

import type { Command } from '../../src/game/commands/command.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { EntityStore } from '../../src/game/entities/entity-store.js';
import { footprintTiles } from '../../src/game/entities/entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { BuildMaterials } from '../../src/game/items/build-materials.js';
import { SlotInventory } from '../../src/game/items/inventory.js';
import { ITEMS } from '../../src/game/data/items.js';
import { ItemRegistry, type ItemDefinition } from '../../src/game/registries/item-registry.js';
import { BuildingRegistry, type BuildingDefinition } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { BuildSystem } from '../../src/game/systems/build-system.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, TILE_MAX, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { TileType } from '../../src/game/world/tile.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';
import { World } from '../../src/game/world/world.js';

/**
 * Placement. See ironflow.md C06.
 *
 * The chunk's promise is that *every* rule about where a building may stand is
 * a field in `data/buildings.ts` read by one validation path — so the tests
 * that matter are the ones that would fail if a rule leaked into a system as a
 * special case:
 *
 * 1. **The validation matrix**, each row with its own visible reason. A
 *    rejection the player cannot tell apart from another is the failure this
 *    genre is known for (§7).
 * 2. **Footprints at every rotation**, because the occupancy index is the one
 *    piece of state a wrong answer corrupts permanently: a leaked tile can
 *    never be built on again and nothing points at what leaked it.
 * 3. **Cost and refund**, which must be all-or-nothing in both directions —
 *    a rejected placement that charged for itself is a bug the player reports
 *    as "my plates vanished".
 * 4. **Adding a building changes no code**, tested by adding one.
 */

/**
 * A small fixed world: grass, a north-south river, and one iron patch.
 *
 * ```text
 *   ore     x 0..3,  y 0..3   (on grass: C09 is what makes ore visible)
 *   water   x 20..23, all y
 *   dirt    y 30..33, all x
 *   grass   everywhere else
 * ```
 */
function testWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        const index = localIndex(lx, ly);
        if (x >= 20 && x < 24) {
          chunk.terrain[index] = TileType.Water;
        } else if (y >= 30 && y < 34) {
          chunk.terrain[index] = TileType.Dirt;
        } else if (x >= 0 && x < 4 && y >= 0 && y < 4) {
          chunk.resource[index] = 1;
          chunk.resourceAmount[index] = 500;
        }
      }
    }
    return chunk;
  });
}

/**
 * A 1×2 building, so the extent swap has something non-square to swap.
 *
 * It borrows a §15 entity type nothing has implemented yet, and moved from
 * `Splitter` to `PowerPole` when C17 made the splitter real: the point of the
 * fixture is a rotation-count of 2 and a non-square footprint, neither of
 * which any shipped building has.
 */
const PIPE: BuildingDefinition = {
  id: 'pipe',
  name: 'Pipe',
  entityType: EntityType.PowerPole,
  category: 'logistics',
  size: { width: 1, height: 2 },
  rotationCount: 2,
  buildCost: [{ itemId: 'pipe', count: 1 }],
  placement: { onTerrain: [TileType.Grass, TileType.Dirt, TileType.Sand, TileType.Stone] },
  sprite: 'building:logistics:PI:1x2:1',
};

interface Harness {
  readonly world: World;
  readonly entities: EntityStore;
  readonly inventory: BuildMaterials;
  readonly buildings: BuildingRegistry;
  readonly system: BuildSystem;
}

/**
 * The item a synthetic building is paid for with.
 *
 * Since C20 a build cost is paid out of the player's one real inventory, which
 * keys on the item registry's numeric ids — so a building invented in a test
 * needs an item invented with it, exactly as a building added to
 * `data/buildings.ts` needs a row in `data/items.ts`. That correspondence is
 * asserted for the shipped content in `tests/balance/content.test.ts`; here it
 * is just what makes a made-up building purchasable.
 */
function itemFor(definition: BuildingDefinition): ItemDefinition {
  const cost = definition.buildCost[0];
  return {
    id: cost?.itemId ?? definition.id,
    name: definition.name,
    stackSize: 50,
    sprite: `item:${cost?.itemId ?? definition.id}`,
    category: 'building',
  };
}

function harness(extra: readonly BuildingDefinition[] = [PIPE], stock = 10): Harness {
  const world = testWorld();
  const buildings = new BuildingRegistry([...BUILDINGS, ...extra]);
  const entities = new EntityStore({ footprintOf: buildings.footprintOf });
  const items = new ItemRegistry([...ITEMS, ...extra.map(itemFor)]);
  const inventory = new BuildMaterials(
    new SlotInventory({ slots: 200, stackSizeOf: items.stackSizeOf }),
    items,
  );
  for (const definition of buildings.all()) inventory.add(definition.id, stock);
  return {
    world,
    entities,
    inventory,
    buildings,
    system: new BuildSystem({ world, entities, buildings, inventory }),
  };
}

describe('BuildingRegistry', () => {
  it('keeps content order, which is menu and hotkey order', () => {
    expect(new BuildingRegistry(BUILDINGS).all().map((d) => d.id)).toEqual([
      'miner',
      'belt',
      'splitter',
      'inserter',
      'furnace',
      'assembler',
      'chest',
    ]);
  });

  it('throws on an unknown id rather than handing back undefined', () => {
    const registry = new BuildingRegistry(BUILDINGS);
    expect(registry.has('miner')).toBe(true);
    expect(registry.has('minor')).toBe(false);
    expect(() => registry.get('minor')).toThrow(/no building with id "minor"/);
  });

  it('freezes definitions, so nothing can edit content at runtime', () => {
    const miner = new BuildingRegistry(BUILDINGS).get('miner');
    expect(() => {
      (miner as { name: string }).name = 'Drill';
    }).toThrow(TypeError);
    expect(() => {
      (miner.size as { width: number }).width = 9;
    }).toThrow(TypeError);
  });

  it('answers the entity store with each type its own footprint', () => {
    const registry = new BuildingRegistry(BUILDINGS);
    expect(registry.footprintOf(EntityType.Miner)).toEqual({ width: 2, height: 2 });
    expect(registry.footprintOf(EntityType.Chest)).toEqual({ width: 1, height: 1 });
    // A type nothing defines yet still has to answer something the store can
    // use; 1×1 is the only size that cannot claim a tile it was not given.
    expect(registry.footprintOf(EntityType.Lab)).toEqual({ width: 1, height: 1 });
  });

  it.each([
    ['a duplicate id', [{ ...PIPE, id: 'miner', entityType: EntityType.Belt }], /share the id/],
    ['two claims on one entity type', [{ ...PIPE, entityType: EntityType.Miner }], /both claim entity type/],
    ['a rotation count that is not 1, 2 or 4', [{ ...PIPE, rotationCount: 3 as 1 }], /rotationCount/],
    ['a footprint of no tiles', [{ ...PIPE, size: { width: 0, height: 1 } }], /at least 1/],
    ['an entity type outside the enum', [{ ...PIPE, entityType: 99 as EntityType }], /entityType/],
    ['no terrain at all', [{ ...PIPE, placement: { onTerrain: [] } }], /no terrain/],
    [
      'terrain the world calls unbuildable',
      [{ ...PIPE, placement: { onTerrain: [TileType.Water] } }],
      /not buildable terrain/,
    ],
    ['a build cost of half an item', [{ ...PIPE, buildCost: [{ itemId: 'pipe', count: 0 }] }], /build cost/],
    ['a nameless building', [{ ...PIPE, name: '' }], /no name/],
    ['no sprite', [{ ...PIPE, sprite: '' }], /no sprite/],
  ])('refuses %s at construction', (_label, extra, message) => {
    expect(() => new BuildingRegistry([...BUILDINGS, ...(extra as BuildingDefinition[])])).toThrow(message);
  });

  it('cycles rotation within the rotations a building actually has', () => {
    const registry = new BuildingRegistry([...BUILDINGS, PIPE]);
    const miner = registry.get('miner');
    const chest = registry.get('chest');
    const pipe = registry.get('pipe');

    expect([0, 1, 2, 3].map((r) => BuildingRegistry.cycleRotation(miner, r as Rotation))).toEqual([1, 2, 3, 0]);
    expect([0, 1].map((r) => BuildingRegistry.cycleRotation(pipe, r as Rotation))).toEqual([1, 0]);
    expect(BuildingRegistry.cycleRotation(chest, NORTH)).toBe(NORTH);
  });

  it('normalises a rotation a building cannot have', () => {
    const registry = new BuildingRegistry([...BUILDINGS, PIPE]);
    expect(BuildingRegistry.normalizeRotation(registry.get('chest'), SOUTH)).toBe(NORTH);
    expect(BuildingRegistry.normalizeRotation(registry.get('pipe'), WEST)).toBe(EAST);
    expect(BuildingRegistry.normalizeRotation(registry.get('miner'), WEST)).toBe(WEST);
  });
});

describe('placement validation', () => {
  it('accepts a miner on ore and a chest on plain ground', () => {
    const h = harness();
    expect(h.system.validate('miner', 0, 0, NORTH)).toBeNull();
    expect(h.system.validate('chest', 10, 10, NORTH)).toBeNull();
  });

  it.each([
    ['an unknown building', 'sawmill', 10, 10, 'unknown_building'],
    ['water under one corner', 'chest', 20, 5, 'bad_terrain'],
    ['ore missing under a miner', 'miner', 10, 10, 'no_resource'],
    ['the edge of the packable world', 'miner', TILE_MAX, 0, 'out_of_range'],
  ])('refuses %s with its own reason', (_label, id, x, y, reason) => {
    expect(harness().system.validate(id, x, y, NORTH)).toBe(reason);
  });

  it('refuses a tile another building already stands on', () => {
    const h = harness();
    expect(h.system.place('miner', 0, 0, NORTH)).toBeNull();

    // Every tile of the 2x2 footprint refuses, including the three the
    // placement did not point at.
    for (const tile of footprintTiles(0, 0, { width: 2, height: 2 }, NORTH)) {
      expect(h.system.validate('chest', tile.x, tile.y, NORTH), `${tile.x},${tile.y}`).toBe('occupied');
    }
    // And a 2x2 overlapping it by a single corner.
    expect(h.system.validate('miner', 1, 1, NORTH)).toBe('occupied');
  });

  it('refuses a building the player cannot pay for', () => {
    const h = harness([PIPE], 0);
    expect(h.system.validate('chest', 10, 10, NORTH)).toBe('unaffordable');

    h.inventory.add('chest', 1);
    expect(h.system.validate('chest', 10, 10, NORTH)).toBeNull();
  });

  it('answers with the reason that explains the tile, not the wallet', () => {
    // Both wrong at once. "Water" is what the player must act on; "you cannot
    // afford it" is just as true one tile to the left and explains nothing.
    const h = harness([PIPE], 0);
    expect(h.system.validate('chest', 20, 5, NORTH)).toBe('bad_terrain');
  });

  it('sees a miner as needing ore under any one tile of its footprint', () => {
    const h = harness();
    // The patch is x 0..3, y 0..3; this 2x2 overlaps it by one corner only.
    expect(h.system.validate('miner', 3, 3, NORTH)).toBeNull();
    expect(h.system.validate('miner', 4, 4, NORTH)).toBe('no_resource');
  });

  it('checks the same thing for the ghost as for the command', () => {
    const h = harness();
    const simulation = new Simulation({
      world: h.world,
      buildings: h.buildings,
      entities: h.entities,
    });
    // Stocked through the simulation's own bag: since C20 there is only one,
    // and it is the player's — `Simulation` no longer takes one to hold.
    for (const definition of h.buildings.all()) simulation.inventory.add(definition.id, 10);
    for (const [x, y] of [
      [0, 0],
      [20, 5],
      [10, 10],
    ] as const) {
      // Standing on the tile under test, so the one rule the simulation adds on
      // top of the build system — C10's build range — is satisfied and what is
      // left to compare is the placement answer itself. The three tiles are
      // twenty apart, so no single vantage point reaches them all; that is the
      // range doing its job rather than a limitation of the test.
      simulation.player.setTilePosition(x, y);
      expect(simulation.checkPlacement('miner', x, y, NORTH)).toBe(h.system.validate('miner', x, y, NORTH));
    }
  });

  /**
   * Build range (C10 task 5). It lives on the simulation rather than in
   * `BuildSystem`, because "may a building stand here" is a fact about the
   * world and "can the player reach it" is a fact about the player — so these
   * go through `checkPlacement` and the ones above do not.
   */
  it('refuses a placement the player cannot reach, and says which it is', () => {
    const simulation = new Simulation({ world: testWorld() });
    simulation.inventory.add('chest', 5);
    simulation.player.setTilePosition(0, 0);

    // Eight tiles is the range, measured to the centre of the target tile.
    expect(simulation.checkPlacement('chest', 8, 0, NORTH)).toBeNull();
    expect(simulation.checkPlacement('chest', 9, 0, NORTH)).toBe('out_of_reach');
    // ...and it is `out_of_reach`, not `out_of_range`: the edge of the world
    // and "walk closer" are different instructions (§7).
    expect(simulation.checkPlacement('chest', TILE_MAX, 0, NORTH)).toBe('out_of_reach');

    simulation.player.setTilePosition(9, 0);
    expect(simulation.checkPlacement('chest', 9, 0, NORTH)).toBeNull();
  });

  it('measures reach to the nearest tile of a footprint, not to its anchor', () => {
    const simulation = new Simulation({ world: testWorld() });
    simulation.player.setTilePosition(0, 0);

    // A 2x2 miner anchored eight tiles east covers x 8..9. Its far corner is a
    // tile past the range and its near one is exactly on it, and the near one
    // is what counts — anchor it one tile further and nothing is in reach.
    expect(simulation.checkPlacement('miner', 8, 0, NORTH)).not.toBe('out_of_reach');
    expect(simulation.checkPlacement('miner', 9, 0, NORTH)).toBe('out_of_reach');
  });

  it('lets the player walk into range of a placement that was refused', () => {
    const simulation = new Simulation({ world: testWorld() });
    simulation.inventory.add('chest', 1);
    simulation.player.setTilePosition(0, 0);

    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 12, y: 0, rotation: NORTH });
    simulation.tick();
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['out_of_reach']);
    expect(simulation.entities.size).toBe(0);

    simulation.player.setTilePosition(12, 0);
    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 12, y: 0, rotation: NORTH });
    simulation.tick();
    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(simulation.entities.at(12, 0)).toBeDefined();
  });
});

describe('placing a building', () => {
  it('creates the entity, claims its tiles and charges for it', () => {
    const h = harness();
    expect(h.system.place('miner', 0, 0, NORTH)).toBeNull();

    const miner = h.entities.at(0, 0);
    expect(miner?.type).toBe(EntityType.Miner);
    expect(h.entities.size).toBe(1);
    expect(h.inventory.count('miner')).toBe(9);
    for (const tile of footprintTiles(0, 0, { width: 2, height: 2 }, NORTH)) {
      expect(h.entities.at(tile.x, tile.y)).toBe(miner);
    }
  });

  it('charges nothing and changes nothing when it refuses', () => {
    const h = harness();
    const before = h.inventory.toJSON();

    expect(h.system.place('chest', 20, 5, NORTH)).toBe('bad_terrain');
    expect(h.system.place('miner', 10, 10, NORTH)).toBe('no_resource');
    expect(h.system.place('sawmill', 10, 10, NORTH)).toBe('unknown_building');

    expect(h.inventory.toJSON()).toEqual(before);
    expect(h.entities.size).toBe(0);
    expect(h.entities.nextId).toBe(1);
  });

  it('occupies exactly the right four tiles at every rotation', () => {
    for (const rotation of [NORTH, EAST, SOUTH, WEST] as const) {
      const h = harness();
      expect(h.system.place('miner', 0, 0, rotation), `r${rotation}`).toBeNull();

      const claimed: string[] = [];
      for (let y = -1; y <= 2; y++) {
        for (let x = -1; x <= 2; x++) {
          if (h.entities.at(x, y) !== undefined) claimed.push(`${x},${y}`);
        }
      }
      expect(claimed.sort(), `r${rotation}`).toEqual(['0,0', '0,1', '1,0', '1,1']);
    }
  });

  it('swaps a non-square footprint for an odd rotation', () => {
    const north = harness();
    expect(north.system.place('pipe', 5, 5, NORTH)).toBeNull();
    expect(north.entities.at(5, 6)).toBeDefined(); // 1 wide, 2 tall
    expect(north.entities.at(6, 5)).toBeUndefined();

    const east = harness();
    expect(east.system.place('pipe', 5, 5, EAST)).toBeNull();
    expect(east.entities.at(6, 5)).toBeDefined(); // 2 wide, 1 tall
    expect(east.entities.at(5, 6)).toBeUndefined();
  });

  it('stores a rotation the building actually has', () => {
    const h = harness();
    expect(h.system.place('chest', 10, 10, SOUTH)).toBeNull();
    expect(h.entities.at(10, 10)?.rotation).toBe(NORTH);

    expect(h.system.place('pipe', 12, 10, WEST)).toBeNull();
    expect(h.entities.at(12, 10)?.rotation).toBe(EAST);

    expect(h.system.place('miner', 0, 0, WEST)).toBeNull();
    expect(h.entities.at(0, 0)?.rotation).toBe(WEST);
  });
});

describe('removing a building', () => {
  it('refunds the cost and frees every tile of the footprint', () => {
    const h = harness();
    h.system.place('miner', 0, 0, NORTH);
    expect(h.inventory.count('miner')).toBe(9);

    // Pointed at the far corner, not the anchor: any tile of the footprint is
    // the building, which is what the occupancy index is for.
    expect(h.system.remove(1, 1)).toBeNull();
    expect(h.inventory.count('miner')).toBe(10);

    // Still standing until the cleanup phase ends the tick (C05).
    expect(h.entities.at(0, 0)).toBeDefined();
    h.entities.cleanup();
    for (const tile of footprintTiles(0, 0, { width: 2, height: 2 }, NORTH)) {
      expect(h.entities.at(tile.x, tile.y)).toBeUndefined();
    }
  });

  it('refunds once, however many times the button is clicked', () => {
    const h = harness();
    h.system.place('chest', 10, 10, NORTH);

    expect(h.system.remove(10, 10)).toBeNull();
    expect(h.system.remove(10, 10)).toBe('nothing_there');
    expect(h.inventory.count('chest')).toBe(10);
  });

  it('says so when there is nothing there', () => {
    const h = harness();
    expect(h.system.remove(10, 10)).toBe('nothing_there');
    expect(h.system.remove(TILE_MAX + 1, 0)).toBe('out_of_range');
  });

  it('place, remove, place again leaves the world where it started', () => {
    const h = harness();
    const before = h.inventory.toJSON();

    h.system.place('miner', 0, 0, EAST);
    h.system.remove(0, 0);
    h.entities.cleanup();
    expect(h.system.place('miner', 0, 0, EAST)).toBeNull();
    h.entities.cleanup();

    expect(h.entities.size).toBe(1);
    expect(h.inventory.toJSON()).toEqual({ ...before, miner: 9 });
    const claimed = footprintTiles(0, 0, { width: 2, height: 2 }, EAST);
    for (const tile of claimed) expect(h.entities.at(tile.x, tile.y)).toBeDefined();
  });
});

describe('the command path', () => {
  function run(simulation: Simulation, commands: readonly Command[]): void {
    for (const command of commands) simulation.commands.enqueue(command);
    simulation.tick();
  }

  it('builds and removes through the queue, and nowhere else', () => {
    const simulation = new Simulation({ world: testWorld() });
    simulation.inventory.add('chest', 5);
    simulation.player.setTilePosition(10, 10);

    run(simulation, [{ type: 'build', buildingId: 'chest', x: 10, y: 10, rotation: NORTH }]);
    expect(simulation.entities.at(10, 10)).toBeDefined();
    expect(simulation.inventory.count('chest')).toBe(4);
    expect(simulation.commands.takeRejections()).toEqual([]);

    run(simulation, [{ type: 'remove', x: 10, y: 10 }]);
    expect(simulation.entities.at(10, 10)).toBeUndefined();
    expect(simulation.inventory.count('chest')).toBe(5);
  });

  it('rejects with a reason the player can be shown', () => {
    const simulation = new Simulation({ world: testWorld() });
    // Within reach of all three tiles, so each rejection is the one the rule
    // under test produces rather than C10's range check shadowing it.
    simulation.player.setTilePosition(16, 9);

    run(simulation, [
      { type: 'build', buildingId: 'chest', x: 20, y: 5, rotation: NORTH },
      { type: 'build', buildingId: 'miner', x: 10, y: 10, rotation: NORTH },
      { type: 'remove', x: 15, y: 15 },
    ]);

    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual([
      'bad_terrain',
      'no_resource',
      'nothing_there',
    ]);
    expect(simulation.entities.size).toBe(0);
  });

  it('holds a removed buildings tiles until the tick that removed it ends', () => {
    const simulation = new Simulation({ world: testWorld() });
    simulation.inventory.add('chest', 5);
    simulation.player.setTilePosition(10, 10);
    run(simulation, [{ type: 'build', buildingId: 'chest', x: 10, y: 10, rotation: NORTH }]);

    // Both in one tick: the remove is applied in the command phase, the tiles
    // are freed in the cleanup phase, and the build in between sees the tile
    // as still taken. Saying "occupied" is the honest answer, and it is the
    // same answer on every machine (§8).
    run(simulation, [
      { type: 'remove', x: 10, y: 10 },
      { type: 'build', buildingId: 'chest', x: 10, y: 10, rotation: NORTH },
    ]);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['occupied']);

    run(simulation, [{ type: 'build', buildingId: 'chest', x: 10, y: 10, rotation: NORTH }]);
    expect(simulation.entities.at(10, 10)).toBeDefined();
    expect(simulation.commands.takeRejections()).toEqual([]);
  });
});

describe('adding a building', () => {
  it('needs no code outside data/buildings.ts', () => {
    // The whole of what a new building requires: one more entry in the table.
    const sawmill: BuildingDefinition = {
      id: 'sawmill',
      name: 'Sawmill',
      // Any type no shipped building has claimed — C16's assembler took the
      // one this used to borrow, which is the registry refusing two buildings
      // one entity type exactly as it is supposed to.
      entityType: EntityType.Lab,
      category: 'production',
      size: { width: 3, height: 2 },
      rotationCount: 4,
      buildCost: [{ itemId: 'sawmill', count: 2 }],
      placement: { onTerrain: [TileType.Grass] },
      sprite: 'building:production:SA:3x2:2',
    };
    const h = harness([PIPE, sawmill]);

    expect(h.system.place('sawmill', 8, 8, EAST)).toBeNull();
    expect(h.inventory.count('sawmill')).toBe(8);
    // 3x2 turned east covers 2 wide by 3 tall, and the store learned that size
    // from the registry without anyone telling it about sawmills.
    for (const tile of footprintTiles(8, 8, { width: 3, height: 2 }, EAST)) {
      expect(h.entities.at(tile.x, tile.y), `${tile.x},${tile.y}`).toBeDefined();
    }
    expect(h.entities.at(10, 8)).toBeUndefined();

    // And its own narrower terrain rule is enforced without a line of code for
    // it: dirt is buildable, and this building says grass only.
    expect(h.system.validate('chest', 8, 30, NORTH)).toBeNull();
    expect(h.system.validate('sawmill', 8, 30, NORTH)).toBe('bad_terrain');
  });
});

describe('BuildMaterials', () => {
  /**
   * The string-keyed view that replaced C06's `ItemCounts` bag (C20).
   *
   * What is worth testing is not the arithmetic — a `SlotInventory` already
   * owns that — but the three things the *view* decides: an unknown id is
   * worth nothing rather than throwing, a cost is paid all or not at all, and
   * a refund that will not fit is refused rather than half-made. The last one
   * is new: the old bag had no capacity and could not fail to accept a refund.
   */
  function materials(slots = 10): BuildMaterials {
    const items = new ItemRegistry(ITEMS);
    return new BuildMaterials(new SlotInventory({ slots, stackSizeOf: items.stackSizeOf }), items);
  }

  it('adds, removes partially, and reports what happened', () => {
    const bag = materials();
    expect(bag.add('gear', 5)).toBe(5);
    expect(bag.count('gear')).toBe(5);
    expect(bag.remove('gear', 7)).toBe(5);
    expect(bag.count('gear')).toBe(0);
    expect(bag.remove('gear', 1)).toBe(0);
  });

  it('is worth nothing in an item no registry knows, rather than throwing', () => {
    const bag = materials();
    expect(bag.count('sprocket')).toBe(0);
    expect(bag.add('sprocket', 4)).toBe(0);
    expect(bag.canAfford([{ itemId: 'sprocket', count: 1 }])).toBe(false);
    expect(bag.hasRoomFor([{ itemId: 'sprocket', count: 1 }])).toBe(false);
  });

  it('pays a cost in full or not at all', () => {
    const bag = materials();
    bag.add('gear', 2);
    bag.add('iron_plate', 1);
    const cost = [
      { itemId: 'gear', count: 2 },
      { itemId: 'iron_plate', count: 4 },
    ];

    expect(bag.canAfford(cost)).toBe(false);
    expect(bag.take(cost)).toBe(false);
    // The gears are still there: a partial payment for a building that never
    // appeared is items the player cannot account for.
    expect(bag.count('gear')).toBe(2);

    bag.add('iron_plate', 3);
    expect(bag.take(cost)).toBe(true);
    expect(bag.toJSON()).toEqual({});
  });

  it('refuses a refund that will not fit, rather than losing half of it', () => {
    // One slot, holding a full stack of something else: there is nowhere for a
    // chest to go, and `give` must change nothing rather than drop it.
    const bag = materials(1);
    expect(bag.add('iron_plate', 100)).toBe(100);

    const refund = [{ itemId: 'chest', count: 1 }];
    expect(bag.hasRoomFor(refund)).toBe(false);
    expect(bag.give(refund)).toBe(false);
    expect(bag.count('chest')).toBe(0);
    expect(bag.count('iron_plate')).toBe(100);
  });

  it('serializes sorted by string id, so the HUD rows never reorder', () => {
    const bag = materials();
    bag.add('iron_plate', 2);
    bag.add('gear', 1);
    bag.add('coal', 3);

    expect(Object.keys(bag.toJSON())).toEqual(['coal', 'gear', 'iron_plate']);
  });
});

describe('the playground world', () => {
  /**
   * The fixture world the rejection cases are stated against.
   *
   * The checkerboard has neither water nor ore, so "rejected on water" and
   * "rejected without resources" would have nowhere to happen. Until C19 this
   * was also the world the running game booted into; it now boots into a
   * generated one, and what the guarantee has become — ore of every kind
   * within reach of spawn, on buildable land — is C19's starting-area
   * validation and is tested there.
   */
  it('rejects placement on water and on bare ground, at known coordinates', () => {
    const world = new World(createPlaygroundGenerator());
    const buildings = new BuildingRegistry(BUILDINGS);
    const entities = new EntityStore({ footprintOf: buildings.footprintOf });
    const items = new ItemRegistry(ITEMS);
    const inventory = new BuildMaterials(
      new SlotInventory({ slots: 30, stackSizeOf: items.stackSizeOf }),
      items,
    );
    for (const definition of buildings.all()) inventory.add(definition.id, 1);
    const system = new BuildSystem({ world, entities, buildings, inventory });

    expect(system.validate('chest', 14, 3, NORTH)).toBe('bad_terrain'); // the pond
    expect(system.validate('miner', 2, 12, NORTH)).toBeNull(); // the iron patch
    expect(system.validate('miner', 30, 30, NORTH)).toBe('no_resource'); // plain ground
  });

  it('generates the same world chunk however many times it is asked', () => {
    const generate = createPlaygroundGenerator();
    const first = generate(0, 0);
    const second = generate(0, 0);

    expect([...second.terrain]).toEqual([...first.terrain]);
    expect([...second.resourceAmount]).toEqual([...first.resourceAmount]);
    expect(first.dirty).toBe(false);
  });
});
