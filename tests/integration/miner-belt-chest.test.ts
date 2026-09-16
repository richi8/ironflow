import { describe, expect, it } from 'vitest';

import type { BeltEntity } from '../../src/game/entities/belt-entity.js';
import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Game } from '../../src/game/game.js';
import { GameController, DetachedCursor } from '../../src/game/game-controller.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * §17's second required integration chain: **miner → belt → chest** (C13).
 *
 * Headless, no DOM, no canvas, and an exact item count after an exact tick
 * count — which is what makes it a regression test rather than a demo. It is
 * the first chain in the game that runs with nobody touching it, and it is the
 * thing C13 exists to make true:
 *
 * ```text
 *   [miner 2x2 on iron, facing north]
 *            |
 *        [belt] -> [belt] -> [belt] -> [chest]
 * ```
 *
 * The chain is built the way a player builds it — `build` commands through the
 * queue (§7), not by reaching into the entity store — so it also covers the
 * placement rules, the content table and the command path in one pass.
 */

/** Where the fixture puts things. The miner's 2x2 sits on the ore. */
const MINER_TILE = Object.freeze({ x: 4, y: 5 });
const BELT_ROW = 4;
const CHEST_TILE = Object.freeze({ x: 8, y: BELT_ROW });

/** Grass, with `amount` iron on the four tiles the miner covers. */
function oreWorld(amount: number): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        if (x < MINER_TILE.x || x > MINER_TILE.x + 1) continue;
        if (y < MINER_TILE.y || y > MINER_TILE.y + 1) continue;
        const index = localIndex(lx, ly);
        chunk.resource[index] = ResourceType.Iron;
        chunk.resourceAmount[index] = amount;
      }
    }
    return chunk;
  });
}

interface Chain {
  readonly simulation: Simulation;
  readonly controller: GameController;
  readonly miner: MinerEntity;
  readonly chest: ChestEntity;
}

/**
 * Build the chain through the command queue and run one tick to apply it.
 *
 * The player stands next to the miner so everything is inside build range
 * (C10), and holds enough of each building to pay for the line.
 */
function buildChain(oreAmount = 5000): Chain {
  const simulation = new Simulation({ world: oreWorld(oreAmount) });
  simulation.player.setTilePosition(MINER_TILE.x + 1, MINER_TILE.y + 1);
  simulation.inventory.add('miner', 1);
  simulation.inventory.add('belt', 8);
  simulation.inventory.add('chest', 1);

  const controller = new GameController({
    game: new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} }),
    cursor: new DetachedCursor(),
  });

  controller.dispatch({ type: 'build', buildingId: 'miner', ...MINER_TILE, rotation: NORTH });
  for (let x = MINER_TILE.x; x < CHEST_TILE.x; x++) {
    controller.dispatch({ type: 'build', buildingId: 'belt', x, y: BELT_ROW, rotation: EAST });
  }
  controller.dispatch({ type: 'build', buildingId: 'chest', ...CHEST_TILE, rotation: NORTH });
  simulation.tick();

  const miner = asMiner(simulation.entities.at(MINER_TILE.x, MINER_TILE.y) as never);
  const chest = asChest(simulation.entities.at(CHEST_TILE.x, CHEST_TILE.y) as never);
  if (miner === null || chest === null) throw new Error('the chain did not build');
  return { simulation, controller, miner, chest };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** How much iron ore is in the chest. */
function stored(chest: ChestEntity, simulation: Simulation): number {
  const iron = simulation.items.idOf('iron_ore');
  return chest.contents.find((entry) => entry[0] === iron)?.[1] ?? 0;
}

describe('miner -> belt -> chest', () => {
  it('builds the whole chain from commands, with nothing reaching into the store', () => {
    const { simulation } = buildChain();
    // Miner, four belts, chest.
    expect(simulation.entities.size).toBe(6);
    // Every command was accepted: a rejected one would have been recorded.
    expect(simulation.commands.takeRejections()).toEqual([]);
  });

  it('runs unattended and fills the chest at the miners rate', () => {
    const { simulation, chest } = buildChain();

    // A tier-1 miner is 0.5 items/s (§15), so sixty seconds is thirty ore.
    // The belt carries sixteen times that, so the miner is the bottleneck and
    // the chest's count is the miner's output minus what is still in transit.
    run(simulation, 60 * TPS);
    const after60 = stored(chest, simulation);
    expect(after60).toBeGreaterThanOrEqual(28);
    expect(after60).toBeLessThanOrEqual(30);

    // Another sixty seconds is another thirty, exactly: the pipeline is full
    // by now, so nothing is lost to fill time and the rate is the miner's.
    run(simulation, 60 * TPS);
    expect(stored(chest, simulation) - after60).toBe(30);
  });

  it('keeps the miner running rather than stalling it, because the belt drains', () => {
    const { simulation, miner } = buildChain();
    run(simulation, 120 * TPS);

    expect(miner.status).toBe(MachineStatus.Running);
    // Everything it mines leaves within a tick or two, so the buffer that C11
    // sized at fifty never gets anywhere near full.
    expect(miner.outputCount).toBeLessThanOrEqual(1);
  });

  it('loses nothing: everything mined is in the chest, on the belt, or in the buffer', () => {
    const { simulation, miner, chest } = buildChain();
    run(simulation, 90 * TPS);

    let onBelts = 0;
    simulation.entities.forEach((entity) => {
      const belt = entity as BeltEntity;
      if (belt.items !== undefined) onBelts += belt.items.length;
    });

    const mined = simulation.production.totalFor(miner.id);
    expect(mined).toBe(45);
    expect(stored(chest, simulation) + onBelts + miner.outputCount).toBe(mined);
  });

  it('backs up to the miner when the chest is full, and says output_full', () => {
    const { simulation, miner, chest } = buildChain();
    const iron = simulation.items.idOf('iron_ore');
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    // Filled to the brim, so the end of the line has nowhere to put anything.
    chest.contents = [[iron, slots * simulation.items.get('iron_ore').stackSize]];

    const capacity = simulation.buildings.miningFor(miner.type)?.bufferCapacity ?? 0;
    // Long enough for the block to travel back up the line, fill four belts,
    // and then fill the miner's fifty-item buffer at half an item a second.
    run(simulation, (capacity + 40) * 2 * TPS);

    // C13's second acceptance criterion, end to end: a full chest stalls the
    // miner, and the miner says why (pillar 3).
    expect(miner.status).toBe(MachineStatus.OutputFull);
    expect(miner.outputCount).toBe(capacity);
    expect(stored(chest, simulation)).toBe(slots * simulation.items.get('iron_ore').stackSize);
  });

  it('shows the chests contents in the inspector, so the player can see it fill', () => {
    const { simulation, controller, chest } = buildChain();
    run(simulation, 30 * TPS);

    const view = controller.getBuildingView(chest.id);
    expect(view?.name).toBe('Chest');
    // A chest has nothing to be partway through and produces nothing.
    expect(view?.progress).toBeNull();
    expect(view?.ratePerMinute).toBeNull();
    expect(view?.outputs.map((stack) => stack.itemId)).toEqual(['iron_ore']);
    expect(view?.outputs[0]?.count).toBe(stored(chest, simulation));
  });

  it('lets the player take what the belt delivered', () => {
    const { simulation, controller, chest } = buildChain();
    run(simulation, 60 * TPS);
    const before = stored(chest, simulation);
    expect(before).toBeGreaterThan(0);

    // Standing beside the miner is within the six-tile reach of the chest at
    // the far end of a four-belt line, which is what this fixture is sized for.
    controller.takeItems(chest.id, 'iron_ore', 5);
    simulation.tick();

    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(simulation.player.inventory.count(simulation.items.idOf('iron_ore'))).toBe(5);
    // Five left the chest in the command phase, and the belt may or may not
    // have delivered one in the belt phase of the same tick — which is the
    // honest bound, and asserting the exact number would be asserting where
    // one item happened to be standing.
    expect(stored(chest, simulation)).toBeGreaterThanOrEqual(before - 5);
    expect(stored(chest, simulation)).toBeLessThanOrEqual(before - 4);
  });
});
