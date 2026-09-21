import { describe, expect, it } from 'vitest';

import { BELT_MAX_POSITION, asBelt, laneAccept, type BeltEntity } from '../../src/game/entities/belt-entity.js';
import { asChest } from '../../src/game/entities/chest-entity.js';
import { asUnderground } from '../../src/game/entities/underground-belt-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * `belt -> underground run -> belt -> chest`. See ironflow.md §17 and C23.
 *
 * The chain every logistics chunk owes §17, and the one thing a single item's
 * arrival cannot prove: **throughput**. C23's whole claim about the
 * underground belt is that burying a line changes the *shape* of a factory and
 * nothing about its rate — so a run of it saturated for a minute must deliver
 * exactly what a surface belt of the same length delivers, item for item.
 *
 * Getting that wrong is invisible in play. A tunnel a tile faster than the
 * belt beside it turns burying a line into a throughput upgrade, and the only
 * way anyone would find out is by racing two lines in a finished factory —
 * which is what this is.
 */

function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

/** A game with `logistics_1` in hand and a stack of everything. */
function newGame(): Simulation {
  const simulation = new Simulation({ world: flatWorld() });
  simulation.researchSystem.grant('logistics_1');
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 100);
  return simulation;
}

function build(simulation: Simulation, id: string, x: number, y: number, rotation: Rotation): void {
  simulation.player.setTilePosition(x, y);
  simulation.commands.takeRejections();
  simulation.commands.enqueue({ type: 'build', buildingId: id, x, y, rotation });
  simulation.tick();
  const rejection = simulation.commands.takeRejections()[0];
  expect(rejection?.reason, `${id} at ${x},${y}`).toBeUndefined();
}

/** The span a run covers, and the surface line it is raced against. */
const SPAN = 5;
const FEED_X = 4;
const RUN_X = 10;
const CHEST_X = RUN_X + SPAN + 2;

/**
 * A line from `FEED_X` to a chest, with the middle either belt or buried.
 *
 * Identical tiles either side of the middle, so the only difference between
 * the two factories is what the items cross.
 */
function line(buried: boolean, y: number): Simulation {
  const simulation = newGame();
  for (let x = FEED_X; x < RUN_X; x++) build(simulation, 'belt', x, y, EAST);

  if (buried) {
    build(simulation, 'underground_belt', RUN_X, y, EAST);
    build(simulation, 'underground_belt', RUN_X + SPAN, y, EAST);
  } else {
    for (let x = RUN_X; x <= RUN_X + SPAN; x++) build(simulation, 'belt', x, y, EAST);
  }

  build(simulation, 'belt', RUN_X + SPAN + 1, y, EAST);
  build(simulation, 'chest', CHEST_X, y, NORTH);
  return simulation;
}

/**
 * Run for `ticks`, keeping the first belt saturated, and count what landed.
 *
 * The feed is topped up every tick rather than by a miner, because a miner at
 * §15's 0.5 items/s would measure the miner: what is under test is the line's
 * ceiling, and only a line that is never waiting for an item has one.
 */
function deliver(simulation: Simulation, y: number, ticks: number): number {
  const iron = simulation.items.idOf('iron_ore');
  const feed = asBelt(simulation.entities.at(FEED_X, y) as BeltEntity);
  expect(feed).not.toBeNull();

  for (let tick = 0; tick < ticks; tick++) {
    if (feed !== null) laneAccept(feed.items, iron, BELT_MAX_POSITION);
    simulation.tick();
  }

  const chest = asChest(simulation.entities.at(CHEST_X, y) as never);
  expect(chest).not.toBeNull();
  let total = 0;
  for (const entry of chest?.contents ?? []) total += entry[1];
  return total;
}

describe('a buried run carries exactly what the belt it replaces carried', () => {
  it('delivers the same count over a saturated minute', () => {
    const y = 20;
    const ticks = TPS * 60;

    const surfaceTotal = deliver(line(false, y), y, ticks);
    const buriedTotal = deliver(line(true, y), y, ticks);

    // §9's tier-1 belt is 8 items/s, so a saturated minute is about 480 — the
    // assertion is the *equality*, and this is the guard that both lines were
    // actually running rather than both jammed at zero.
    expect(surfaceTotal).toBeGreaterThan(400);
    expect(buriedTotal).toBe(surfaceTotal);
  });

  it('stalls back through the tunnel when the chest cannot be reached', () => {
    const y = 40;
    const simulation = newGame();
    for (let x = FEED_X; x < RUN_X; x++) build(simulation, 'belt', x, y, EAST);
    build(simulation, 'underground_belt', RUN_X, y, EAST);
    build(simulation, 'underground_belt', RUN_X + SPAN, y, EAST);
    // Nothing beyond the far mouth: the run has nowhere to put anything.

    const iron = simulation.items.idOf('iron_ore');
    const feed = asBelt(simulation.entities.at(FEED_X, y) as BeltEntity);
    for (let tick = 0; tick < TPS * 30; tick++) {
      if (feed !== null) laneAccept(feed.items, iron, BELT_MAX_POSITION);
      simulation.tick();
    }

    // §9's backpressure, through six tiles of ground: the run fills to a
    // belt's density, the belt behind it fills, and nothing is lost. Four
    // slots a tile over the run's six tiles, plus the six belt tiles feeding
    // it, is the whole of what the line can hold.
    const entrance = simulation.entities.at(RUN_X, y);
    const mouth = entrance === undefined ? null : asUnderground(entrance, simulation.buildings);
    expect(mouth?.items).toHaveLength(4 * (SPAN + 1));
    expect(feed?.items).toHaveLength(4);
  });
});
