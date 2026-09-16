import { describe, expect, it } from 'vitest';

import { GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import {
  footprintTileAt,
  footprintTileCount,
  forEachFootprintTile,
  type Footprint,
} from '../../src/game/entities/entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { newMiner, minerOutput, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The miner. See ironflow.md C11.
 *
 * The four acceptance criteria, in order:
 *
 * 1. a miner on iron produces **exactly** 30 ore in 60 simulated seconds;
 * 2. the rate is unchanged at 10 fps and at 144 fps;
 * 3. a full miner stops and reports `output_full`, and emptying it resumes;
 * 4. a miner over a depleted patch reports `no_resource` and raises **one**
 *    alert, not one per tick.
 *
 * The first and second are the same fact stated twice, and they are tested
 * twice on purpose: the first says the content table's 0.5 items/s is 60
 * integer ticks (§6 R3), the second says nothing about the frame rate reaches
 * the count — which is the property the whole fixed-timestep loop exists for
 * and the one a future "just use delta time here" would quietly break.
 */

/** The miner's footprint, and the patch the fixture puts under it. */
const PATCH_ORIGIN = Object.freeze({ x: 4, y: 4 });

/** Ore per tile in the fixture. Enough for the 60-second run, not much more. */
const PATCH_AMOUNT = 20;

/**
 * Grass everywhere, with a 2x2 patch of `amount` units per tile at
 * `PATCH_ORIGIN` — exactly the four tiles a miner placed there covers.
 *
 * `corner` is the resource on the south-east tile, so one fixture serves both
 * the plain case and the mixed patch the adoption rule is about.
 */
function testWorld(amount = PATCH_AMOUNT, corner: ResourceType = ResourceType.Iron): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        if (x < PATCH_ORIGIN.x || x > PATCH_ORIGIN.x + 1) continue;
        if (y < PATCH_ORIGIN.y || y > PATCH_ORIGIN.y + 1) continue;

        const index = localIndex(lx, ly);
        const isCorner = x === PATCH_ORIGIN.x + 1 && y === PATCH_ORIGIN.y + 1;
        chunk.resource[index] = isCorner ? corner : ResourceType.Iron;
        chunk.resourceAmount[index] = amount;
      }
    }
    return chunk;
  });
}

/** Three iron tiles and a copper one, for the resource-adoption rule. */
function mixedWorld(amount: number): World {
  return testWorld(amount, ResourceType.Copper);
}

/** A simulation with a miner already standing on the patch, before any tick. */
function withMiner(world = testWorld()): { simulation: Simulation; miner: MinerEntity } {
  const simulation = new Simulation({ world });
  const miner = simulation.entities.create<MinerEntity>(newMiner(PATCH_ORIGIN.x, PATCH_ORIGIN.y, NORTH));
  return { simulation, miner };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/**
 * Drive a loop through exactly `seconds` of wall time at `fps`.
 *
 * The frame period is rounded to whole microseconds, so the last frame carries
 * whatever the rounding left over. Without it, 144 fps is 6,944 us a frame and
 * 8,640 frames land four milliseconds short of a minute — which would make the
 * test fail on the frame period rather than on anything the miner did.
 */
function runSeconds(scheduler: FakeScheduler, seconds: number, fps: number): void {
  const totalUs = seconds * 1_000_000;
  const frameUs = Math.floor(1_000_000 / fps);
  const frames = Math.floor(totalUs / frameUs);
  scheduler.runFrames(frames, frameUs);
  const remainder = totalUs - frames * frameUs;
  if (remainder > 0) scheduler.runFrame(remainder);
}

/** The ore left on one tile of the patch. */
function oreAt(simulation: Simulation, dx: number, dy: number): number {
  return simulation.world.getResourceAmount(PATCH_ORIGIN.x + dx, PATCH_ORIGIN.y + dy);
}

/** Ticks a miner takes per item, from the content table rather than restated. */
function ticksPerItem(simulation: Simulation): number {
  const config = simulation.buildings.miningFor(EntityType.Miner);
  if (config === null) throw new Error('the miner has no mining content');
  return config.ticksPerItem;
}

function bufferCapacity(simulation: Simulation): number {
  const config = simulation.buildings.miningFor(EntityType.Miner);
  if (config === null) throw new Error('the miner has no mining content');
  return config.bufferCapacity;
}

describe('miner production rate', () => {
  it('turns §15\'s 0.5 items/s into exactly 60 ticks per item', () => {
    const { simulation } = withMiner();
    // The content table says items per second; §6 R3 says the simulation may
    // only ever see whole ticks. This is that conversion, done once.
    expect(ticksPerItem(simulation)).toBe(60);
    expect(ticksPerItem(simulation)).toBe(TPS / 0.5);
  });

  it('produces exactly 30 ore in 60 simulated seconds', () => {
    const world = testWorld(1000);
    const { simulation, miner } = withMiner(world);

    run(simulation, 60 * TPS);

    expect(miner.outputCount).toBe(30);
    expect(miner.status).toBe(MachineStatus.Running);
  });

  it('produces the 30th ore on the 1800th tick and not before', () => {
    const { simulation, miner } = withMiner(testWorld(1000));

    run(simulation, 60 * TPS - 1);
    expect(miner.outputCount).toBe(29);

    simulation.tick();
    expect(miner.outputCount).toBe(30);
  });

  it('mines at the same rate at 10 fps and at 144 fps', () => {
    // The whole point of the fixed timestep (§8). Both loops are handed the
    // same sixty seconds of wall time in very different numbers of frames —
    // 600 against 8,641 — and must agree on the ore and on the tick count.
    const outputs = [10, 144].map((fps) => {
      const { simulation, miner } = withMiner(testWorld(1000));
      const scheduler = new FakeScheduler();
      const game = new Game({ simulation, scheduler, render: () => {} });

      game.start();
      runSeconds(scheduler, 60, fps);
      game.stop();

      return { ticks: simulation.getTick(), ore: miner.outputCount };
    });

    expect(outputs.map((result) => result.ore)).toEqual([30, 30]);
    expect(outputs.map((result) => result.ticks)).toEqual([60 * TPS, 60 * TPS]);
  });
});

describe('miner tile selection', () => {
  it('takes from every covered tile in turn rather than eating one first', () => {
    const { simulation, miner } = withMiner();
    const perItem = ticksPerItem(simulation);

    // Four items: one from each of the four covered tiles, in footprint order.
    run(simulation, perItem * 4);

    expect(miner.outputCount).toBe(4);
    expect(oreAt(simulation, 0, 0)).toBe(PATCH_AMOUNT - 1);
    expect(oreAt(simulation, 1, 0)).toBe(PATCH_AMOUNT - 1);
    expect(oreAt(simulation, 0, 1)).toBe(PATCH_AMOUNT - 1);
    expect(oreAt(simulation, 1, 1)).toBe(PATCH_AMOUNT - 1);

    // A fifth item comes off the first tile again, not off whichever tile the
    // loop happened to reach: the cursor is stored, so it survives the tick.
    run(simulation, perItem);
    expect(oreAt(simulation, 0, 0)).toBe(PATCH_AMOUNT - 2);
  });

  it('runs the same way twice from the same start', () => {
    const first = withMiner();
    const second = withMiner();
    run(first.simulation, 500);
    run(second.simulation, 500);

    expect({ ...second.miner }).toEqual({ ...first.miner });
    expect(oreAt(second.simulation, 0, 0)).toBe(oreAt(first.simulation, 0, 0));
    expect(oreAt(second.simulation, 1, 0)).toBe(oreAt(first.simulation, 1, 0));
  });

  it('adopts a second kind of ore only once its buffer is empty', () => {
    const perTile = 10;
    const { simulation, miner } = withMiner(mixedWorld(perTile));
    const perItem = ticksPerItem(simulation);

    // Drain the three iron tiles, one unit per item.
    run(simulation, perItem * 3 * perTile);
    expect(miner.resourceType).toBe(ResourceType.Iron);
    expect(miner.outputCount).toBe(3 * perTile);
    expect(oreAt(simulation, 1, 1)).toBe(perTile);

    // Iron is gone and copper is right there, but the buffer is full of iron
    // and `outputCount` names no item — switching would transmute it.
    run(simulation, perItem);
    expect(miner.status).toBe(MachineStatus.NoResource);
    expect(minerOutput(miner)).toEqual({ itemId: 'iron_ore', count: 3 * perTile });

    // Emptied — which is what C14's inserter will do — it takes up the copper.
    miner.outputCount = 0;
    run(simulation, perItem);
    expect(miner.resourceType).toBe(ResourceType.Copper);
    expect(miner.status).toBe(MachineStatus.Running);
    expect(minerOutput(miner)).toEqual({ itemId: 'copper_ore', count: 1 });
  });

  it('indexes a footprint in the same order it walks one', () => {
    // `footprintTileAt` is what the round-robin cursor addresses tiles with;
    // a cursor that disagreed with the iteration order would mine tiles in an
    // order nothing else in the game could predict.
    const footprint: Footprint = { width: 3, height: 2 };
    for (const rotation of [NORTH, EAST, SOUTH, WEST] as Rotation[]) {
      const walked: string[] = [];
      forEachFootprintTile(7, 11, footprint, rotation, (x, y) => walked.push(`${x},${y}`));

      const indexed: string[] = [];
      const count = footprintTileCount(footprint, rotation);
      for (let i = 0; i < count; i++) {
        const tile = footprintTileAt(7, 11, footprint, rotation, i);
        indexed.push(`${tile.x},${tile.y}`);
      }

      expect(indexed).toEqual(walked);
      // And it wraps, so a cursor may be advanced without being wrapped first.
      expect(footprintTileAt(7, 11, footprint, rotation, count)).toEqual(
        footprintTileAt(7, 11, footprint, rotation, 0),
      );
    }
  });
});

describe('miner backpressure', () => {
  it('stops at a full buffer, reports output_full, and resumes when emptied', () => {
    const { simulation, miner } = withMiner(testWorld(1000));
    const perItem = ticksPerItem(simulation);
    const capacity = bufferCapacity(simulation);

    run(simulation, perItem * capacity);
    expect(miner.outputCount).toBe(capacity);
    expect(miner.status).toBe(MachineStatus.OutputFull);

    // A full miner takes nothing more out of the ground, however long it sits.
    const oreLeft = oreAt(simulation, 0, 0);
    run(simulation, perItem * 5);
    expect(miner.outputCount).toBe(capacity);
    expect(oreAt(simulation, 0, 0)).toBe(oreLeft);

    miner.outputCount = 0;
    run(simulation, perItem);
    expect(miner.status).toBe(MachineStatus.Running);
    expect(miner.outputCount).toBe(1);
  });

  it('keeps its part-finished item across a full buffer', () => {
    // The bug this guards: an inserter empties a buffer a few ticks after it
    // fills, so a miner that reset its progress on every stall would sit at a
    // full buffer producing nothing — a miner that works alone and stops the
    // moment it is automated.
    const { simulation, miner } = withMiner(testWorld(1000));
    const perItem = ticksPerItem(simulation);
    const capacity = bufferCapacity(simulation);

    run(simulation, perItem * capacity);
    // Half of the next item, spent while the buffer was full.
    miner.progressTicks = perItem - 1;
    run(simulation, 5);
    expect(miner.progressTicks).toBe(perItem - 1);

    miner.outputCount = 0;
    simulation.tick();
    expect(miner.outputCount).toBe(1);
  });

  it('discards its part-finished item when the ore runs out', () => {
    // The opposite answer, for the opposite reason: there is nothing to be
    // partway through, and C10 discards the player's manual progress too.
    const { simulation, miner } = withMiner(testWorld(1));
    const perItem = ticksPerItem(simulation);

    run(simulation, perItem * 4);
    expect(miner.outputCount).toBe(4);

    // One tick short of the fifth item, on a patch that has just run dry.
    miner.progressTicks = perItem - 1;
    simulation.tick();

    expect(miner.status).toBe(MachineStatus.NoResource);
    expect(miner.progressTicks).toBe(0);
    expect(miner.outputCount).toBe(4);
  });
});

describe('miner depletion', () => {
  it('reports no_resource and raises exactly one alert, not one per tick', () => {
    const { simulation, miner } = withMiner(testWorld(1));
    const perItem = ticksPerItem(simulation);

    // Four tiles of one unit each, so the patch is gone after four items.
    run(simulation, perItem * 3);
    expect(miner.status).toBe(MachineStatus.Running);
    expect(simulation.alerts.size).toBe(0);

    run(simulation, perItem * 10);
    expect(miner.status).toBe(MachineStatus.NoResource);
    expect(simulation.alerts.size).toBe(1);

    const [alert] = simulation.alerts.take();
    expect(alert).toEqual({
      type: 'miner_no_resource',
      entityId: miner.id,
      x: PATCH_ORIGIN.x,
      y: PATCH_ORIGIN.y,
    });

    // Still empty a hundred ticks later: the condition holds every tick and
    // the alert is the transition, not the condition.
    run(simulation, 100);
    expect(simulation.alerts.size).toBe(0);
  });

  it('never alerts while there is still ore under it', () => {
    const { simulation } = withMiner(testWorld(1000));
    run(simulation, 600);
    expect(simulation.alerts.size).toBe(0);
  });

  it('starts idle and is mining by the end of the tick it was built on', () => {
    const { simulation, miner } = withMiner();
    expect(miner.status).toBe(MachineStatus.Idle);
    expect(miner.resourceType).toBe(ResourceType.None);

    simulation.tick();
    expect(miner.status).toBe(MachineStatus.Running);
    expect(miner.resourceType).toBe(ResourceType.Iron);
  });
});

describe('miner placement and views', () => {
  /** A simulation the player can actually build a miner in, from a command. */
  function buildable(world = testWorld()): { simulation: Simulation; controller: GameController } {
    const simulation = new Simulation({ world });
    simulation.player.setTilePosition(PATCH_ORIGIN.x - 2, PATCH_ORIGIN.y);
    simulation.inventory.add('miner', 1);
    const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
    return { simulation, controller: new GameController({ game }) };
  }

  it('starts mining on the tick the build command is applied', () => {
    const { simulation } = buildable();
    simulation.commands.enqueue({
      type: 'build',
      buildingId: 'miner',
      x: PATCH_ORIGIN.x,
      y: PATCH_ORIGIN.y,
      rotation: NORTH,
    });

    // Phase 1 places it, phase 3 mines: one tick, one tick of progress.
    simulation.tick();
    const miner = simulation.entities.at(PATCH_ORIGIN.x, PATCH_ORIGIN.y) as MinerEntity | undefined;
    expect(miner?.status).toBe(MachineStatus.Running);
    expect(miner?.progressTicks).toBe(1);
  });

  it('counts the ore a placement would cover, for the ghost', () => {
    const { simulation } = buildable();
    // The whole patch: three iron and one copper, all of them minable tiles.
    expect(simulation.resourceTilesUnder('miner', PATCH_ORIGIN.x, PATCH_ORIGIN.y, NORTH)).toBe(4);
    // Half on, half off.
    expect(simulation.resourceTilesUnder('miner', PATCH_ORIGIN.x - 1, PATCH_ORIGIN.y, NORTH)).toBe(2);
    // A building that does not mine is not asked the question at all.
    expect(simulation.resourceTilesUnder('chest', PATCH_ORIGIN.x, PATCH_ORIGIN.y, NORTH)).toBeNull();
  });

  it('shows the count in the placement view the ghost is drawn from', () => {
    const { simulation, controller } = buildable();
    controller.selectBuilding('miner');
    simulation.player.setTilePosition(PATCH_ORIGIN.x - 2, PATCH_ORIGIN.y);

    const cursor = controller as unknown as { cursor: { hover: { x: number; y: number } | null } };
    cursor.cursor.hover = { x: PATCH_ORIGIN.x, y: PATCH_ORIGIN.y };

    const placement = controller.getPlacementView();
    expect(placement?.valid).toBe(true);
    expect(placement?.resourceTiles).toBe(4);
  });

  it('tells the inspector what the miner is doing and what is in it', () => {
    const { simulation, controller } = buildable();
    const miner = simulation.entities.create<MinerEntity>(newMiner(PATCH_ORIGIN.x, PATCH_ORIGIN.y, NORTH));
    const perItem = ticksPerItem(simulation);

    run(simulation, perItem + perItem / 2);
    const view = controller.getBuildingView(miner.id);

    expect(view?.status).toBe('running');
    expect(view?.progress).toBeCloseTo(0.5, 10);
    // Named and capped by the controller, so the panel can say "1/50" without
    // reaching for the item registry or the building table itself (§4).
    expect(view?.outputs).toEqual([{ itemId: 'iron_ore', name: 'Iron Ore', count: 1, capacity: 50 }]);
    expect(Object.isFrozen(view?.outputs)).toBe(true);

    // A building with no system behind it is still honestly idle.
    const chest = simulation.entities.create({ type: EntityType.Chest, x: 0, y: 0, rotation: NORTH });
    expect(controller.getBuildingView(chest.id)?.status).toBe('idle');
  });

  it('hands the depletion alert to the UI as one event per depletion', () => {
    const { simulation, controller } = buildable(testWorld(1));
    simulation.entities.create<MinerEntity>(newMiner(PATCH_ORIGIN.x, PATCH_ORIGIN.y, NORTH));

    const seen: string[] = [];
    controller.subscribe('alert', (event) => seen.push(event.alert.type));

    run(simulation, ticksPerItem(simulation) * 5);
    // Recorded inside the tick; delivered only when the frame is over (§13).
    expect(seen).toEqual([]);

    controller.pump();
    expect(seen).toEqual(['miner_no_resource']);
    expect(controller.getHudView().alerts).toBe(1);

    run(simulation, 300);
    controller.pump();
    expect(seen).toEqual(['miner_no_resource']);
  });
});
