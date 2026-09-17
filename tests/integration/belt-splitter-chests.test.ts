import { describe, expect, it } from 'vitest';

import { asBelt } from '../../src/game/entities/belt-entity.js';
import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { asSplitter, type SplitterEntity } from '../../src/game/entities/splitter-entity.js';
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
 * §17's sixth required integration chain: **belt → splitter → 2 belts → 2
 * chests** (C17).
 *
 * Headless, no DOM, no canvas, and exact item counts after an exact tick
 * count. The chain is fed by a miner, because §17 asks for an *item count*
 * and a belt with nothing behind it does not produce one — and because a
 * splitter that balances a hand-fed belt but not a real factory's is a
 * splitter that has not been tested.
 *
 * ```text
 *   [miner 2x2 on iron, facing north]
 *            |                              [belt] -> [chest]   north branch
 *        [belt] x4 -> [splitter 2x1] -<
 *                                           [belt] -> [chest]   south branch
 * ```
 *
 * It is built the way a player builds it — `build` commands through the queue
 * (§7), not by reaching into the entity store — so it also covers the
 * placement rules, the content table and the command path in one pass.
 */

/** Where the fixture puts things. The miner's 2x2 sits on the ore. */
const MINER_TILE = Object.freeze({ x: 4, y: 5 });
const BELT_ROW = 4;
const SPLITTER_TILE = Object.freeze({ x: 8, y: BELT_ROW });
const NORTH_CHEST = Object.freeze({ x: 10, y: BELT_ROW });
const SOUTH_CHEST = Object.freeze({ x: 10, y: BELT_ROW + 1 });

/** Somewhere every tile of the chain is inside build range (C10). */
const STAND = Object.freeze({ x: 7, y: 5 });

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
  readonly miner: MinerEntity;
  readonly splitter: SplitterEntity;
  readonly north: ChestEntity | null;
  readonly south: ChestEntity | null;
  readonly iron: number;
}

/**
 * Build the chain through the command queue and run one tick to apply it.
 *
 * `branches` is how many of the splitter's two outputs get a belt and a chest:
 * two for the balanced case, one for the blocked-output case, which is the
 * same factory with one branch never built.
 */
function buildChain(branches: 1 | 2 = 2): Chain {
  const simulation = new Simulation({ world: oreWorld(5000) });
  simulation.player.setTilePosition(STAND.x, STAND.y);
  simulation.inventory.add('miner', 1);
  simulation.inventory.add('belt', 10);
  simulation.inventory.add('splitter', 1);
  simulation.inventory.add('chest', 2);

  const controller = new GameController({
    game: new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} }),
    cursor: new DetachedCursor(),
  });

  controller.dispatch({ type: 'build', buildingId: 'miner', ...MINER_TILE, rotation: NORTH });
  for (let x = MINER_TILE.x; x < SPLITTER_TILE.x; x++) {
    controller.dispatch({ type: 'build', buildingId: 'belt', x, y: BELT_ROW, rotation: EAST });
  }
  controller.dispatch({ type: 'build', buildingId: 'splitter', ...SPLITTER_TILE, rotation: EAST });

  const chests = [NORTH_CHEST, SOUTH_CHEST].slice(0, branches);
  for (const chest of chests) {
    controller.dispatch({ type: 'build', buildingId: 'belt', x: chest.x - 1, y: chest.y, rotation: EAST });
    controller.dispatch({ type: 'build', buildingId: 'chest', x: chest.x, y: chest.y, rotation: NORTH });
  }
  simulation.tick();

  const miner = asMiner(simulation.entities.at(MINER_TILE.x, MINER_TILE.y) as never);
  const splitter = asSplitter(simulation.entities.at(SPLITTER_TILE.x, SPLITTER_TILE.y) as never);
  if (miner === null || splitter === null) throw new Error('the chain did not build');
  expect(simulation.commands.takeRejections()).toEqual([]);

  return {
    simulation,
    miner,
    splitter,
    north: chestAt(simulation, NORTH_CHEST),
    south: chestAt(simulation, SOUTH_CHEST),
    iron: simulation.items.idOf('iron_ore'),
  };
}

function chestAt(simulation: Simulation, tile: { x: number; y: number }): ChestEntity | null {
  const entity = simulation.entities.at(tile.x, tile.y);
  return entity === undefined ? null : asChest(entity);
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** How much iron ore is in a chest that may not have been built. */
function stored(chest: ChestEntity | null, iron: number): number {
  return chest?.contents.find((entry) => entry[0] === iron)?.[1] ?? 0;
}

/** Every ore still riding a belt or sitting in a splitter lane. */
function inFlight(simulation: Simulation): number {
  let count = 0;
  simulation.entities.forEach((entity) => {
    const belt = asBelt(entity);
    if (belt !== null) {
      count += belt.items.length;
      return;
    }
    const splitter = asSplitter(entity);
    if (splitter !== null) count += splitter.lanes[0].length + splitter.lanes[1].length;
  });
  return count;
}

describe('belt -> splitter -> 2 belts -> 2 chests', () => {
  it('builds the whole chain from commands, with nothing reaching into the store', () => {
    const { simulation } = buildChain();
    // Miner, four belts in, a splitter, two belts out, two chests.
    expect(simulation.entities.size).toBe(10);
    // The splitter claims both of its tiles, so nothing else may stand there.
    expect(simulation.entities.at(SPLITTER_TILE.x, SPLITTER_TILE.y + 1)?.id).toBe(
      simulation.entities.at(SPLITTER_TILE.x, SPLITTER_TILE.y)?.id,
    );
  });

  it('runs unattended for twenty minutes and fills both chests equally', () => {
    const { simulation, miner, north, south, iron } = buildChain();
    run(simulation, 20 * 60 * TPS);

    const a = stored(north, iron);
    const b = stored(south, iron);

    // §15: a tier-1 miner is 0.5 items/s, so twenty minutes is six hundred
    // ore, minus whatever is still on its way down one of the two branches.
    const mined = simulation.production.totalFor(miner.id);
    expect(mined).toBeGreaterThanOrEqual(595);
    expect(a + b + inFlight(simulation)).toBe(mined);

    // C17's first acceptance criterion: deterministic round-robin, so the
    // only slack is what is still in flight on one branch and not the other.
    // The thousand-item version of it is in `tests/unit/splitter.test.ts`,
    // where a saturated belt rather than a miner feeds the splitter.
    expect(a).toBeGreaterThan(290);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it('sends everything down the branch that exists when the other does not', () => {
    const oneWay = buildChain(1);
    const twoWay = buildChain(2);
    run(oneWay.simulation, 10 * 60 * TPS);
    run(twoWay.simulation, 10 * 60 * TPS);

    // C17's second criterion: no throughput loss. A miner is far slower than
    // a belt, so the line is never the limit either way — which is exactly
    // what "the splitter costs nothing" should mean, and the two factories
    // deliver the same number of ore in the same number of ticks.
    expect(stored(oneWay.south, oneWay.iron)).toBe(0);
    expect(stored(oneWay.north, oneWay.iron)).toBe(
      stored(twoWay.north, twoWay.iron) + stored(twoWay.south, twoWay.iron),
    );
  });

  it('stalls back through the splitter to the miner when both chests are full', () => {
    const { simulation, miner, splitter, north, south, iron } = buildChain();
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    const full = slots * simulation.items.get('iron_ore').stackSize;
    if (north === null || south === null) throw new Error('no chests');
    north.contents = [[iron, full]];
    south.contents = [[iron, full]];

    // Long enough to fill both output belts, both splitter lanes, the belt
    // line behind it and the miner's fifty-item buffer.
    run(simulation, 10 * 60 * TPS);

    // §9's backpressure, reaching the machine at the far end of the line.
    // Only the fed lane fills: nothing stands behind the splitter's second
    // side, so it is empty rather than jammed, and the two are different
    // things a player can see.
    expect(miner.status).toBe(MachineStatus.OutputFull);
    expect(splitter.lanes[0].length).toBe(4);
    expect(splitter.lanes[1].length).toBe(0);
    expect(asBelt(simulation.entities.at(SPLITTER_TILE.x - 1, BELT_ROW) as never)?.items.length).toBe(4);
    // And nothing was destroyed on the way: every ore mined is on a belt, in
    // a lane, or in the miner's own buffer.
    expect(inFlight(simulation) + miner.outputCount).toBe(simulation.production.totalFor(miner.id));
  });

  it('produces an identical world from an identical build, twice', () => {
    const first = buildChain();
    const second = buildChain();
    run(first.simulation, 3 * 60 * TPS);
    run(second.simulation, 3 * 60 * TPS);

    const snapshot = (chain: Chain): string[] => {
      const parts: string[] = [];
      chain.simulation.entities.forEach((entity) => parts.push(JSON.stringify(entity)));
      return parts;
    };
    expect(snapshot(second)).toEqual(snapshot(first));
  });

  it('carries ore through the splitter itself rather than around it', () => {
    const { simulation, splitter } = buildChain();

    // Ore really does ride *inside* it — one tile's worth of travel, which is
    // what the renderer draws a lane through (C17 task 4) and what makes a
    // splitter cost the same as the belt tile it replaces.
    let seen = 0;
    for (let tick = 0; tick < 10 * 60 * TPS; tick++) {
      simulation.tick();
      seen = Math.max(seen, splitter.lanes[0].length + splitter.lanes[1].length);
    }
    expect(seen).toBeGreaterThan(0);
  });
});
