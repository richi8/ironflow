import { describe, expect, it } from 'vitest';

import type { Command } from '../../src/game/commands/command.js';
import {
  MINE_RANGE_TILES,
  MINE_TICKS_PER_ITEM,
  PLAYER_STEP_SUBTILES,
  SUBTILES_PER_TILE,
  subtileToTile,
  tileCentreSubtile,
} from '../../src/game/player/player-state.js';
import { Simulation } from '../../src/game/simulation.js';
import { CHUNK_SIZE, createChunk, localIndex } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { TileType } from '../../src/game/world/tile.js';
import { World } from '../../src/game/world/world.js';

/**
 * Walking and manual gathering. See ironflow.md C10.
 *
 * The four acceptance criteria, in order:
 *
 * 1. the player walks and is blocked by water and by buildings;
 * 2. mining fills the bag at the stated rate, and stops when the bag is full
 *    or the tile is empty;
 * 3. a building cannot be placed out of range (that one lives in
 *    `build-system.test.ts`, beside the rest of placement);
 * 4. movement speed is identical at 30 fps and at 144 fps.
 *
 * The fourth is the one worth explaining. Nothing here mentions frames,
 * because the *design* is what makes it true: a `movePlayer` command sets a
 * direction that persists, and a tick — never a frame, never a command — is
 * what moves the player one step. So the test for it is "the same command
 * stream, delivered in different numbers per tick, moves the player the same
 * distance", which is what `walks the same distance however the commands are
 * spaced` asserts.
 */

/**
 * A world with a lake, a resource patch and ground everywhere else.
 *
 * ```text
 *   water   x 10..11, all y
 *   iron    x 3..4, y 0..1, 5 units per tile
 *   grass   everywhere else
 * ```
 *
 * The patch is deliberately shallow: five units is five minutes of mining at
 * the real rate, which is long enough to be a rate and short enough that a
 * depletion test does not have to run 150,000 ticks.
 */
const PATCH_AMOUNT = 5;

function testWorld(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = cx * CHUNK_SIZE + lx;
        const y = cy * CHUNK_SIZE + ly;
        const index = localIndex(lx, ly);
        if (x >= 10 && x < 12) {
          chunk.terrain[index] = TileType.Water;
        } else if (x >= 3 && x < 5 && y >= 0 && y < 2) {
          chunk.resource[index] = ResourceType.Iron;
          chunk.resourceAmount[index] = PATCH_AMOUNT;
        }
      }
    }
    return chunk;
  });
}

function makeGame(startX = 0, startY = 0): Simulation {
  const simulation = new Simulation({ world: testWorld() });
  simulation.player.setTilePosition(startX, startY);
  return simulation;
}

function run(simulation: Simulation, ticks: number, commands: readonly Command[] = []): void {
  for (const command of commands) simulation.commands.enqueue(command);
  for (let i = 0; i < ticks; i++) simulation.tick();
}

const IRON_ORE = 'iron_ore';

/* -------------------------------------------------------------------------- *
 * Movement
 * -------------------------------------------------------------------------- */

describe('walking', () => {
  it('moves exactly one step per tick, in the held direction', () => {
    const simulation = makeGame(0, 0);
    const startX = simulation.player.subX;

    run(simulation, 10, [{ type: 'movePlayer', dx: 1, dy: 0 }]);

    expect(simulation.player.subX - startX).toBe(10 * PLAYER_STEP_SUBTILES);
    expect(simulation.player.subY).toBe(tileCentreSubtile(0));
  });

  it('keeps walking without being told again, and stops when it is', () => {
    const simulation = makeGame(0, 0);

    run(simulation, 30, [{ type: 'movePlayer', dx: 0, dy: 1 }]);
    const afterWalk = simulation.player.subY;
    expect(afterWalk - tileCentreSubtile(0)).toBe(30 * PLAYER_STEP_SUBTILES);

    run(simulation, 30, [{ type: 'movePlayer', dx: 0, dy: 0 }]);
    expect(simulation.player.subY).toBe(afterWalk);
  });

  /**
   * Acceptance 4, stated as arithmetic rather than as frames. A 144 Hz browser
   * enqueues the same direction about five times per tick and a 20 Hz one
   * enqueues it on only two ticks in three; neither may change how far the
   * player gets, because it is the tick that moves them.
   */
  it('walks the same distance however the commands are spaced', () => {
    const ticks = 90;
    const distances = [1, 5, 0].map((commandsPerTick) => {
      const simulation = makeGame(0, 0);
      // South, because it is open ground: the lake at x 10 would stop the walk
      // after nine tiles and turn a speed test into a collision test.
      simulation.commands.enqueue({ type: 'movePlayer', dx: 0, dy: 1 });
      for (let tick = 0; tick < ticks; tick++) {
        for (let i = 0; i < commandsPerTick; i++) {
          simulation.commands.enqueue({ type: 'movePlayer', dx: 0, dy: 1 });
        }
        simulation.tick();
      }
      return simulation.player.subY - tileCentreSubtile(0);
    });

    expect(distances[0]).toBe(ticks * PLAYER_STEP_SUBTILES);
    expect(new Set(distances).size).toBe(1);
  });

  it('does not walk 1.41 times as fast on the diagonal', () => {
    const straight = makeGame(0, 0);
    run(straight, 60, [{ type: 'movePlayer', dx: 1, dy: 0 }]);
    const straightDistance = straight.player.subX - tileCentreSubtile(0);

    const diagonal = makeGame(0, 0);
    run(diagonal, 60, [{ type: 'movePlayer', dx: 1, dy: 1 }]);
    const dx = diagonal.player.subX - tileCentreSubtile(0);
    const dy = diagonal.player.subY - tileCentreSubtile(0);

    expect(Math.hypot(dx, dy) / straightDistance).toBeCloseTo(1, 1);
  });

  it('is blocked by water and keeps its feet dry', () => {
    const simulation = makeGame(0, 0);
    run(simulation, 600, [{ type: 'movePlayer', dx: 1, dy: 0 }]);

    // Six hundred ticks is eighty tiles of walking at the shipped speed: far
    // past the lake at x 10, so the only thing that can have stopped them is
    // the lake.
    expect(subtileToTile(simulation.player.subX)).toBeLessThan(10);
    expect(simulation.world.getTile(simulation.player.tileX, simulation.player.tileY)).not.toBe(TileType.Water);
  });

  it('is blocked by every tile of a multi-tile footprint, not only its anchor', () => {
    const simulation = makeGame(0, 4);
    simulation.inventory.add('miner', 1);
    // A 2x2 miner over the iron at x 3..4, y 0..1. The player walks north up
    // the x = 4 column, which is the miner's *second* tile.
    run(simulation, 1, [{ type: 'build', buildingId: 'miner', x: 3, y: 0, rotation: NORTH }]);
    expect(simulation.entities.at(4, 1)).toBeDefined();

    simulation.player.setTilePosition(4, 4);
    run(simulation, 300, [{ type: 'movePlayer', dx: 0, dy: -1 }]);

    expect(simulation.player.tileY).toBeGreaterThan(1);
  });

  it('slides along a wall instead of stopping dead against it', () => {
    const simulation = makeGame(8, 0);
    // Walking north-east into the lake: the east component is refused every
    // tick and the north one is not, so the player travels north.
    run(simulation, 120, [{ type: 'movePlayer', dx: 1, dy: -1 }]);

    expect(simulation.player.tileX).toBeLessThan(10);
    expect(simulation.player.subY).toBeLessThan(tileCentreSubtile(0));
  });

  it('generates the world it walks into rather than falling off the edge', () => {
    const simulation = makeGame(0, 0);
    const before = simulation.world.chunkCount;

    run(simulation, 400, [{ type: 'movePlayer', dx: 0, dy: 1 }]);

    expect(simulation.world.chunkCount).toBeGreaterThan(before);
    expect(simulation.player.tileY).toBeGreaterThan(CHUNK_SIZE);
  });

  it('faces the way it is walking', () => {
    const simulation = makeGame(0, 0);
    run(simulation, 1, [{ type: 'movePlayer', dx: 0, dy: 1 }]);
    expect(simulation.player.facing).toBe(2);
    run(simulation, 1, [{ type: 'movePlayer', dx: -1, dy: 0 }]);
    expect(simulation.player.facing).toBe(3);
  });
});

/* -------------------------------------------------------------------------- *
 * Mining
 * -------------------------------------------------------------------------- */

describe('manual mining', () => {
  const ironId = (simulation: Simulation): number => simulation.items.idOf(IRON_ORE);

  it('yields one item every 60 ticks, which is §15 rate of 0.5 items per second', () => {
    const simulation = makeGame(3, 2);
    const iron = ironId(simulation);

    run(simulation, MINE_TICKS_PER_ITEM - 1, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.player.inventory.count(iron)).toBe(0);

    run(simulation, 1);
    expect(simulation.player.inventory.count(iron)).toBe(1);

    run(simulation, MINE_TICKS_PER_ITEM * 3);
    expect(simulation.player.inventory.count(iron)).toBe(4);
  });

  it('takes the ore out of the world, one unit at a time', () => {
    const simulation = makeGame(3, 2);

    run(simulation, MINE_TICKS_PER_ITEM * 2, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.world.getResourceAmount(3, 1)).toBe(PATCH_AMOUNT - 2);
  });

  it('stops when the tile runs out, and reports the tile as no longer mineable', () => {
    const simulation = makeGame(3, 2);
    const iron = ironId(simulation);

    run(simulation, MINE_TICKS_PER_ITEM * (PATCH_AMOUNT + 3), [{ type: 'mineTile', x: 3, y: 1 }]);

    expect(simulation.player.inventory.count(iron)).toBe(PATCH_AMOUNT);
    expect(simulation.world.getResourceAmount(3, 1)).toBe(0);
    expect(simulation.player.miningTarget).toBeNull();

    // And it cannot be restarted: C09's rule is that a mineable tile is one
    // with something left on it, whatever type it still says it is.
    run(simulation, 1, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['no_resource']);
  });

  it('keeps mining past a stack boundary, because slots hold stacks and not items', () => {
    const simulation = new Simulation({ world: testWorld() });
    // A one-slot bag: a single stack of iron ore fills it completely.
    const stack = simulation.items.get(IRON_ORE).stackSize;
    simulation.player.inventory.add(simulation.items.idOf(IRON_ORE), stack - 1);
    simulation.player.setTilePosition(3, 2);

    run(simulation, MINE_TICKS_PER_ITEM * 3, [{ type: 'mineTile', x: 3, y: 1 }]);

    // The bag has thirty slots, so filling one changes nothing: this is the
    // control for the two cases below, which fill every slot there is.
    expect(simulation.player.inventory.count(simulation.items.idOf(IRON_ORE))).toBe(stack + 2);
  });

  it('refuses to start mining into a bag with no room for that item', () => {
    const simulation = new Simulation({ world: testWorld() });
    const iron = simulation.items.idOf(IRON_ORE);
    simulation.player.setTilePosition(3, 2);

    // Fill every slot.
    const capacity = simulation.player.inventory.spaceFor(iron);
    expect(simulation.player.inventory.add(iron, capacity)).toBe(capacity);
    expect(simulation.player.inventory.spaceFor(iron)).toBe(0);

    run(simulation, 1, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['inventory_full']);
    expect(simulation.player.miningTarget).toBeNull();
  });

  it('stops mid-lump when the bag fills up, and takes nothing from the world', () => {
    const simulation = new Simulation({ world: testWorld() });
    const iron = simulation.items.idOf(IRON_ORE);
    simulation.player.setTilePosition(3, 2);
    simulation.player.inventory.add(iron, simulation.player.inventory.spaceFor(iron) - 1);

    // One item fits: the first lump lands, and the second stops before it can
    // take anything out of the world.
    const before = simulation.world.getResourceAmount(3, 1);
    run(simulation, MINE_TICKS_PER_ITEM * 3, [{ type: 'mineTile', x: 3, y: 1 }]);

    expect(simulation.player.inventory.spaceFor(iron)).toBe(0);
    expect(simulation.world.getResourceAmount(3, 1)).toBe(before - 1);
    expect(simulation.player.miningTarget).toBeNull();
  });

  it('refuses a tile out of reach, and says so in a way a player can act on', () => {
    const simulation = makeGame(0, 0);
    run(simulation, 1, [{ type: 'mineTile', x: 3 + MINE_RANGE_TILES, y: 0 }]);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['out_of_reach']);
  });

  it('stops when the player walks out of reach of what they were mining', () => {
    const simulation = makeGame(3, 2);
    run(simulation, 10, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.player.miningTarget).toEqual({ x: 3, y: 1 });

    run(simulation, 300, [{ type: 'movePlayer', dx: 0, dy: 1 }]);
    expect(simulation.player.miningTarget).toBeNull();
  });

  it('retargets and restarts progress when the drag crosses onto a new tile', () => {
    const simulation = makeGame(3, 2);
    run(simulation, 30, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.player.miningTicks).toBe(30);

    run(simulation, 1, [{ type: 'mineTile', x: 4, y: 1 }]);
    expect(simulation.player.miningTarget).toEqual({ x: 4, y: 1 });
    expect(simulation.player.miningTicks).toBe(1);
  });

  it('stops on command, and stopping when idle is not an error', () => {
    const simulation = makeGame(3, 2);
    run(simulation, 30, [{ type: 'mineTile', x: 3, y: 1 }]);

    run(simulation, 1, [{ type: 'stopMining' }]);
    expect(simulation.player.miningTarget).toBeNull();

    run(simulation, 1, [{ type: 'stopMining' }]);
    expect(simulation.commands.takeRejections()).toEqual([]);
  });

  it('mines nothing from bare ground', () => {
    const simulation = makeGame(0, 6);
    run(simulation, 1, [{ type: 'mineTile', x: 0, y: 6 }]);
    expect(simulation.commands.takeRejections().map((r) => r.reason)).toEqual(['no_resource']);
  });

  it('faces the tile it is mining', () => {
    const simulation = makeGame(3, 4);
    run(simulation, 1, [{ type: 'mineTile', x: 3, y: 1 }]);
    expect(simulation.player.facing).toBe(0);
  });
});

/* -------------------------------------------------------------------------- *
 * The view the UI and the renderer see
 * -------------------------------------------------------------------------- */

describe('the player as a position', () => {
  it('reports a fractional tile position between tiles', () => {
    const simulation = makeGame(0, 0);
    run(simulation, 1, [{ type: 'movePlayer', dx: 1, dy: 0 }]);

    const expected = (tileCentreSubtile(0) + PLAYER_STEP_SUBTILES) / SUBTILES_PER_TILE;
    expect(simulation.player.x).toBeCloseTo(expected, 10);
    expect(Number.isInteger(simulation.player.x)).toBe(false);
  });
});
