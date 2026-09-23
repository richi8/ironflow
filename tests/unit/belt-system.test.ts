import { describe, expect, it } from 'vitest';

import {
  BELT_MAX_POSITION,
  BELT_SLOTS_PER_TILE,
  BELT_SLOT_SPACING,
  BELT_TILE_UNITS,
  laneAccept,
  newBelt,
  type BeltEntity,
} from '../../src/game/entities/belt-entity.js';
import { asChest, newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { newMiner, type MinerEntity } from '../../src/game/entities/miner-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { stacked } from '../fixtures/chest.js';

/**
 * Belts. See ironflow.md §9 and C13.
 *
 * The chunk's five tests, in the order the plan lists them:
 *
 * 1. movement over N ticks against an exact expected layout;
 * 2. blocking and compaction;
 * 3. hand-off between directions;
 * 4. **build-order independence** — the same line built in two orders is the
 *    same state after 600 ticks;
 * 5. throughput.
 *
 * Four of the five are about *ordering*, which is what makes this file worth
 * reading: a belt system that moves items upstream-first passes the first test
 * and fails the last two, and the difference does not show up as a crash. It
 * shows up as a factory that runs at a different speed depending on which end
 * of it the player built first.
 */

/** Grass everywhere, nothing on it. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

/** Grass, with `amount` iron on the 2x2 square at `(ox, oy)`. */
function oreWorld(ox: number, oy: number, amount: number): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        if (x < ox || x > ox + 1 || y < oy || y > oy + 1) continue;
        const index = localIndex(lx, ly);
        chunk.resource[index] = ResourceType.Iron;
        chunk.resourceAmount[index] = amount;
      }
    }
    return chunk;
  });
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** The belt tier-1 speed, read from content rather than written down twice. */
const UNITS_PER_TICK = (() => {
  const registry = new BuildingRegistry(BUILDINGS);
  const config = registry.beltFor(registry.get('belt').entityType);
  if (config === null) throw new Error('belt content is missing a speed');
  return config.unitsPerTick;
})();

/** Lay a run of belts, `length` tiles long, all facing the same way. */
function layLine(
  simulation: Simulation,
  x: number,
  y: number,
  rotation: Rotation,
  length: number,
  order: 'forwards' | 'backwards' = 'forwards',
): BeltEntity[] {
  const step = rotation === EAST ? { x: 1, y: 0 } : rotation === SOUTH ? { x: 0, y: 1 } : { x: -1, y: 0 };
  const tiles = Array.from({ length }, (_unused, i) => ({ x: x + step.x * i, y: y + step.y * i }));
  const laid = order === 'forwards' ? tiles : [...tiles].reverse();
  const belts = new Map<string, BeltEntity>();
  for (const tile of laid) {
    belts.set(`${tile.x},${tile.y}`, simulation.entities.create<BeltEntity>(newBelt(tile.x, tile.y, rotation)));
  }
  // Returned in *tile* order whatever order they were built in, so a test can
  // say "the third tile" and mean the same tile either way.
  return tiles.map((tile) => {
    const belt = belts.get(`${tile.x},${tile.y}`);
    if (belt === undefined) throw new Error('missing belt');
    return belt;
  });
}

/** Item positions on a belt, front-first. The shape every assertion compares. */
function positions(belt: BeltEntity): number[] {
  return belt.items.map((item) => item.pos);
}

/** Every belt's contents, keyed by tile rather than by entity id. */
function layout(simulation: Simulation): Record<string, [number, number][]> {
  const out: Record<string, [number, number][]> = {};
  simulation.entities.forEach((entity) => {
    const belt = entity as BeltEntity;
    if (belt.items === undefined) return;
    out[`${belt.x},${belt.y}`] = belt.items.map((item) => [item.itemId, item.pos]);
  });
  return out;
}

describe('the belt model', () => {
  it('spaces four items to a tile, exactly as §9 says', () => {
    expect(BELT_SLOTS_PER_TILE).toBe(4);
    expect(BELT_SLOT_SPACING * BELT_SLOTS_PER_TILE).toBe(BELT_TILE_UNITS);
    expect(BELT_MAX_POSITION).toBe(BELT_TILE_UNITS - 1);
  });

  it('turns §9s 2.0 tiles/s into a whole number of units per tick', () => {
    // §6 R3: converted once, at registry-build time, and an integer thereafter.
    expect(Number.isInteger(UNITS_PER_TICK)).toBe(true);
    expect(UNITS_PER_TICK).toBe(Math.round((2.0 * BELT_TILE_UNITS) / TPS));
  });
});

describe('belt movement', () => {
  it('advances an item by exactly one speed per tick', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const [belt] = layLine(simulation, 0, 0, EAST, 3);
    if (belt === undefined) throw new Error('no belt');
    laneAccept(belt.items, simulation.items.idOf('iron_ore'), 0);

    for (let tick = 1; tick <= 5; tick++) {
      simulation.tick();
      expect(positions(belt)).toEqual([UNITS_PER_TICK * tick]);
    }
  });

  it('carries the overshoot across the tile boundary rather than dropping it', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const [first, second] = layLine(simulation, 0, 0, EAST, 3);
    if (first === undefined || second === undefined) throw new Error('no belt');
    laneAccept(first.items, simulation.items.idOf('iron_ore'), BELT_MAX_POSITION);

    simulation.tick();
    // It left the first tile and arrived on the second one carrying exactly
    // the distance it had left over — not at zero, which would lose a fraction
    // of a tile on every boundary and make a long belt slower than a short one.
    expect(positions(first)).toEqual([]);
    expect(positions(second)).toEqual([BELT_MAX_POSITION + UNITS_PER_TICK - BELT_TILE_UNITS]);
  });

  it('takes one item across a known line in the tick the arithmetic says', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belts = layLine(simulation, 0, 0, EAST, 4);
    const head = belts[0];
    const tail = belts[3];
    if (head === undefined || tail === undefined) throw new Error('no belt');
    laneAccept(head.items, simulation.items.idOf('iron_ore'), 0);

    // Three whole tiles to cross, from position 0.
    const expected = Math.ceil((3 * BELT_TILE_UNITS) / UNITS_PER_TICK);
    run(simulation, expected - 1);
    expect(positions(tail)).toEqual([]);
    simulation.tick();
    expect(tail.items.length).toBe(1);
  });
});

describe('belt blocking and compaction', () => {
  /** A line whose last tile leads nowhere, so everything backs up behind it. */
  function deadEnd(): { simulation: Simulation; belts: BeltEntity[] } {
    const simulation = new Simulation({ world: flatWorld() });
    return { simulation, belts: layLine(simulation, 0, 0, EAST, 3) };
  }

  it('stops the front item at the exit edge when there is nowhere to go', () => {
    const { simulation, belts } = deadEnd();
    const last = belts[2];
    if (last === undefined) throw new Error('no belt');
    laneAccept(last.items, simulation.items.idOf('iron_ore'), 0);

    run(simulation, 200);
    expect(positions(last)).toEqual([BELT_MAX_POSITION]);
  });

  it('compacts the items behind it one slot apart, and no closer', () => {
    const { simulation, belts } = deadEnd();
    const last = belts[2];
    if (last === undefined) throw new Error('no belt');
    const iron = simulation.items.idOf('iron_ore');
    for (let i = 0; i < BELT_SLOTS_PER_TILE; i++) laneAccept(last.items, iron, BELT_MAX_POSITION);

    run(simulation, 200);
    expect(positions(last)).toEqual([
      BELT_MAX_POSITION,
      BELT_MAX_POSITION - BELT_SLOT_SPACING,
      BELT_MAX_POSITION - 2 * BELT_SLOT_SPACING,
      BELT_MAX_POSITION - 3 * BELT_SLOT_SPACING,
    ]);
  });

  it('never puts more than four items on a tile', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const [belt] = layLine(simulation, 0, 0, EAST, 1);
    if (belt === undefined) throw new Error('no belt');
    const iron = simulation.items.idOf('iron_ore');
    for (let i = 0; i < 20; i++) laneAccept(belt.items, iron, BELT_MAX_POSITION);

    expect(belt.items.length).toBe(BELT_SLOTS_PER_TILE);
    run(simulation, 100);
    expect(belt.items.length).toBe(BELT_SLOTS_PER_TILE);
  });

  it('propagates the block backwards up the line until the whole line is full', () => {
    const { simulation, belts } = deadEnd();
    const head = belts[0];
    if (head === undefined) throw new Error('no belt');
    const iron = simulation.items.idOf('iron_ore');

    // Feed the head as fast as it will take anything, for long enough that the
    // block has to travel the whole line backwards to reach it.
    for (let tick = 0; tick < 400; tick++) {
      while (laneAccept(head.items, iron, BELT_MAX_POSITION)) {
        /* saturate */
      }
      simulation.tick();
    }

    // Every tile full, every item a slot apart: §9's "backpressure that
    // propagates", which is the difference between a factory game and a
    // conveyor that deletes what it cannot deliver.
    for (const belt of belts) expect(belt.items.length).toBe(BELT_SLOTS_PER_TILE);
    expect(positions(belts[0] as BeltEntity)[0]).toBe(BELT_MAX_POSITION);
  });
});

describe('belt hand-off', () => {
  it('carries an item around a corner into a belt facing another way', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const east = simulation.entities.create<BeltEntity>(newBelt(0, 0, EAST));
    const south = simulation.entities.create<BeltEntity>(newBelt(1, 0, SOUTH));
    const below = simulation.entities.create<BeltEntity>(newBelt(1, 1, SOUTH));
    laneAccept(east.items, simulation.items.idOf('iron_ore'), BELT_MAX_POSITION);

    simulation.tick();
    expect(east.items.length).toBe(0);
    expect(south.items.length).toBe(1);

    run(simulation, Math.ceil(BELT_TILE_UNITS / UNITS_PER_TICK));
    expect(below.items.length).toBe(1);
  });

  it('refuses a hand-off into a belt facing straight back at it', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const east = simulation.entities.create<BeltEntity>(newBelt(0, 0, EAST));
    const west = simulation.entities.create<BeltEntity>(newBelt(1, 0, WEST));
    laneAccept(east.items, simulation.items.idOf('iron_ore'), BELT_MAX_POSITION);

    run(simulation, 50);
    // Neither belt passes to the other, so the item waits at the seam instead
    // of being traded back and forth every tick.
    expect(positions(east)).toEqual([BELT_MAX_POSITION]);
    expect(west.items.length).toBe(0);
  });

  it('waits at the end of a line that leads into a building with no way in', () => {
    const simulation = new Simulation({ world: oreWorld(2, 0, 100) });
    const belt = simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    simulation.entities.create<MinerEntity>(newMiner(2, 0, NORTH));
    laneAccept(belt.items, simulation.items.idOf('iron_ore'), BELT_MAX_POSITION);

    run(simulation, 50);
    expect(positions(belt)).toEqual([BELT_MAX_POSITION]);
  });
});

describe('belts into containers', () => {
  it('empties the end of the line into a chest', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belts = layLine(simulation, 0, 0, EAST, 3);
    const chest = simulation.entities.create<ChestEntity>(newChest(3, 0, NORTH));
    const head = belts[0];
    if (head === undefined) throw new Error('no belt');
    laneAccept(head.items, simulation.items.idOf('iron_ore'), 0);

    run(simulation, 200);
    expect(chest.contents).toEqual([[0, simulation.items.idOf('iron_ore'), 1]]);
  });

  it('backs the line up when the chest is full, rather than deleting items', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belts = layLine(simulation, 0, 0, EAST, 3);
    const chest = simulation.entities.create<ChestEntity>(newChest(3, 0, NORTH));
    const iron = simulation.items.idOf('iron_ore');

    // Filled to the brim by hand — slots times a full stack — so the belt has
    // nowhere at all to put the next item.
    const slots = simulation.buildings.get('chest').storage?.slots ?? 0;
    const full = slots * simulation.items.get('iron_ore').stackSize;
    expect(full).toBeGreaterThan(0);
    chest.contents = stacked(simulation, [[iron, full]]);

    const head = belts[0];
    if (head === undefined) throw new Error('no belt');

    for (let tick = 0; tick < 400; tick++) {
      while (laneAccept(head.items, iron, BELT_MAX_POSITION)) {
        /* saturate */
      }
      simulation.tick();
    }

    // Nothing went in and, crucially, nothing went missing.
    expect(chest.contents.reduce((sum, entry) => sum + entry[2], 0)).toBe(full);
    for (const belt of belts) expect(belt.items.length).toBe(BELT_SLOTS_PER_TILE);
  });
});

describe('belt ordering', () => {
  /**
   * §8's downstream-first rule, stated as the thing a player would notice.
   *
   * Build the same line in both directions, run it, and compare the item
   * layout tile by tile. An upstream-first system passes every other test in
   * this file and fails this one — items compress by a slot per tick, so the
   * line built one way runs measurably slower than the line built the other.
   */
  function feedLine(order: 'forwards' | 'backwards'): Record<string, [number, number][]> {
    const simulation = new Simulation({ world: flatWorld() });
    const belts = layLine(simulation, 0, 0, EAST, 8, order);
    const head = belts[0];
    if (head === undefined) throw new Error('no belt');
    const iron = simulation.items.idOf('iron_ore');

    for (let tick = 0; tick < 600; tick++) {
      while (laneAccept(head.items, iron, BELT_MAX_POSITION)) {
        /* saturate */
      }
      simulation.tick();
    }
    return layout(simulation);
  }

  it('runs a line identically whether it was built forwards or backwards', () => {
    expect(feedLine('forwards')).toEqual(feedLine('backwards'));
  });

  it('runs the same way twice from the same start', () => {
    expect(feedLine('forwards')).toEqual(feedLine('forwards'));
  });

  it('delivers the same count whichever order the line was built in', () => {
    const delivered = (order: 'forwards' | 'backwards'): number => {
      const simulation = new Simulation({ world: flatWorld() });
      const belts = layLine(simulation, 0, 0, EAST, 8, order);
      const chest = simulation.entities.create<ChestEntity>(newChest(8, 0, NORTH));
      const head = belts[0];
      if (head === undefined) throw new Error('no belt');
      const iron = simulation.items.idOf('iron_ore');
      for (let tick = 0; tick < 600; tick++) {
        while (laneAccept(head.items, iron, BELT_MAX_POSITION)) {
          /* saturate */
        }
        simulation.tick();
      }
      return (asChest(chest)?.contents ?? []).reduce((sum, entry) => sum + entry[2], 0);
    };

    expect(delivered('forwards')).toBe(delivered('backwards'));
  });
});

describe('belt throughput', () => {
  it('carries 8.0 items a second at tier 1, within 1%', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const belts = layLine(simulation, 0, 0, EAST, 10);
    const chest = simulation.entities.create<ChestEntity>(newChest(10, 0, NORTH));
    const head = belts[0];
    if (head === undefined) throw new Error('no belt');
    const iron = simulation.items.idOf('iron_ore');

    const feed = (ticks: number): void => {
      for (let tick = 0; tick < ticks; tick++) {
        while (laneAccept(head.items, iron, BELT_MAX_POSITION)) {
          /* saturate */
        }
        simulation.tick();
      }
    };

    // Prime the line first. A ten-tile belt holds five seconds of travel, and
    // measuring from an empty one measures the fill as well as the rate.
    feed(600);
    const before = (asChest(chest)?.contents ?? []).reduce((sum, entry) => sum + entry[2], 0);
    feed(60 * TPS);
    const after = (asChest(chest)?.contents ?? []).reduce((sum, entry) => sum + entry[2], 0);

    const perSecond = (after - before) / 60;
    // 7.97, not 8.00: 256 units per tile over 30 ticks is 17.07 units a tick
    // and stores as 17 (§6 R3). C13's criterion allows ±1% for exactly this,
    // and the error is 0.42% — see `BeltConfig` on why the scale is not
    // chosen to divide the tick rate instead.
    expect(perSecond).toBeGreaterThan(8 * 0.99);
    expect(perSecond).toBeLessThan(8 * 1.01);
  });
});

describe('machines loading belts', () => {
  it('drops a miners output onto the belt its output side faces', () => {
    const simulation = new Simulation({ world: oreWorld(0, 1, 500) });
    // A 2x2 miner at (0, 1) facing north has two tiles in front of it; the
    // belt is under the second, so this also checks that both are tried.
    simulation.entities.create<MinerEntity>(newMiner(0, 1, NORTH));
    simulation.entities.create<BeltEntity>(newBelt(1, 0, EAST));
    simulation.entities.create<ChestEntity>(newChest(2, 0, NORTH));

    run(simulation, 10 * TPS);
    // 0.5 items/s for ten seconds, minus whatever is still in transit.
    const chest = simulation.entities.at(2, 0) as ChestEntity;
    expect(chest.contents[0]?.[2]).toBeGreaterThanOrEqual(4);
    expect(chest.contents[0]?.[1]).toBe(simulation.items.idOf('iron_ore'));
  });

  it('stalls the miner with output_full when the belt cannot take any more', () => {
    const simulation = new Simulation({ world: oreWorld(0, 1, 5000) });
    const miner = simulation.entities.create<MinerEntity>(newMiner(0, 1, NORTH));
    // A single belt tile leading nowhere: it holds four items and then the
    // miner's own buffer has to absorb everything, which is C11's stall.
    simulation.entities.create<BeltEntity>(newBelt(0, 0, NORTH));

    const capacity = simulation.buildings.miningFor(miner.type)?.bufferCapacity ?? 0;
    run(simulation, (capacity + 10) * 2 * TPS);

    expect(miner.status).toBe(MachineStatus.OutputFull);
    expect(miner.outputCount).toBe(capacity);
  });
});

describe('belt performance', () => {
  it('moves 12,000 belt tiles carrying 8,000 items in well under 4 ms a tick', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const iron = simulation.items.idOf('iron_ore');
    const belts: BeltEntity[] = [];
    // 120 lines of 100, spaced so no line feeds another: §12's reference
    // factory shape, and the worst case for the downstream-first walk.
    for (let line = 0; line < 120; line++) {
      for (let x = 0; x < 100; x++) {
        belts.push(simulation.entities.create<BeltEntity>(newBelt(x, line * 2, EAST)));
      }
    }
    let placed = 0;
    for (const belt of belts) {
      while (placed < 8000 && laneAccept(belt.items, iron, BELT_MAX_POSITION)) placed += 1;
      if (placed >= 8000) break;
    }
    expect(belts.length).toBe(12000);
    expect(placed).toBe(8000);

    simulation.tick(); // build the order, which is what a real session amortises
    const runs = 100;
    const started = performance.now();
    for (let i = 0; i < runs; i++) simulation.tick();
    const perTick = (performance.now() - started) / runs;

    // Measured at about 0.8 ms on the development machine. The assertion is
    // the plan's budget, not the measurement: a timing test that pins the
    // machine it was written on fails on every other one (§17).
    expect(perTick).toBeLessThan(4);
  });
});
