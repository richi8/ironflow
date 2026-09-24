import { describe, expect, it } from 'vitest';

import { newBelt } from '../../src/game/entities/belt-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newInserter } from '../../src/game/entities/inserter-entity.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The world tooltip's view model. See ironflow.md C32.
 *
 * What the pointer rests on, answered from authoritative state: the ore in a
 * tile, what is left under a miner, how fast a belt or an inserter runs, what
 * an assembler is making. Node, no DOM (§4).
 */

/** A 2x2 iron patch with a different amount on each tile, so sums are checked. */
const PATCH = Object.freeze({ x: 4, y: 4 });
const AMOUNTS = Object.freeze([100, 200, 300, 400]);

function testWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const x = PATCH.x + dx - cx * CHUNK_SIZE;
        const y = PATCH.y + dy - cy * CHUNK_SIZE;
        if (x < 0 || y < 0 || x >= CHUNK_SIZE || y >= CHUNK_SIZE) continue;
        const index = localIndex(x, y);
        chunk.resource[index] = ResourceType.Iron;
        chunk.resourceAmount[index] = AMOUNTS[dy * 2 + dx] ?? 0;
      }
    }
    return chunk;
  });
}

function harness(): { simulation: Simulation; controller: GameController; cursor: DetachedCursor } {
  const simulation = new Simulation({ world: testWorld() });
  // Generate the patch's world chunk, as the renderer would by drawing it.
  simulation.world.getTile(PATCH.x, PATCH.y);
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  return { simulation, controller: new GameController({ game, cursor }), cursor };
}

describe('the ground under the pointer', () => {
  it('says how much ore is left in the tile', () => {
    const { controller, cursor } = harness();
    cursor.hover = { x: PATCH.x + 1, y: PATCH.y + 1 };
    const view = controller.getHoverView();
    expect(view?.building).toBeNull();
    expect(view?.resource).toEqual({ itemId: 'iron_ore', name: 'Iron Ore', amount: 400 });
  });

  it('says nothing over bare ground, or with no pointer on the world', () => {
    const { controller, cursor } = harness();
    expect(controller.getHoverView()).toBeNull();
    cursor.hover = { x: 0, y: 0 };
    expect(controller.getHoverView()).toBeNull();
  });

  it('does not generate a world chunk to answer', () => {
    const { simulation, controller, cursor } = harness();
    const before = simulation.world.chunkCount;
    cursor.hover = { x: 50 * CHUNK_SIZE, y: 50 * CHUNK_SIZE };
    expect(controller.getHoverView()).toBeNull();
    expect(simulation.world.chunkCount).toBe(before);
  });

  it('is frozen', () => {
    const { controller, cursor } = harness();
    cursor.hover = { x: PATCH.x, y: PATCH.y };
    const view = controller.getHoverView();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view?.resource)).toBe(true);
  });
});

describe('a building under the pointer', () => {
  it('a miner: the ore left under its whole footprint, and its pace', () => {
    const { simulation, controller, cursor } = harness();
    const miner = simulation.entities.create<MinerEntity>(newMiner(PATCH.x, PATCH.y, NORTH));
    cursor.hover = { x: PATCH.x, y: PATCH.y };
    cursor.hoverEntity = miner.id;

    const before = controller.getHoverView();
    expect(before?.building?.name).toBe('Miner');
    expect(before?.details?.oreUnder).toEqual({ itemId: 'iron_ore', name: 'Iron Ore', remaining: 1000, tiles: 4 });
    expect(before?.details?.miningItemsPerSecond).toBe(0.5);

    // It mines one unit per item: after a few items the sum goes down by as many.
    for (let tick = 0; tick < 200; tick++) simulation.tick();
    const mined = miner.outputCount;
    expect(mined).toBeGreaterThan(0);
    expect(controller.getHoverView()?.details?.oreUnder?.remaining).toBe(1000 - mined);
  });

  it('a belt: its speed, and its throughput at four items a tile (§9)', () => {
    const { simulation, controller, cursor } = harness();
    const belt = simulation.entities.create(newBelt(0, 0, NORTH));
    cursor.hover = { x: 0, y: 0 };
    cursor.hoverEntity = belt.id;
    const details = controller.getHoverView()?.details;
    expect(details?.beltTilesPerSecond).toBe(2);
    expect(details?.beltItemsPerSecond).toBe(8);
    expect(details?.inserterItemsPerSecond).toBeNull();
    expect(details?.oreUnder).toBeNull();
  });

  it('an inserter: its swing rate', () => {
    const { simulation, controller, cursor } = harness();
    const inserter = simulation.entities.create(newInserter(0, 0, NORTH));
    cursor.hover = { x: 0, y: 0 };
    cursor.hoverEntity = inserter.id;
    expect(controller.getHoverView()?.details?.inserterItemsPerSecond).toBe(1);
  });

  it('an assembler: its recipe and its crafting speed', () => {
    const { simulation, controller, cursor } = harness();
    const assembler = newMachine(EntityType.Assembler, 0, 0, NORTH);
    assembler.recipe = simulation.recipes.get('make_gear').recipeId;
    const entity = simulation.entities.create(assembler);
    cursor.hover = { x: 0, y: 0 };
    cursor.hoverEntity = entity.id;
    const view = controller.getHoverView();
    expect(view?.building?.recipe?.id).toBe('make_gear');
    expect(view?.details?.craftingSpeed).toBe(0.5);
  });

  it('has a key that changes when the target does, and only then', () => {
    const { simulation, controller, cursor } = harness();
    expect(controller.getHoverKey()).toBe('');
    cursor.hover = { x: 0, y: 0 };
    const ground = controller.getHoverKey();
    const belt = simulation.entities.create(newBelt(0, 0, NORTH));
    cursor.hoverEntity = belt.id;
    expect(controller.getHoverKey()).not.toBe(ground);
    expect(controller.getHoverKey()).toBe(controller.getHoverKey());
  });
});
