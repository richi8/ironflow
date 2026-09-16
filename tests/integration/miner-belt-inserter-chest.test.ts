import { describe, expect, it } from 'vitest';

import type { BeltEntity } from '../../src/game/entities/belt-entity.js';
import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { asInserter, InserterState, type InserterEntity } from '../../src/game/entities/inserter-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Game } from '../../src/game/game.js';
import { GameController, DetachedCursor } from '../../src/game/game-controller.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * §17's third required integration chain: **miner → belt → inserter → chest**
 * (C14), and the chunk's first acceptance criterion.
 *
 * ```text
 *   [miner 2x2 on iron, facing north]
 *            |
 *        [belt] -> [belt] -> [belt] -> [belt]
 *                                        |
 *                                   [inserter]  (facing south)
 *                                        |
 *                                    [chest]
 * ```
 *
 * The difference from C13's chain is the last two tiles, and it is the whole
 * point of the chunk: the belt now ends at a tile with nothing on it, and the
 * only thing moving ore off the end of it is a building. Nobody touches
 * anything; the assertions are exact counts after exact tick counts.
 *
 * The chain is built the way a player builds it — `build` commands through the
 * queue (§7) — so the content table, the placement rules and the command path
 * are covered in the same pass.
 */

const MINER_TILE = Object.freeze({ x: 4, y: 5 });
const BELT_ROW = 4;
/** Where the belt stops. The inserter stands one south of it. */
const BELT_END = 8;
const INSERTER_TILE = Object.freeze({ x: BELT_END, y: BELT_ROW + 1 });
const CHEST_TILE = Object.freeze({ x: BELT_END, y: BELT_ROW + 2 });

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
  readonly inserter: InserterEntity;
  readonly chest: ChestEntity;
}

function buildChain(oreAmount = 5000): Chain {
  const simulation = new Simulation({ world: oreWorld(oreAmount) });
  // Standing between the miner and the far end, so every tile of the chain is
  // inside build range (C10) and the chest is inside reach for a hand-take.
  simulation.player.setTilePosition(MINER_TILE.x + 2, MINER_TILE.y + 1);
  simulation.inventory.add('miner', 1);
  simulation.inventory.add('belt', 8);
  simulation.inventory.add('inserter', 1);
  simulation.inventory.add('chest', 1);

  const controller = new GameController({
    game: new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} }),
    cursor: new DetachedCursor(),
  });

  controller.dispatch({ type: 'build', buildingId: 'miner', ...MINER_TILE, rotation: NORTH });
  for (let x = MINER_TILE.x; x <= BELT_END; x++) {
    controller.dispatch({ type: 'build', buildingId: 'belt', x, y: BELT_ROW, rotation: EAST });
  }
  // Facing south: the source behind it is the last belt tile, the destination
  // in front of it is the chest.
  controller.dispatch({ type: 'build', buildingId: 'inserter', ...INSERTER_TILE, rotation: SOUTH });
  controller.dispatch({ type: 'build', buildingId: 'chest', ...CHEST_TILE, rotation: NORTH });
  simulation.tick();

  const miner = asMiner(simulation.entities.at(MINER_TILE.x, MINER_TILE.y) as never);
  const inserter = asInserter(simulation.entities.at(INSERTER_TILE.x, INSERTER_TILE.y) as never);
  const chest = asChest(simulation.entities.at(CHEST_TILE.x, CHEST_TILE.y) as never);
  if (miner === null || inserter === null || chest === null) throw new Error('the chain did not build');
  return { simulation, controller, miner, inserter, chest };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** How much iron ore is in the chest. */
function stored(chest: ChestEntity, simulation: Simulation): number {
  const iron = simulation.items.idOf('iron_ore');
  return chest.contents.find((entry) => entry[0] === iron)?.[1] ?? 0;
}

/** Everything riding a belt anywhere in the world. */
function onBelts(simulation: Simulation): number {
  let count = 0;
  simulation.entities.forEach((entity) => {
    const belt = entity as BeltEntity;
    if (belt.items !== undefined) count += belt.items.length;
  });
  return count;
}

describe('miner -> belt -> inserter -> chest', () => {
  it('builds the whole chain from commands, with nothing reaching into the store', () => {
    const { simulation } = buildChain();
    // Miner, five belts, inserter, chest.
    expect(simulation.entities.size).toBe(8);
    expect(simulation.commands.takeRejections()).toEqual([]);
  });

  it('runs unattended and fills the chest at the miners rate', () => {
    const { simulation, chest } = buildChain();

    // The miner is 0.5 items/s and the inserter is 1.0, so the miner is still
    // the bottleneck: the inserter has spare capacity and the chest's count is
    // the miner's output minus whatever is in transit.
    run(simulation, 60 * TPS);
    const after60 = stored(chest, simulation);
    expect(after60).toBeGreaterThanOrEqual(27);
    expect(after60).toBeLessThanOrEqual(30);

    // Another sixty seconds is another thirty exactly: the pipeline is full, so
    // nothing is lost to fill time and the rate is the miner's.
    run(simulation, 60 * TPS);
    expect(stored(chest, simulation) - after60).toBe(30);
  });

  it('loses nothing: everything mined is in the chest, on a belt, or in a hand', () => {
    const { simulation, miner, inserter, chest } = buildChain();
    run(simulation, 90 * TPS);

    const mined = simulation.production.totalFor(miner.id);
    expect(mined).toBe(45);
    const held = inserter.heldItem === 0 ? 0 : 1;
    expect(stored(chest, simulation) + onBelts(simulation) + miner.outputCount + held).toBe(mined);
  });

  it('backs up through the inserter to the miner when the chest is full', () => {
    const { simulation, miner, inserter, chest } = buildChain();
    const iron = simulation.items.idOf('iron_ore');
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    chest.contents = [[iron, slots * simulation.items.get('iron_ore').stackSize]];

    const capacity = simulation.buildings.miningFor(miner.type)?.bufferCapacity ?? 0;
    // Long enough for the block to reach back through the inserter, fill five
    // belts and then fill the miner's fifty-item buffer at half an item a second.
    run(simulation, (capacity + 40) * 2 * TPS);

    // C14's second acceptance criterion: empty hands and a stated reason.
    expect(inserter.state).toBe(InserterState.Idle);
    expect(inserter.heldItem).toBe(0);
    expect(inserter.status).toBe(MachineStatus.OutputFull);
    // And the backpressure propagates all the way to the source (§9).
    expect(miner.status).toBe(MachineStatus.OutputFull);
    expect(miner.outputCount).toBe(capacity);
  });

  it('shows the inserter working in the inspector, with a reason and a progress bar', () => {
    const { simulation, controller, inserter } = buildChain();
    run(simulation, 40 * TPS);

    const view = controller.getBuildingView(inserter.id);
    expect(view?.name).toBe('Inserter');
    // Pillar 3: a machine's status always explains itself, for every machine
    // and not only for the miner the sentence was first written about.
    expect(view?.status === 'running' || view?.status === 'idle').toBe(true);
    expect(view?.progress).not.toBeNull();
    expect(view?.progress).toBeGreaterThanOrEqual(0);
    expect(view?.progress).toBeLessThanOrEqual(1);
    // An inserter makes nothing, so it has no rate of its own to report.
    expect(view?.ratePerMinute).toBeNull();
  });

  it('lets the player take the item out of a stuck inserters hand', () => {
    const { simulation, controller, inserter } = buildChain();
    // Demolish the chest while the chain is running, so the arm ends up
    // holding an item with nowhere to put it.
    run(simulation, 40 * TPS);
    controller.dispatch({ type: 'remove', ...CHEST_TILE });
    run(simulation, 4 * TPS);
    expect(inserter.heldItem).not.toBe(0);

    controller.takeItems(inserter.id, 'iron_ore', 1);
    simulation.tick();

    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(inserter.heldItem).toBe(0);
    expect(simulation.player.inventory.count(simulation.items.idOf('iron_ore'))).toBe(1);
  });

  it('produces an identical world from an identical build, twice', () => {
    // §6's contract in the only form C14 can state it before C18: the same
    // commands in the same order for the same ticks give the same state.
    const first = buildChain();
    const second = buildChain();
    run(first.simulation, 400);
    run(second.simulation, 400);

    const snapshot = (chain: Chain): string => {
      const parts: string[] = [];
      chain.simulation.entities.forEach((entity) => parts.push(JSON.stringify(entity)));
      return parts.join('\n');
    };
    expect(snapshot(first)).toBe(snapshot(second));
  });
});
