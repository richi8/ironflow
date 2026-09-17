import { describe, expect, it } from 'vitest';

import type { BeltEntity } from '../../src/game/entities/belt-entity.js';
import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { asInserter, type InserterEntity } from '../../src/game/entities/inserter-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { asMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Game } from '../../src/game/game.js';
import { GameController, DetachedCursor } from '../../src/game/game-controller.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, WEST } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * **C15's acceptance: the vertical slice.** See ironflow.md C15 and the §20
 * milestone gate — *if this does not run unattended, nothing after it matters.*
 *
 * ```text
 *   [miner]->[belt][belt][belt][belt][belt]
 *    on iron                          |
 *                                 [inserter]        [belt]<-[belt]<-[miner]
 *                                     |                |         on coal
 *                                 [furnace 2x2]---[inserter]
 *                                     |
 *                                 [inserter]
 *                                     |
 *                                  [chest]
 * ```
 *
 * Two mining chains, one machine, four inserters' worth of connective tissue
 * and a box at the end. Nobody touches it: every building is placed with a
 * `build` command through the queue (§7), and from then on the only input is
 * the passage of ticks.
 *
 * The coal chain is not decoration. A furnace fed by hand is a furnace that
 * stops the moment the test stops looking, and "runs unattended for 10
 * simulated minutes" is exactly the claim that a hand-fed one cannot make.
 *
 * All of it is headless: **no canvas and no DOM**, which is C15's test
 * instruction and §4's "could this run in Node with `document` deleted".
 */

/* The iron chain. */
const IRON_MINER = Object.freeze({ x: 4, y: 5 });
const BELT_ROW = 4;
const BELT_END = 8;

/* The furnace and its three inserters. */
const ORE_INSERTER = Object.freeze({ x: BELT_END, y: 5 });
const FURNACE = Object.freeze({ x: BELT_END, y: 6 });
const PLATE_INSERTER = Object.freeze({ x: BELT_END, y: 8 });
const CHEST = Object.freeze({ x: BELT_END, y: 9 });

/* The coal chain, coming in from the east. */
const COAL_INSERTER = Object.freeze({ x: 10, y: 6 });
const COAL_BELT_HEAD = Object.freeze({ x: 11, y: 6 });
const COAL_BELT_TAIL = Object.freeze({ x: 11, y: 7 });
const COAL_MINER = Object.freeze({ x: 11, y: 8 });

/** Where the player stands: every tile of both chains inside build range. */
const STAND = Object.freeze({ x: BELT_END, y: 7 });

/** 3.2 s at 30 ticks a second — §15's smelting time. */
const SMELT_TICKS = 96;
/** §15: one plate furnace makes 0.3125 plates a second. */
const PLATES_PER_SECOND = TPS / SMELT_TICKS;

/** Grass, with an iron patch under one miner and a coal patch under the other. */
function oreWorld(amount: number): World {
  const patches: readonly (readonly [{ x: number; y: number }, ResourceType])[] = [
    [IRON_MINER, ResourceType.Iron],
    [COAL_MINER, ResourceType.Coal],
  ];
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        for (const [origin, resource] of patches) {
          if (x < origin.x || x > origin.x + 1) continue;
          if (y < origin.y || y > origin.y + 1) continue;
          const index = localIndex(lx, ly);
          chunk.resource[index] = resource;
          chunk.resourceAmount[index] = amount;
        }
      }
    }
    return chunk;
  });
}

interface Slice {
  readonly simulation: Simulation;
  readonly controller: GameController;
  readonly cursor: DetachedCursor;
  readonly miner: MinerEntity;
  readonly coalMiner: MinerEntity;
  readonly furnace: MachineEntity;
  readonly plateInserter: InserterEntity;
  readonly chest: ChestEntity;
  readonly plate: number;
}

function buildSlice(oreAmount = 20_000): Slice {
  const simulation = new Simulation({ world: oreWorld(oreAmount) });
  simulation.player.setTilePosition(STAND.x, STAND.y);
  simulation.inventory.add('miner', 2);
  simulation.inventory.add('belt', 8);
  simulation.inventory.add('inserter', 3);
  simulation.inventory.add('furnace', 1);
  simulation.inventory.add('chest', 1);

  const cursor = new DetachedCursor();
  const controller = new GameController({
    game: new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} }),
    cursor,
  });
  const build = (buildingId: string, tile: { x: number; y: number }, rotation: 0 | 1 | 2 | 3): void => {
    controller.dispatch({ type: 'build', buildingId, x: tile.x, y: tile.y, rotation });
  };

  build('miner', IRON_MINER, NORTH);
  for (let x = IRON_MINER.x; x <= BELT_END; x++) build('belt', { x, y: BELT_ROW }, EAST);
  build('inserter', ORE_INSERTER, SOUTH);
  build('furnace', FURNACE, NORTH);
  build('inserter', PLATE_INSERTER, SOUTH);
  build('chest', CHEST, NORTH);

  build('miner', COAL_MINER, NORTH);
  build('belt', COAL_BELT_TAIL, NORTH);
  build('belt', COAL_BELT_HEAD, WEST);
  build('inserter', COAL_INSERTER, WEST);
  simulation.tick();

  const at = (tile: { x: number; y: number }): never => simulation.entities.at(tile.x, tile.y) as never;
  const miner = asMiner(at(IRON_MINER));
  const coalMiner = asMiner(at(COAL_MINER));
  const furnace = asMachine(at(FURNACE), simulation.buildings);
  const plateInserter = asInserter(at(PLATE_INSERTER));
  const chest = asChest(at(CHEST));
  if (miner === null || coalMiner === null || furnace === null || plateInserter === null || chest === null) {
    throw new Error('the slice did not build');
  }
  return {
    simulation,
    controller,
    cursor,
    miner,
    coalMiner,
    furnace,
    plateInserter,
    chest,
    plate: simulation.items.idOf('iron_plate'),
  };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function stored(chest: ChestEntity, itemId: number): number {
  return chest.contents.find((entry) => entry[0] === itemId)?.[1] ?? 0;
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

describe('iron patch -> miner -> belt -> inserter -> furnace -> inserter -> chest', () => {
  it('builds from commands alone, with nothing reaching into the store', () => {
    const { simulation } = buildSlice();
    // Two miners, seven belts, three inserters, a furnace and a chest.
    expect(simulation.entities.size).toBe(14);
    expect(simulation.commands.takeRejections()).toEqual([]);
  });

  it('runs unattended for ten simulated minutes and makes plates at §15’s rate', () => {
    const { simulation, chest, plate } = buildSlice();

    run(simulation, 10 * 60 * TPS);
    const first = stored(chest, plate);
    // The furnace is the bottleneck: a miner makes 0.5 ore/s and one furnace
    // eats 0.3125 of them, so the line runs at the furnace's rate and the
    // surplus backs up behind it. The first window loses a few plates to fill
    // time — the ore has to walk five belt tiles before anything smelts.
    expect(first).toBeGreaterThan(0.9 * 600 * PLATES_PER_SECOND);

    // The second ten minutes is steady state, and the only number C15 states:
    // 0.3125 plates a second, ±2%.
    run(simulation, 10 * 60 * TPS);
    const made = stored(chest, plate) - first;
    const expected = 600 * PLATES_PER_SECOND;
    expect(Math.abs(made - expected) / expected).toBeLessThan(0.02);
  });

  it('loses nothing: every ore mined is a plate, an ore in transit, or still ore', () => {
    const { simulation, miner, furnace, chest, plate } = buildSlice();
    run(simulation, 5 * 60 * TPS);

    const ore = simulation.items.idOf('iron_ore');
    const mined = simulation.production.totalFor(miner.id);
    const coal = simulation.items.idOf('coal');
    const inFurnace = furnace.input.find((entry) => entry[0] === ore)?.[1] ?? 0;
    const inOutput = furnace.output.find((entry) => entry[0] === plate)?.[1] ?? 0;
    const hands = (itemId: number): number =>
      [ORE_INSERTER, PLATE_INSERTER, COAL_INSERTER]
        .map((tile) => asInserter(simulation.entities.at(tile.x, tile.y) as never))
        .filter((inserter) => inserter !== null && inserter.heldItem === itemId).length;

    // Every plate the furnace has made is in the chest, in its output buffer,
    // or in the hand on its way there: nothing evaporates between two
    // buildings, which is the failure this chain exists to catch.
    const plates = simulation.production.totalFor(furnace.id);
    expect(plates).toBe(stored(chest, plate) + inOutput + hands(plate));
    expect(plates).toBeGreaterThan(0);

    // And every ore mined is a plate, an ore on a belt, an ore in a buffer —
    // or the one in the fire: an ingredient is taken when a craft *starts*, so
    // mid-craft it is no longer an ore and not yet a plate.
    const inTheFire = furnace.progressTicks > 0 ? 1 : 0;
    const oreAccountedFor =
      plates +
      inTheFire +
      inFurnace +
      miner.outputCount +
      onBelts(simulation) -
      coalOnBelts(simulation, coal) +
      hands(ore);
    expect(oreAccountedFor).toBe(mined);
  });

  it('stalls the whole chain backwards to the miner when the chest is full', () => {
    const { simulation, miner, furnace, chest, plate, plateInserter } = buildSlice();
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    chest.contents = [[plate, slots * simulation.items.get('iron_plate').stackSize]];

    // Long enough for the block to fill the furnace's two buffers, the belt
    // and finally the miner's fifty-item buffer at half an item a second.
    run(simulation, 15 * 60 * TPS);

    expect(plateInserter.status).toBe(MachineStatus.OutputFull);
    expect(furnace.status).toBe(MachineStatus.OutputFull);
    // And all the way back to the source (§9's "backpressure that propagates").
    expect(miner.status).toBe(MachineStatus.OutputFull);
    expect(miner.outputCount).toBe(simulation.buildings.miningFor(miner.type)?.bufferCapacity ?? 0);
  });

  it('shows the furnace working in the inspector: status, progress, buffers and rate', () => {
    const { simulation, controller, cursor, furnace } = buildSlice();
    run(simulation, 3 * 60 * TPS);

    const view = controller.getBuildingView(furnace.id);
    expect(view?.name).toBe('Furnace');
    expect(view?.status).toBe('running');
    expect(view?.progress).toBeGreaterThanOrEqual(0);
    expect(view?.progress).toBeLessThanOrEqual(1);
    // Ingredients and fuel on the input side, each with the ceiling that will
    // stall the inserter feeding it. The output side is usually *empty*: a
    // 1 item/s inserter empties a 0.3125 plate/s furnace as fast as it fills.
    expect(view?.inputs.map((stack) => stack.itemId)).toEqual(['iron_ore', 'coal']);
    expect(view?.inputs[0]?.capacity).toBe(50);
    expect(view?.outputs.length).toBeLessThanOrEqual(1);

    // The rate the panel shows is sampled by the controller for the selected
    // machine only, so selecting it is part of the measurement (C12 task 2).
    // The window is 300 ticks wide (`RATE_WINDOW_TICKS`), which at 0.3125
    // plates a second is three plates: the reading is honest but coarse, so
    // this asserts the right order of magnitude rather than a decimal place.
    cursor.setSelectedEntity(furnace.id);
    sample(controller, simulation, 60 * TPS);
    const rate = controller.getBuildingView(furnace.id)?.ratePerMinute ?? 0;
    expect(rate).toBeGreaterThan(0.6 * 60 * PLATES_PER_SECOND);
    expect(rate).toBeLessThan(1.4 * 60 * PLATES_PER_SECOND);
  });

  it('produces an identical world from an identical build, twice', () => {
    // §6's contract in the form C15 can state it before C18: same commands,
    // same order, same ticks, same state — now with a machine in the chain.
    const first = buildSlice();
    const second = buildSlice();
    run(first.simulation, 2000);
    run(second.simulation, 2000);

    const snapshot = (slice: Slice): string => {
      const parts: string[] = [];
      slice.simulation.entities.forEach((entity) => parts.push(JSON.stringify(entity)));
      return parts.join('\n');
    };
    expect(snapshot(first)).toBe(snapshot(second));
  });

  it.skip('survives a save round trip (§6 R8) — unskip in C24', () => {
    // The chain's whole state — belt positions, buffers, progress ticks, the
    // fuel that is part-burnt — has to come back byte-identical. Written now,
    // because the fields C24 has to serialize are the ones being added here.
  });
});

/** Coal riding the coal belts, which is not iron and must not be counted as it. */
function coalOnBelts(simulation: Simulation, coal: number): number {
  let count = 0;
  simulation.entities.forEach((entity) => {
    const belt = entity as BeltEntity;
    if (belt.items === undefined) return;
    for (const item of belt.items) if (item.itemId === coal) count += 1;
  });
  return count;
}

/**
 * Run, letting the controller sample the selected machine the way a frame does.
 *
 * `pump` is what moves the rolling average forward (C12). It runs once per
 * *frame* in the real game rather than once per tick — here, once per tick,
 * which is the same arithmetic with more samples.
 */
function sample(controller: GameController, simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    simulation.tick();
    controller.pump();
  }
}
