import { describe, expect, it } from 'vitest';

import { asRadar, type RadarEntity } from '../../src/game/entities/radar-entity.js';
import { machineStatusName } from '../../src/game/entities/machine-status.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { PLAYER_REVEAL_CHUNKS } from '../../src/game/systems/exploration-system.js';
import { CHUNK_SIZE, chunkKey, toChunkCoord } from '../../src/game/world/chunk.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { ExploredChunks, unpackChunkKey } from '../../src/game/world/explored.js';
import { NORTH , type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * Exploration, radars, and the explored set. See ironflow.md C23 tasks 3 and 5.
 *
 * The chunk's named tests are "explored-set persistence" and "radar reveal
 * radius", and both are really one question: **is the map a fact about the
 * world, or a fact about what happens to be drawn?** §10 puts the explored set
 * in the authoritative column precisely because nothing else records it — a
 * world chunk the player crossed and one they never approached are
 * byte-identical — so if it does not survive a round trip it is not there.
 */

function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

function newGame(): Simulation {
  const simulation = new Simulation({ world: flatWorld() });
  simulation.researchSystem.grant('exploration_1');
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 50);
  return simulation;
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

function build(simulation: Simulation, id: string, x: number, y: number, rotation: Rotation = NORTH): string | null {
  simulation.player.setTilePosition(x, y);
  simulation.commands.takeRejections();
  simulation.commands.enqueue({ type: 'build', buildingId: id, x, y, rotation });
  simulation.tick();
  return simulation.commands.takeRejections()[0]?.reason ?? null;
}

/** A radar with a pole and a generator beside it, fuelled and running. */
function poweredRadar(simulation: Simulation, x: number, y: number): RadarEntity {
  expect(build(simulation, 'generator', x + 4, y, NORTH)).toBeNull();
  expect(build(simulation, 'power_pole', x + 3, y, NORTH)).toBeNull();
  expect(build(simulation, 'radar', x, y, NORTH)).toBeNull();

  const generator = simulation.entities.at(x + 4, y);
  expect(generator).toBeDefined();
  if (generator !== undefined) {
    simulation.player.inventory.add(simulation.items.idOf('coal'), 50);
    simulation.commands.enqueue({
      type: 'insertItems',
      entityId: generator.id,
      itemId: 'coal',
      amount: 50,
    });
    simulation.tick();
  }

  const entity = simulation.entities.at(x, y);
  const radar = entity === undefined ? null : asRadar(entity, simulation.buildings);
  expect(radar).not.toBeNull();
  return radar as RadarEntity;
}

describe('ExploredChunks', () => {
  it('records world chunks, not tiles, and knows its own bounds', () => {
    const explored = new ExploredChunks();
    expect(explored.size).toBe(0);
    expect(explored.bounds().maxCx).toBeLessThan(explored.bounds().minCx);

    expect(explored.reveal(2, -3)).toBe(true);
    // Idempotent: revealing the same ground twice is how a radar refreshes.
    expect(explored.reveal(2, -3)).toBe(false);
    expect(explored.has(2, -3)).toBe(true);
    expect(explored.hasTile(2 * CHUNK_SIZE + 5, -3 * CHUNK_SIZE + 31)).toBe(true);
    expect(explored.hasTile(0, 0)).toBe(false);

    explored.reveal(-1, 4);
    expect(explored.bounds()).toEqual({ minCx: -1, minCy: -3, maxCx: 2, maxCy: 4 });
  });

  it('reveals a square and hands its keys back in coordinate order', () => {
    const explored = new ExploredChunks();
    expect(explored.revealSquare(0, 0, 1)).toBe(9);
    expect(explored.revealSquare(0, 0, 1)).toBe(0);
    expect(explored.size).toBe(9);

    const keys = explored.keysAscending();
    // §6 R4: ascending by packed key is a coordinate order, so a save and a
    // live session hand out the same sequence however they were filled.
    expect([...keys].sort((a, b) => a - b)).toEqual([...keys]);
    expect(keys.map((key) => unpackChunkKey(key)?.cx)).toContain(-1);
  });

  it('survives the round trip a save will put it through', () => {
    const explored = new ExploredChunks();
    explored.revealSquare(3, -2, 2);
    explored.reveal(40, 40);
    const written = explored.keysAscending();

    const loaded = new ExploredChunks();
    // Deliberately in the wrong order, which is what an edited or re-ordered
    // save file would hand over.
    loaded.restore([...written].reverse());
    expect(loaded.keysAscending()).toEqual(written);
    expect(loaded.bounds()).toEqual(explored.bounds());
    expect(loaded.size).toBe(explored.size);
  });

  it('refuses a key no chunkKey could have produced', () => {
    const explored = new ExploredChunks();
    expect(() => explored.restore([-1])).toThrow(/not a world-chunk key/);
    expect(() => explored.restore([1.5])).toThrow(/not a world-chunk key/);
    expect(unpackChunkKey(chunkKey(7, -7))).toEqual({ cx: 7, cy: -7 });
  });

  it('is empty until something explores, and costs no world chunks to fill', () => {
    const simulation = new Simulation({ world: flatWorld() });
    expect(simulation.world.explored.size).toBe(0);
    const before = simulation.world.chunkCount;

    simulation.world.explored.revealSquare(20, 20, 3);
    // Revealing ground does not generate it — see `explored.ts` on why that is
    // the whole reason the set holds keys rather than a flag on a world chunk.
    expect(simulation.world.chunkCount).toBe(before);
  });
});

describe('the player', () => {
  it('reveals the world chunks around them on the first tick', () => {
    const simulation = new Simulation({ world: flatWorld() });
    simulation.tick();

    const side = 2 * PLAYER_REVEAL_CHUNKS + 1;
    expect(simulation.world.explored.size).toBe(side * side);
    expect(simulation.world.explored.has(0, 0)).toBe(true);
    expect(simulation.world.explored.has(PLAYER_REVEAL_CHUNKS + 1, 0)).toBe(false);
  });

  it('reveals more as they walk, and nothing while they stand still', () => {
    const simulation = new Simulation({ world: flatWorld() });
    simulation.tick();
    const standing = simulation.world.explored.size;
    run(simulation, 60);
    expect(simulation.world.explored.size).toBe(standing);

    // Two world chunks east, which no reveal so far has reached.
    simulation.player.setTilePosition(CHUNK_SIZE * 3, 0);
    simulation.tick();
    expect(simulation.world.explored.size).toBeGreaterThan(standing);
    expect(simulation.world.explored.has(3, 0)).toBe(true);
  });
});

describe('a radar', () => {
  it('reveals one world chunk per sweep step and eventually its whole radius', () => {
    const simulation = newGame();
    const radar = poweredRadar(simulation, 8, 8);
    const config = simulation.buildings.radarFor(radar.type);
    expect(config).not.toBeNull();
    if (config === null) return;

    const before = simulation.world.explored.size;
    // One sweep step. The world chunk it lands on is the north-west corner of
    // the coverage, which is a fact about the cursor's fixed order (§6 R4).
    run(simulation, config.sweepTicks);
    expect(simulation.world.explored.size).toBe(before + 1);
    expect(simulation.world.explored.has(toChunkCoord(8) - config.chunkRadius, toChunkCoord(8) - config.chunkRadius)).toBe(
      true,
    );

    // The whole coverage, and not a world chunk more: C23's acceptance asks
    // for a *documented* radius, so the count is the assertion.
    run(simulation, config.sweepTicks * config.coverage);
    const side = 2 * config.chunkRadius + 1;
    for (let cy = toChunkCoord(8) - config.chunkRadius; cy <= toChunkCoord(8) + config.chunkRadius; cy++) {
      for (let cx = toChunkCoord(8) - config.chunkRadius; cx <= toChunkCoord(8) + config.chunkRadius; cx++) {
        expect(simulation.world.explored.has(cx, cy), `${cx},${cy}`).toBe(true);
      }
    }
    expect(simulation.world.explored.has(toChunkCoord(8) + config.chunkRadius + 1, 0)).toBe(false);
    expect(config.coverage).toBe(side * side);
  });

  it('does nothing without power, and says why', () => {
    const simulation = newGame();
    expect(build(simulation, 'radar', 8, 8, NORTH)).toBeNull();
    const entity = simulation.entities.at(8, 8);
    const radar = entity === undefined ? null : asRadar(entity, simulation.buildings);
    expect(radar).not.toBeNull();
    if (radar === null) return;

    // Standing beside the player's own reveal, so the only thing that could
    // add to the set is the radar.
    simulation.tick();
    const before = simulation.world.explored.size;
    run(simulation, TPS * 5);
    expect(simulation.world.explored.size).toBe(before);
    expect(machineStatusName(radar.status)).toBe('no_power');
    expect(radar.cursor).toBe(0);
  });

  it('is refused until exploration_1 is researched', () => {
    const simulation = new Simulation({ world: flatWorld() });
    for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 50);
    expect(build(simulation, 'radar', 8, 8, NORTH)).toBe('locked');
    simulation.researchSystem.grant('exploration_1');
    expect(build(simulation, 'radar', 8, 8, NORTH)).toBeNull();
  });

  it('keeps sweeping once it is done, which is what a refresh is', () => {
    const simulation = newGame();
    const radar = poweredRadar(simulation, 8, 8);
    const config = simulation.buildings.radarFor(radar.type);
    if (config === null) return;

    run(simulation, config.sweepTicks * (config.coverage + 3));
    // The cursor has wrapped and is going round again, revealing nothing —
    // which costs nothing and is what keeps a finished radar from needing a
    // "finished" state that would have to be explained (pillar 3).
    expect(radar.cursor).toBeLessThan(config.coverage);
    expect(machineStatusName(radar.status)).toBe('running');
  });
});

describe('exploration is phase 9', () => {
  it('reveals where the player ended the tick, not where they started it', () => {
    const simulation = new Simulation({ world: flatWorld() });
    simulation.tick();

    // Walk east for long enough to cross into the next world chunk. The tick
    // that carries the player over the boundary is the tick that reveals it —
    // phase 9 runs after phase 8, so the map never lags the legs.
    simulation.player.setTilePosition(CHUNK_SIZE - 1, 0);
    simulation.commands.enqueue({ type: 'movePlayer', dx: 1, dy: 0 });
    let crossedOn = -1;
    for (let tick = 1; tick <= 200 && crossedOn < 0; tick++) {
      simulation.tick();
      if (toChunkCoord(simulation.player.tileX) === 1) crossedOn = tick;
    }
    expect(crossedOn).toBeGreaterThan(0);
    expect(simulation.world.explored.has(2, 0)).toBe(true);
  });
});
