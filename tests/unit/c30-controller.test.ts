import { describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { GAME_SPEEDS, Game } from '../../src/game/game.js';
import { GameLoop } from '../../src/game/game-loop.js';
import { SimulationClock, MAX_STEPS_PER_FRAME } from '../../src/game/simulation-clock.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST, NORTH, SOUTH, WEST, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { OBJECTIVES, objectivesView } from '../../src/ui/objectives.js';
import { TONE_ICONS } from '../../src/ui/icons.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * C30's game-side pieces, in the `sim` project because all of them live under
 * `src/game/` (or, for the objectives table and the icon table, are plain data
 * that must not need a DOM to be checked).
 *
 * - the keyboard's target: the tile in front of the player, and a held
 *   building's footprint placed wholly in front of them;
 * - the three questions an objective can ask, answered from world state;
 * - the speed control: more ticks per real second, and nothing else changed.
 */

function makeController(): { controller: GameController; simulation: Simulation; cursor: DetachedCursor; game: Game } {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, 10);
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  const controller = new GameController({ game, cursor });
  return { controller, simulation, cursor, game };
}

function face(simulation: Simulation, x: number, y: number, facing: Rotation): void {
  simulation.player.setTilePosition(x, y);
  simulation.player.facing = facing;
}

describe('the keyboard target (C30 task 3)', () => {
  it('is the tile in front of the player, whichever way they face', () => {
    const { controller, simulation } = makeController();
    const cases: [Rotation, number, number][] = [
      [NORTH, 4, 3],
      [EAST, 5, 4],
      [SOUTH, 4, 5],
      [WEST, 3, 4],
    ];
    for (const [facing, x, y] of cases) {
      face(simulation, 4, 4, facing);
      expect(controller.getFacingTarget()?.tile).toEqual({ x, y });
    }
  });

  it('names the building standing there, so Enter opens it', () => {
    const { controller, simulation } = makeController();
    face(simulation, 4, 4, EAST);
    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 5, y: 4, rotation: NORTH });
    simulation.tick();
    const chest = simulation.entities.at(5, 4);
    expect(chest).toBeDefined();
    expect(controller.getFacingTarget()?.entityId).toBe(chest?.id);
  });

  it('puts a held building wholly in front of the player, never over them', () => {
    const { controller, simulation, cursor } = makeController();
    const size = simulation.buildings.get('assembler').size;
    expect(size.width).toBeGreaterThan(1);
    cursor.setBuildTool({ buildingId: 'assembler', rotationCount: 1, lineBuild: false });

    for (const facing of [NORTH, EAST, SOUTH, WEST] as const) {
      face(simulation, 10, 10, facing);
      const tile = controller.getFacingTarget()?.tile;
      expect(tile).toBeDefined();
      if (tile === undefined) continue;
      const covers =
        10 >= tile.x && 10 < tile.x + size.width && 10 >= tile.y && 10 < tile.y + size.height;
      expect(covers, `facing ${facing}`).toBe(false);
      // …and touching the front tile, so it is the one the player is looking at.
      const front = { [NORTH]: [10, 9], [EAST]: [11, 10], [SOUTH]: [10, 11], [WEST]: [9, 10] }[facing];
      const [fx = 0, fy = 0] = front;
      expect(fx >= tile.x && fx < tile.x + size.width && fy >= tile.y && fy < tile.y + size.height).toBe(true);
    }
  });
});

describe('objective counts (C30 task 4)', () => {
  it('counts what is carried, what is built and what is stored', () => {
    const { controller, simulation } = makeController();
    face(simulation, 4, 4, EAST);
    simulation.inventory.add('iron_ore', 12);
    simulation.commands.enqueue({ type: 'build', buildingId: 'chest', x: 5, y: 4, rotation: NORTH });
    simulation.tick();

    expect(controller.countObjective({ kind: 'carried', itemId: 'iron_ore' })).toBe(12);
    expect(controller.countObjective({ kind: 'built', buildingId: 'chest' })).toBe(1);
    expect(controller.countObjective({ kind: 'stored', itemId: 'iron_plate' })).toBe(0);

    simulation.inventory.add('iron_plate', 3);
    const chest = simulation.entities.at(5, 4);
    if (chest === undefined) throw new Error('no chest');
    simulation.commands.enqueue({ type: 'insertItems', entityId: chest.id, itemId: 'iron_plate', amount: 3 });
    simulation.tick();
    expect(controller.countObjective({ kind: 'stored', itemId: 'iron_plate' })).toBe(3);
  });

  it('counts nothing, rather than throwing, for an id content does not have', () => {
    const { controller } = makeController();
    expect(controller.countObjective({ kind: 'carried', itemId: 'unobtainium' })).toBe(0);
    expect(controller.countObjective({ kind: 'built', buildingId: 'castle' })).toBe(0);
    expect(controller.countObjective({ kind: 'stored', itemId: 'unobtainium' })).toBe(0);
  });

  it('latches: a line once done stays done when the count falls back', () => {
    const done = new Set<string>();
    let ore = 20;
    const count = (): number => ore;
    const first = objectivesView(OBJECTIVES.slice(0, 1), done, count);
    expect(first.lines[0]?.done).toBe(true);
    for (const line of first.lines) if (line.done) done.add(line.id);

    ore = 3;
    const later = objectivesView(OBJECTIVES.slice(0, 1), done, count);
    expect(later.lines[0]).toMatchObject({ done: true, progress: OBJECTIVES[0]?.target });
    expect(later.finished).toBe(true);
  });

  it('hints at the first line not done, in any order the player does them', () => {
    const view = objectivesView(OBJECTIVES, new Set(['mine-iron', 'place-furnace']), () => 0);
    expect(view.hint).toBe(OBJECTIVES[1]?.hint);
    expect(view.current).toBe(1);
    expect(view.doneCount).toBe(2);
    expect(view.finished).toBe(false);
  });
});

describe('the speed control (C30 task 5)', () => {
  it('runs speed times the ticks over the same real time', () => {
    for (const speed of GAME_SPEEDS) {
      const clock = new SimulationClock();
      clock.setSpeed(speed);
      clock.reset(0);
      let ticks = 0;
      for (let frame = 1; frame <= 60; frame++) ticks += clock.advance(frame * 16_667).steps;
      expect(ticks, `${speed}x`).toBe(30 * speed);
    }
  });

  it('scales the per-frame step cap with it, so 8x is not quietly 5 ticks a frame', () => {
    const clock = new SimulationClock();
    clock.setSpeed(8);
    clock.reset(0);
    // A 100 ms frame at 8x owes 24 ticks: far over the 1x cap of 5, and under
    // the scaled one of 40.
    expect(clock.advance(100_000).steps).toBe(24);
    expect(24).toBeGreaterThan(MAX_STEPS_PER_FRAME);
    // The spiral-of-death guard still exists, scaled: 200 ms is 48 owed, 40 run.
    const stalled = clock.advance(300_000);
    expect(stalled.steps).toBe(MAX_STEPS_PER_FRAME * 8);
    expect(stalled.shed).toBe(true);
  });

  it('refuses a speed that would break the integer accumulator', () => {
    const clock = new SimulationClock();
    expect(() => clock.setSpeed(1.5)).toThrow(RangeError);
    expect(() => clock.setSpeed(0)).toThrow(RangeError);
  });

  it('steps through GAME_SPEEDS and stops at either end, and the HUD says so', () => {
    const { controller } = makeController();
    expect(controller.getSpeed()).toBe(1);
    expect(controller.stepSpeed(-1)).toBe(1);
    const seen = GAME_SPEEDS.slice(1).map(() => controller.stepSpeed(1));
    expect(seen).toEqual(GAME_SPEEDS.slice(1));
    expect(controller.stepSpeed(1)).toBe(GAME_SPEEDS.at(-1));
    expect(controller.getHudView().speed).toBe(GAME_SPEEDS.at(-1));
  });

  it('changes when ticks happen, never what they do: 2x for N frames is 1x for 2N', () => {
    const run = (speed: number, frames: number): Simulation => {
      const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
      simulation.inventory.add('iron_ore', 5);
      const scheduler = new FakeScheduler();
      const loop = new GameLoop(scheduler, { tick: () => simulation.tick(), render: () => {} });
      loop.setSpeed(speed);
      loop.start();
      scheduler.runFrames(frames, 16_667);
      return simulation;
    };
    expect(run(2, 90).getTick()).toBe(run(1, 180).getTick());
  });
});

describe('status shapes (C30: distinguishable in greyscale)', () => {
  it('gives every status tone a different icon', () => {
    const icons = Object.values(TONE_ICONS);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
