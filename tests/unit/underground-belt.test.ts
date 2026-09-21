import { describe, expect, it } from 'vitest';

import {
  BELT_SLOT_SPACING,
  BELT_TILE_UNITS,
  laneAccept,
  type BeltEntity,
} from '../../src/game/entities/belt-entity.js';
import { asChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { NO_ENTITY } from '../../src/game/entities/entity.js';
import {
  asUnderground,
  isUndergroundEntrance,
  undergroundLaneUnits,
  undergroundStep,
  type UndergroundBeltEntity,
} from '../../src/game/entities/underground-belt-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { EAST, NORTH, SOUTH, WEST , type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';

/**
 * Underground belts. See ironflow.md §9 and C23 task 2.
 *
 * The chunk's two named tests, and what they are really about:
 *
 * 1. **span validation** — a mouth laid in line with an unfinished run and out
 *    of its reach is *refused*, with a reason; a mouth laid anywhere else is
 *    an entrance waiting for its exit and is always fine.
 * 2. **item transit determinism** — an item takes exactly as long to cross a
 *    buried run as it would to cross the same distance of surface belt, every
 *    time, and the two ends of the run are the only places it is visible.
 *
 * The second is the one worth being careful about, because getting it wrong is
 * invisible: a tunnel that is one tile faster than the belt beside it turns
 * burying a line into a throughput upgrade, and the only way anyone would find
 * out is by measuring two lines against each other in a finished factory.
 */

/** Grass everywhere, nothing on it. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

/**
 * A simulation with the player standing on the spot and holding a stack of
 * everything, so `build` commands are judged on placement rules alone.
 *
 * Research is *granted* rather than worked around: the underground belt is
 * behind `logistics_1`, and a fixture that opened every lock would be testing
 * a game the player never plays.
 */
function newGame(): Simulation {
  const simulation = new Simulation({ world: flatWorld() });
  simulation.researchSystem.grant('logistics_1');
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 50);
  return simulation;
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/** Put the player on a tile, so build reach is never what a test measures. */
function stand(simulation: Simulation, x: number, y: number): void {
  simulation.player.setTilePosition(x, y);
}

function build(simulation: Simulation, id: string, x: number, y: number, rotation: Rotation = EAST): string | null {
  stand(simulation, x, y);
  simulation.commands.takeRejections();
  simulation.commands.enqueue({ type: 'build', buildingId: id, x, y, rotation });
  simulation.tick();
  return simulation.commands.takeRejections()[0]?.reason ?? null;
}

function mouthAt(simulation: Simulation, x: number, y: number): UndergroundBeltEntity {
  const entity = simulation.entities.at(x, y);
  expect(entity, `nothing at ${x},${y}`).toBeDefined();
  const mouth = entity === undefined ? null : asUnderground(entity, simulation.buildings);
  expect(mouth, `${x},${y} is not an underground belt`).not.toBeNull();
  return mouth as UndergroundBeltEntity;
}

describe('pairing', () => {
  it('leaves the first mouth alone and links the second behind it', () => {
    const simulation = newGame();
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
    const entrance = mouthAt(simulation, 10, 10);
    expect(entrance.link).toBe(NO_ENTITY);
    // A lone mouth is an entrance with a span of zero, which is what makes it
    // an ordinary belt tile until its partner arrives.
    expect(isUndergroundEntrance(entrance, undefined)).toBe(true);
    expect(undergroundLaneUnits(entrance, undefined)).toBe(BELT_TILE_UNITS);

    expect(build(simulation, 'underground_belt', 14, 10, EAST)).toBeNull();
    const exit = mouthAt(simulation, 14, 10);
    expect(entrance.link).toBe(exit.id);
    expect(exit.link).toBe(entrance.id);
    expect(isUndergroundEntrance(entrance, exit)).toBe(true);
    expect(isUndergroundEntrance(exit, entrance)).toBe(false);
    // Four tiles apart covers five tiles of run, which is what the lane holds.
    expect(undergroundLaneUnits(entrance, exit)).toBe(5 * BELT_TILE_UNITS);
  });

  it('refuses a mouth in line with an unfinished run and out of its reach', () => {
    const simulation = newGame();
    const maxSpan = simulation.buildings.get('underground_belt').underground?.maxSpan ?? 0;
    expect(maxSpan).toBe(6);

    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
    // One tile past the span. Nothing is placed and the entrance is untouched,
    // which is the difference between a refusal and a stub.
    expect(build(simulation, 'underground_belt', 10 + maxSpan + 1, 10, EAST)).toBe('span_too_long');
    expect(simulation.entities.at(10 + maxSpan + 1, 10)).toBeUndefined();
    expect(mouthAt(simulation, 10, 10).link).toBe(NO_ENTITY);

    // Exactly the span is the furthest that works.
    expect(build(simulation, 'underground_belt', 10 + maxSpan, 10, EAST)).toBeNull();
    expect(mouthAt(simulation, 10, 10).link).toBe(mouthAt(simulation, 10 + maxSpan, 10).id);
  });

  it('is not refused off the axis, facing another way, or past a finished run', () => {
    const simulation = newGame();
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();

    // One tile to the side: a different run that happens to point the same way.
    expect(build(simulation, 'underground_belt', 18, 11, EAST)).toBeNull();
    expect(mouthAt(simulation, 18, 11).link).toBe(NO_ENTITY);
    expect(undergroundStep(mouthAt(simulation, 10, 10), 18, 11)).toBeNull();

    // In line but facing the other way: it cannot be the far end of this run.
    expect(build(simulation, 'underground_belt', 19, 10, WEST)).toBeNull();
    expect(mouthAt(simulation, 19, 10).link).toBe(NO_ENTITY);

    // A finished run is a wall: the third mouth past a complete pair starts a
    // run of its own rather than stealing the pair's entrance.
    const simulation2 = newGame();
    expect(build(simulation2, 'underground_belt', 10, 10, EAST)).toBeNull();
    expect(build(simulation2, 'underground_belt', 13, 10, EAST)).toBeNull();
    expect(build(simulation2, 'underground_belt', 15, 10, EAST)).toBeNull();
    expect(mouthAt(simulation2, 10, 10).link).toBe(mouthAt(simulation2, 13, 10).id);
    expect(mouthAt(simulation2, 15, 10).link).toBe(NO_ENTITY);
  });

  it('is refused outright until logistics_1 is researched', () => {
    const simulation = new Simulation({ world: flatWorld() });
    for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 50);
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBe('locked');

    simulation.researchSystem.grant('logistics_1');
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
  });
});

describe('transit', () => {
  /**
   * The same distance of surface belt and of buried run, fed the same item on
   * the same tick, arriving in the same chest.
   *
   * This is C23's "item transit determinism" and the reason it is a comparison
   * rather than a tick count: the number of ticks is a consequence of §9's
   * fixed-point arithmetic and would have to be recomputed here if the belt
   * speed ever changed. What must never change is that the two are *equal*.
   */
  it('takes exactly as long as the surface belt it replaces', () => {
    const span = 4;
    const surface = newGame();
    const buried = newGame();

    // The feeding tile, the run, and a chest to catch what comes out. Both
    // lines are laid on the same tiles so nothing but the middle differs.
    for (const simulation of [surface, buried]) {
      expect(build(simulation, 'belt', 9, 10, EAST)).toBeNull();
      expect(build(simulation, 'chest', 10 + span + 1, 10, NORTH)).toBeNull();
    }
    for (let x = 10; x <= 10 + span; x++) {
      expect(build(surface, 'belt', x, 10, EAST)).toBeNull();
    }
    expect(build(buried, 'underground_belt', 10, 10, EAST)).toBeNull();
    expect(build(buried, 'underground_belt', 10 + span, 10, EAST)).toBeNull();

    const iron = surface.items.idOf('iron_ore');
    for (const simulation of [surface, buried]) {
      const feed = simulation.entities.at(9, 10) as BeltEntity;
      expect(laneAccept(feed.items, iron, 0)).toBe(true);
    }

    const arrival = (simulation: Simulation): number => {
      for (let tick = 1; tick <= 500; tick++) {
        simulation.tick();
        const chest = asChest(simulation.entities.at(10 + span + 1, 10) as ChestEntity);
        if (chest !== null && chest.contents.length > 0) return tick;
      }
      return -1;
    };

    const surfaceTicks = arrival(surface);
    expect(surfaceTicks).toBeGreaterThan(0);
    expect(arrival(buried)).toBe(surfaceTicks);
  });

  it('holds a belt’s worth of items and no more', () => {
    const simulation = newGame();
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
    expect(build(simulation, 'underground_belt', 13, 10, EAST)).toBeNull();

    const entrance = mouthAt(simulation, 10, 10);
    const iron = simulation.items.idOf('iron_ore');
    // Four tiles of run at §9's four slots a tile. The seventeenth is refused
    // by the same spacing rule a belt tile uses, because it is the same rule.
    const laneUnits = undergroundLaneUnits(entrance, simulation.entities.get(entrance.link));
    expect(laneUnits).toBe(4 * BELT_TILE_UNITS);
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      if (laneAccept(entrance.items, iron, laneUnits - 1 - i * BELT_SLOT_SPACING, laneUnits - 1)) accepted += 1;
    }
    expect(accepted).toBe(16);
  });

  it('will not take an item into its far end', () => {
    const simulation = newGame();
    // A run facing east, with a belt running east into the *exit*. The exit's
    // back is underground, so the belt has nowhere to put anything and backs up.
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
    expect(build(simulation, 'underground_belt', 14, 10, EAST)).toBeNull();
    expect(build(simulation, 'belt', 13, 9, SOUTH)).toBeNull();

    const feed = simulation.entities.at(13, 9) as BeltEntity;
    const iron = simulation.items.idOf('iron_ore');
    expect(laneAccept(feed.items, iron, 0)).toBe(true);

    run(simulation, 120);
    expect(feed.items).toHaveLength(1);
    expect(mouthAt(simulation, 14, 10).items).toHaveLength(0);
    expect(mouthAt(simulation, 10, 10).items).toHaveLength(0);
  });

  it('keeps carrying as a one-tile belt when its far end is demolished', () => {
    const simulation = newGame();
    expect(build(simulation, 'underground_belt', 10, 10, EAST)).toBeNull();
    expect(build(simulation, 'underground_belt', 14, 10, EAST)).toBeNull();
    expect(build(simulation, 'belt', 11, 10, EAST)).toBeNull();

    const entrance = mouthAt(simulation, 10, 10);
    const iron = simulation.items.idOf('iron_ore');
    // One item just inside the entrance and one already down the tunnel.
    expect(laneAccept(entrance.items, iron, BELT_TILE_UNITS * 2, BELT_TILE_UNITS * 5 - 1)).toBe(true);
    expect(laneAccept(entrance.items, iron, 10, BELT_TILE_UNITS * 5 - 1)).toBe(true);

    stand(simulation, 14, 10);
    simulation.commands.enqueue({ type: 'remove', x: 14, y: 10 });
    simulation.tick();

    // The tunnel collapsed: what was under the ground went with it, and what
    // was still on the entrance's own tile stayed. The survivor is a lone
    // mouth again, so it carries on into the belt in front of it.
    expect(entrance.link).toBe(NO_ENTITY);
    expect(entrance.items).toHaveLength(1);
    for (const item of entrance.items) expect(item.pos).toBeLessThan(BELT_TILE_UNITS);

    run(simulation, 60);
    const belt = simulation.entities.at(11, 10) as BeltEntity;
    expect(entrance.items.length + belt.items.length).toBe(1);
  });
});
