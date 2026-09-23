import { describe, expect, it } from 'vitest';

import {
  BELT_MAX_POSITION,
  laneAccept,
  newBelt,
  type BeltEntity,
} from '../../src/game/entities/belt-entity.js';
import { asChest, newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import type { Entity } from '../../src/game/entities/entity.js';
import {
  SPLITTER_LANES,
  asSplitter,
  newSplitter,
  otherSide,
  splitterInputTile,
  splitterOutputTile,
  splitterTile,
  type SplitterEntity,
} from '../../src/game/entities/splitter-entity.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { BuildingRegistry, type BuildingDefinition } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { heldIn } from '../fixtures/chest.js';

/**
 * Splitters. See ironflow.md §9 and C17.
 *
 * The chunk's four tests, in the order the plan lists them:
 *
 * 1. **split ratio over a long run** — 1,000 items down a saturated input come
 *    out 500/500;
 * 2. **blocked output** — one side jammed sends 100% down the other, and at
 *    the *same* rate a plain belt would have carried it;
 * 3. **round-robin counter persistence** — a factory serialized mid-run and
 *    rebuilt from that data alone continues identically;
 * 4. **determinism across build order** — the same layout laid in two
 *    different orders is the same state after a long run.
 *
 * Three of the four are about fairness holding *over time*, which is why they
 * are long runs against exact counts rather than a few ticks against a layout:
 * a splitter that alternates almost-fairly looks perfect for ten items and
 * silently starves one branch of a factory over twenty minutes.
 */

/** Grass everywhere, nothing on it. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** The splitter's footprint, read from content rather than written down twice. */
const SPLITTER_SIZE = (() => {
  const registry = new BuildingRegistry(BUILDINGS);
  return registry.get('splitter').size;
})();

/**
 * One saturated feed, a splitter, and whatever the caller puts in front of it.
 *
 * Every test below is this shape with different things at the two outputs, so
 * the geometry lives here once: an east-facing splitter at `(10, 10)` covering
 * two tiles stacked north–south, with a belt behind each of them.
 */
interface Rig {
  readonly simulation: Simulation;
  readonly splitter: SplitterEntity;
  readonly feeds: BeltEntity[];
  readonly chests: (ChestEntity | null)[];
}

const SPLITTER_X = 10;
const SPLITTER_Y = 10;

/**
 * Build the rig.
 *
 * `outputs` says what each side leads to: a belt into a chest, or nothing at
 * all. `inputs` says which sides are fed. Both are per side, in the side order
 * `splitterTile` walks.
 */
function rig(inputs: readonly boolean[], outputs: readonly boolean[]): Rig {
  const simulation = new Simulation({ world: flatWorld() });
  const splitter = simulation.entities.create<SplitterEntity>(
    newSplitter(SPLITTER_X, SPLITTER_Y, EAST),
  );

  const feeds: BeltEntity[] = [];
  const chests: (ChestEntity | null)[] = [];

  for (let side = 0; side < SPLITTER_LANES; side++) {
    const index = side as 0 | 1;
    const inTile = splitterInputTile(splitter, SPLITTER_SIZE, index);
    const outTile = splitterOutputTile(splitter, SPLITTER_SIZE, index);
    if (inTile === null || outTile === null) throw new Error('no tile');

    if (inputs[side] === true) {
      feeds.push(simulation.entities.create<BeltEntity>(newBelt(inTile.x, inTile.y, EAST)));
    }

    if (outputs[side] === true) {
      simulation.entities.create<BeltEntity>(newBelt(outTile.x, outTile.y, EAST));
      chests.push(simulation.entities.create<ChestEntity>(newChest(outTile.x + 1, outTile.y, NORTH)));
    } else {
      chests.push(null);
    }
  }

  return { simulation, splitter, feeds, chests };
}

/** Top every feed belt up, then tick. A source that never runs dry. */
function runSaturated(rig: Rig, ticks: number, itemIds: readonly string[]): void {
  const ids = rig.feeds.map((_unused, i) => rig.simulation.items.idOf(itemIds[i] ?? 'iron_ore'));
  for (let tick = 0; tick < ticks; tick++) {
    for (let i = 0; i < rig.feeds.length; i++) {
      const feed = rig.feeds[i];
      const itemId = ids[i];
      if (feed === undefined || itemId === undefined) continue;
      while (laneAccept(feed.items, itemId, BELT_MAX_POSITION)) {
        // Fill it to its four slots; the loop stops when the tile is full.
      }
    }
    rig.simulation.tick();
  }
}

/** How much a chest holds in total, or 0 for a side that leads nowhere. */
function held(chest: ChestEntity | null): number {
  if (chest === null) return 0;
  return asChest(chest)?.contents.reduce((sum, entry) => sum + entry[2], 0) ?? 0;
}

/** How much of one item a chest holds. */
function heldOf(simulation: Simulation, chest: ChestEntity | null, itemId: string): number {
  if (chest === null) return 0;
  const id = simulation.items.idOf(itemId);
  return heldIn(asChest(chest)?.contents, id);
}

/**
 * Every entity's state, keyed by tile rather than by entity id.
 *
 * Keyed by tile so that two factories built in different orders — and
 * therefore with different ids — can be compared at all, which is what the
 * build-order test needs. It is JSON because that is the round trip C24 will
 * make, so anything this comparison cannot see is something a save would lose.
 */
function layout(simulation: Simulation): Record<string, string> {
  const out: Record<string, string> = {};
  simulation.entities.forEach((entity) => {
    const { id: _id, ...rest } = entity;
    out[`${entity.x},${entity.y}`] = JSON.stringify(rest);
  });
  return out;
}

describe('the splitter as a shape', () => {
  it('is two tiles across the flow and one deep, whichever way it is turned', () => {
    for (const rotation of [NORTH, EAST, SOUTH, WEST] as Rotation[]) {
      const simulation = new Simulation({ world: flatWorld() });
      const splitter = simulation.entities.create<SplitterEntity>(newSplitter(4, 4, rotation));

      const a = splitterTile(splitter, SPLITTER_SIZE, 0);
      const b = splitterTile(splitter, SPLITTER_SIZE, 1);
      // Adjacent, and never the same tile.
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);

      for (const side of [0, 1] as const) {
        const tile = splitterTile(splitter, SPLITTER_SIZE, side);
        const input = splitterInputTile(splitter, SPLITTER_SIZE, side);
        const output = splitterOutputTile(splitter, SPLITTER_SIZE, side);
        if (input === null || output === null) throw new Error('no tile');
        // The two neighbours of a side are one step back and one step on, so
        // the input and the output are two tiles apart through it.
        expect(Math.abs(input.x - tile.x) + Math.abs(input.y - tile.y)).toBe(1);
        expect(Math.abs(output.x - tile.x) + Math.abs(output.y - tile.y)).toBe(1);
        expect(input.x + output.x).toBe(2 * tile.x);
        expect(input.y + output.y).toBe(2 * tile.y);
      }
    }
  });

  it('is plain serializable data, cursors included', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const splitter = simulation.entities.create<SplitterEntity>(newSplitter(4, 4, EAST));
    laneAccept(splitter.lanes[0], simulation.items.idOf('iron_ore'), 100);
    splitter.outputCursor = 1;

    expect(structuredClone(splitter)).toEqual(splitter);
    expect(JSON.parse(JSON.stringify(splitter))).toEqual(splitter);
  });

  it('refuses content whose footprint is not two across and one deep', () => {
    const base = BUILDINGS.find((building) => building.id === 'splitter');
    if (base === undefined) throw new Error('no splitter in content');

    const wrong: BuildingDefinition = { ...base, size: { width: 2, height: 2 } };
    expect(() => new BuildingRegistry([wrong])).toThrow(/2x1/);
  });

  it('flips a side to the other one and back', () => {
    expect(otherSide(0)).toBe(1);
    expect(otherSide(1)).toBe(0);
  });
});

describe('splitting', () => {
  it('splits a saturated input 50/50 over a thousand items', () => {
    const r = rig([true, false], [true, true]);
    // 8 items/s down one belt is a shade under four ticks an item, so this is
    // comfortably more than the thousand the acceptance criterion asks for.
    runSaturated(r, 4200, ['iron_ore']);

    const a = held(r.chests[0] ?? null);
    const b = held(r.chests[1] ?? null);
    expect(a + b).toBeGreaterThanOrEqual(1000);
    // §9: deterministic round-robin. Not "about half" — exactly alternating,
    // so the only slack is the item currently in flight on one of the two
    // output belts.
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
  });

  it('sends everything down the free side when the other is blocked, at no cost in throughput', () => {
    const split = rig([true, false], [true, false]);
    runSaturated(split, 2000, ['iron_ore']);

    // A plain belt line of the same length: feed, one middle tile, output
    // tile, chest. The splitter's lane is one tile deep, so this is the same
    // distance travelled and the same number of hand-offs.
    const plain = new Simulation({ world: flatWorld() });
    const feed = plain.entities.create<BeltEntity>(newBelt(SPLITTER_X - 1, SPLITTER_Y, EAST));
    plain.entities.create<BeltEntity>(newBelt(SPLITTER_X, SPLITTER_Y, EAST));
    plain.entities.create<BeltEntity>(newBelt(SPLITTER_X + 1, SPLITTER_Y, EAST));
    const plainChest = plain.entities.create<ChestEntity>(newChest(SPLITTER_X + 2, SPLITTER_Y, NORTH));
    const iron = plain.items.idOf('iron_ore');
    for (let tick = 0; tick < 2000; tick++) {
      while (laneAccept(feed.items, iron, BELT_MAX_POSITION)) {
        // Saturate it the same way the rig does.
      }
      plain.tick();
    }

    const throughBlocked = held(split.chests[0] ?? null);
    expect(held(split.chests[1] ?? null)).toBe(0);
    expect(throughBlocked).toBeGreaterThan(400);
    expect(Math.abs(throughBlocked - held(plainChest))).toBeLessThanOrEqual(1);
  });

  it('merges two inputs into one output, alternating between them', () => {
    const r = rig([true, true], [true, false]);
    runSaturated(r, 3000, ['iron_ore', 'copper_ore']);

    const chest = r.chests[0] ?? null;
    const iron = heldOf(r.simulation, chest, 'iron_ore');
    const copper = heldOf(r.simulation, chest, 'copper_ore');

    expect(iron + copper).toBeGreaterThan(700);
    // C17 task 3: the two belts feeding it alternate deterministically. Both
    // inputs are saturated, so neither may be starved by the other — the
    // slack is again the items still in flight.
    expect(Math.abs(iron - copper)).toBeLessThanOrEqual(2);
  });

  it('does not take items across its flank', () => {
    const r = rig([true, false], [true, true]);
    // A belt running into the side of the splitter's first tile, pointed at it.
    const flank = r.simulation.entities.create<BeltEntity>(
      newBelt(SPLITTER_X, SPLITTER_Y - 1, SOUTH),
    );
    const iron = r.simulation.items.idOf('iron_ore');
    laneAccept(flank.items, iron, BELT_MAX_POSITION);

    run(r.simulation, 60);
    // §15 gives a splitter two inputs, and its back edge is where they are.
    // The item waits at the exit edge of the belt, which is what every other
    // belt pointed at the side of a machine does.
    expect(flank.items.length).toBe(1);
    expect(flank.items[0]?.pos).toBe(BELT_MAX_POSITION);
  });

  it('stalls the belt feeding it when both outputs are blocked', () => {
    const r = rig([true, false], [false, false]);
    runSaturated(r, 400, ['iron_ore']);

    const feed = r.feeds[0];
    if (feed === undefined) throw new Error('no feed');
    // §9's backpressure: the lane fills, then the belt behind it fills, and
    // nothing is destroyed on the way.
    expect(r.splitter.lanes[0].length).toBe(4);
    expect(r.splitter.lanes[1].length).toBe(0);
    expect(feed.items.length).toBe(4);
    expect(feed.items[0]?.pos).toBe(BELT_MAX_POSITION);
  });
});

describe('determinism', () => {
  it('continues identically from nothing but the serialized entity state', () => {
    // The acceptance criterion: behaviour is identical across a save/load,
    // which is only true if the round-robin counters are on the entity. A
    // cursor kept in `BeltSystem` would be rebuilt as zero here and the two
    // factories would diverge within a few items.
    const straight = rig([true, false], [true, true]);
    runSaturated(straight, 800, ['iron_ore']);

    const halfway = rig([true, false], [true, true]);
    runSaturated(halfway, 400, ['iron_ore']);

    const resumed = rig([true, false], [true, true]);
    restore(resumed.simulation, halfway.simulation);
    runSaturated(resumed, 400, ['iron_ore']);

    expect(layout(resumed.simulation)).toEqual(layout(straight.simulation));
  });

  it('runs the same whichever end of the line was built first', () => {
    const forwards = builtInOrder('forwards');
    const backwards = builtInOrder('backwards');

    runSaturated(forwards, 900, ['iron_ore']);
    runSaturated(backwards, 900, ['iron_ore']);

    expect(layout(backwards.simulation)).toEqual(layout(forwards.simulation));
    expect(held(forwards.chests[0] ?? null)).toBeGreaterThan(100);
  });
});

/**
 * Copy one simulation's entity state onto another's, through JSON.
 *
 * Both were built the same way, so the store handed out the same ids in the
 * same order and an entity can be matched to its counterpart by id. The round
 * trip is the point: anything a field cannot survive is a field C24's save
 * would lose, and the test that follows would catch it as a divergence.
 */
function restore(target: Simulation, source: Simulation): void {
  const state = new Map<number, Record<string, unknown>>();
  source.entities.forEach((entity) => {
    state.set(entity.id, JSON.parse(JSON.stringify(entity)) as Record<string, unknown>);
  });

  target.entities.forEach((entity) => {
    const saved = state.get(entity.id);
    if (saved === undefined) throw new Error(`nothing saved for entity ${entity.id}`);
    Object.assign(entity as unknown as Record<string, unknown>, saved);
  });
}

/**
 * The same layout, laid from the feed end or from the chest end.
 *
 * The splitter is created in the middle either way, so the two runs differ in
 * whether its id is below or above the belts it feeds — which is exactly the
 * thing the downstream-first order must not depend on.
 */
function builtInOrder(order: 'forwards' | 'backwards'): Rig {
  const simulation = new Simulation({ world: flatWorld() });
  const steps: (() => Entity)[] = [];

  steps.push(() => simulation.entities.create<BeltEntity>(newBelt(SPLITTER_X - 2, SPLITTER_Y, EAST)));
  steps.push(() => simulation.entities.create<BeltEntity>(newBelt(SPLITTER_X - 1, SPLITTER_Y, EAST)));
  steps.push(() => simulation.entities.create<SplitterEntity>(newSplitter(SPLITTER_X, SPLITTER_Y, EAST)));
  steps.push(() => simulation.entities.create<BeltEntity>(newBelt(SPLITTER_X + 1, SPLITTER_Y, EAST)));
  steps.push(() => simulation.entities.create<BeltEntity>(newBelt(SPLITTER_X + 1, SPLITTER_Y + 1, EAST)));
  steps.push(() => simulation.entities.create<ChestEntity>(newChest(SPLITTER_X + 2, SPLITTER_Y, NORTH)));
  steps.push(() => simulation.entities.create<ChestEntity>(newChest(SPLITTER_X + 2, SPLITTER_Y + 1, NORTH)));

  const built = (order === 'forwards' ? steps : [...steps].reverse()).map((step) => step());
  const byTile = new Map<string, Entity>();
  for (const entity of built) byTile.set(`${entity.x},${entity.y}`, entity);

  const feed = byTile.get(`${SPLITTER_X - 2},${SPLITTER_Y}`);
  const splitter = byTile.get(`${SPLITTER_X},${SPLITTER_Y}`);
  const first = byTile.get(`${SPLITTER_X + 2},${SPLITTER_Y}`);
  const second = byTile.get(`${SPLITTER_X + 2},${SPLITTER_Y + 1}`);
  if (feed === undefined || splitter === undefined) throw new Error('nothing built');

  const asSplitterEntity = asSplitter(splitter);
  if (asSplitterEntity === null) throw new Error('not a splitter');

  return {
    simulation,
    splitter: asSplitterEntity,
    feeds: [feed as BeltEntity],
    chests: [(first ?? null) as ChestEntity | null, (second ?? null) as ChestEntity | null],
  };
}
