import { describe, expect, it } from 'vitest';

import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { asInserter } from '../../src/game/entities/inserter-entity.js';
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
 * **C16's acceptance chain**, and §17's required integration chain for this
 * chunk: `ore -> smelt -> assemble -> chest`.
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
 *                                [assembler 3x3]  making gears
 *                                     |
 *                                 [inserter]
 *                                     |
 *                                  [chest]
 * ```
 *
 * C15's vertical slice with an assembler bolted onto the end of it, which is
 * what "plates -> assembler -> gears -> chest runs unattended" means once the
 * plates have to come from somewhere. Everything is placed by `build`
 * commands and the recipe is set by a `setRecipe` command; after that the only
 * input is the passage of ticks.
 *
 * The rate is the furnace's, not the assembler's. §15: one plate furnace makes
 * 0.3125 plates a second and a gear costs two, so the chain settles at 0.15625
 * gears a second while the assembler — which could make 0.5 — spends five
 * ticks in six waiting. That is the derived ratio §15 states as "1 gear
 * assembler needs 3.2 plate furnaces", observed from the other end, and it is
 * the number this test pins.
 *
 * Headless: no canvas and no DOM (§17).
 */

/* The iron chain, exactly C15's. */
const IRON_MINER = Object.freeze({ x: 4, y: 5 });
const BELT_ROW = 4;
const BELT_END = 8;
const ORE_INSERTER = Object.freeze({ x: BELT_END, y: 5 });
const FURNACE = Object.freeze({ x: BELT_END, y: 6 });

/* The coal chain, coming in from the east. */
const COAL_INSERTER = Object.freeze({ x: 10, y: 6 });
const COAL_BELT_HEAD = Object.freeze({ x: 11, y: 6 });
const COAL_BELT_TAIL = Object.freeze({ x: 11, y: 7 });
const COAL_MINER = Object.freeze({ x: 11, y: 8 });

/* C16's half: plates into an assembler, gears out of it. */
const PLATE_INSERTER = Object.freeze({ x: BELT_END, y: 8 });
/** 3x3, so it covers (7,9) to (9,11) and the inserters meet it at x = 8. */
const ASSEMBLER = Object.freeze({ x: 7, y: 9 });
const GEAR_INSERTER = Object.freeze({ x: BELT_END, y: 12 });
const CHEST = Object.freeze({ x: BELT_END, y: 13 });

/** Where the player stands: every tile of the chain inside build range. */
const STAND = Object.freeze({ x: BELT_END, y: 7 });

/** §15: 0.3125 plates a second, two to a gear. */
const GEARS_PER_SECOND = TPS / 96 / 2;

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

interface Chain {
  readonly simulation: Simulation;
  readonly controller: GameController;
  readonly cursor: DetachedCursor;
  readonly miner: MinerEntity;
  readonly furnace: MachineEntity;
  readonly assembler: MachineEntity;
  readonly chest: ChestEntity;
  readonly gear: number;
  readonly plate: number;
}

function buildChain(recipeId: string | null = 'make_gear'): Chain {
  const simulation = new Simulation({ world: oreWorld(20_000) });
  simulation.player.setTilePosition(STAND.x, STAND.y);
  simulation.inventory.add('miner', 2);
  simulation.inventory.add('belt', 8);
  simulation.inventory.add('inserter', 4);
  simulation.inventory.add('furnace', 1);
  simulation.inventory.add('assembler', 1);
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
  build('assembler', ASSEMBLER, NORTH);
  build('inserter', GEAR_INSERTER, SOUTH);
  build('chest', CHEST, NORTH);

  build('miner', COAL_MINER, NORTH);
  build('belt', COAL_BELT_TAIL, NORTH);
  build('belt', COAL_BELT_HEAD, WEST);
  build('inserter', COAL_INSERTER, WEST);
  simulation.tick();

  const at = (tile: { x: number; y: number }): never => simulation.entities.at(tile.x, tile.y) as never;
  const miner = asMiner(at(IRON_MINER));
  const furnace = asMachine(at(FURNACE), simulation.buildings);
  const assembler = asMachine(at(ASSEMBLER), simulation.buildings);
  const chest = asChest(at(CHEST));
  if (miner === null || furnace === null || assembler === null || chest === null) {
    throw new Error('the chain did not build');
  }

  // The one thing an assembler needs that a furnace does not: a decision.
  // Through the command queue, like everything else (§7).
  controller.setRecipe(assembler.id, recipeId);
  simulation.tick();

  return {
    simulation,
    controller,
    cursor,
    miner,
    furnace,
    assembler,
    chest,
    gear: simulation.items.idOf('gear'),
    plate: simulation.items.idOf('iron_plate'),
  };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function stored(chest: ChestEntity, itemId: number): number {
  return chest.contents.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

function held(slots: readonly (readonly [number, number])[], itemId: number): number {
  return slots.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

describe('ore -> smelt -> assemble -> chest', () => {
  it('builds from commands alone, and the assembler is told what to make', () => {
    const { simulation, assembler } = buildChain();
    // Two miners, seven belts, four inserters, a furnace, an assembler, a chest.
    expect(simulation.entities.size).toBe(16);
    expect(simulation.commands.takeRejections()).toEqual([]);
    expect(simulation.recipes.byId(assembler.recipe).id).toBe('make_gear');
  });

  it('runs unattended for twenty simulated minutes and makes gears at §15’s rate', () => {
    const { simulation, chest, gear } = buildChain();

    run(simulation, 10 * 60 * TPS);
    const first = stored(chest, gear);
    expect(first).toBeGreaterThan(0.85 * 600 * GEARS_PER_SECOND);

    // The second ten minutes is steady state. The chain's rate is the
    // furnace's halved — two plates to a gear — and nothing in the middle
    // loses any of it.
    run(simulation, 10 * 60 * TPS);
    const made = stored(chest, gear) - first;
    const expected = 600 * GEARS_PER_SECOND;
    expect(Math.abs(made - expected) / expected).toBeLessThan(0.02);
  });

  it('loses no plates: every one smelted is a gear, in a buffer, or in a hand', () => {
    const { simulation, furnace, assembler, chest, gear, plate } = buildChain();
    run(simulation, 5 * 60 * TPS);

    const smelted = simulation.production.totalFor(furnace.id);
    const gears = simulation.production.totalFor(assembler.id);
    const inHands = [PLATE_INSERTER, GEAR_INSERTER]
      .map((tile) => asInserter(simulation.entities.at(tile.x, tile.y) as never))
      .filter((inserter) => inserter !== null && inserter.heldItem === plate).length;

    // Two plates per gear, plus whatever is waiting at each stage — including
    // the pair already in the fire, which a craft takes when it *starts*.
    const inTheFire = assembler.progressTicks > 0 ? 2 : 0;
    const accounted =
      2 * gears +
      inTheFire +
      held(assembler.input, plate) +
      held(furnace.output, plate) +
      inHands;
    expect(smelted).toBeGreaterThan(0);
    expect(accounted).toBe(smelted);
    // And every gear made is in the chest or on its way there.
    expect(gears).toBe(stored(chest, gear) + held(assembler.output, gear) + gearsInHand(simulation, gear));
  });

  it('stalls backwards through the assembler to the miner when the chest is full', () => {
    const { simulation, miner, furnace, assembler, chest, gear } = buildChain();
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    chest.contents = [[gear, slots * simulation.items.get('gear').stackSize]];

    // Long enough for the block to fill the assembler's two buffers, then the
    // furnace's, then the belt, then the miner's fifty.
    run(simulation, 25 * 60 * TPS);

    expect(assembler.status).toBe(MachineStatus.OutputFull);
    expect(furnace.status).toBe(MachineStatus.OutputFull);
    expect(miner.status).toBe(MachineStatus.OutputFull);
  });

  it('an assembler with no recipe stops the line and says why', () => {
    const { simulation, assembler, chest, gear } = buildChain(null);
    run(simulation, 5 * 60 * TPS);

    expect(assembler.status).toBe(MachineStatus.NoRecipe);
    expect(assembler.input).toEqual([]);
    expect(stored(chest, gear)).toBe(0);
    // And the plates are not lost: they are banked up behind the machine that
    // has not been told what to do with them.
    expect(simulation.production.totalFor(simulation.entities.at(FURNACE.x, FURNACE.y)?.id ?? 0)).toBeGreaterThan(0);
  });

  it('shows the assembler in the inspector: its recipe, its choices and its rate', () => {
    const { simulation, controller, cursor, assembler } = buildChain();
    run(simulation, 60 * TPS);

    const view = controller.getBuildingView(assembler.id);
    expect(view?.name).toBe('Assembler');
    expect(view?.recipe?.id).toBe('make_gear');
    // Every crafting recipe research has unlocked is offered, with exactly one
    // of them lit. The five the v1 tech tree holds back are absent (C22).
    expect(view?.recipes?.map((choice) => choice.id)).toEqual([
      'make_gear',
      'make_wire',
      'make_circuit',
      'make_miner',
      'make_belt',
      'make_inserter',
      'make_furnace',
      'make_assembler',
      'make_chest',
      // C21's power buildings, less the electric furnace `power_1` unlocks.
      'make_generator',
      'make_power_pole',
      // C22's, less the three its own tree holds back.
      'make_data_core',
      'make_lab',
    ]);
    expect(view?.recipes?.filter((choice) => choice.selected).map((choice) => choice.id)).toEqual(['make_gear']);
    // 60 ticks a gear is 30 a minute — the machine's nominal rate, beside the
    // measured one the panel shows for what it is actually achieving.
    expect(view?.recipe?.ratePerMinute).toBeCloseTo(30, 6);

    cursor.setSelectedEntity(assembler.id);
    for (let i = 0; i < 60 * TPS; i++) {
      simulation.tick();
      controller.pump();
    }
    const measured = controller.getBuildingView(assembler.id)?.ratePerMinute ?? 0;
    expect(measured).toBeGreaterThan(0.6 * 60 * GEARS_PER_SECOND);
    expect(measured).toBeLessThan(1.4 * 60 * GEARS_PER_SECOND);
  });

  it('produces an identical world from an identical build, twice', () => {
    const first = buildChain();
    const second = buildChain();
    run(first.simulation, 2000);
    run(second.simulation, 2000);

    const snapshot = (chain: Chain): string => {
      const parts: string[] = [];
      chain.simulation.entities.forEach((entity) => parts.push(JSON.stringify(entity)));
      return parts.join('\n');
    };
    expect(snapshot(first)).toBe(snapshot(second));
  });
});

/** Gears riding an inserter's hand, which are made but not yet delivered. */
function gearsInHand(simulation: Simulation, gear: number): number {
  const inserter = asInserter(simulation.entities.at(GEAR_INSERTER.x, GEAR_INSERTER.y) as never);
  return inserter !== null && inserter.heldItem === gear ? 1 : 0;
}
