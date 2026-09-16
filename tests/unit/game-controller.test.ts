import { describe, expect, it } from 'vitest';

import {
  DetachedCursor,
  GameController,
  HOTBAR_SLOTS,
  type Cursor,
} from '../../src/game/game-controller.js';
import { BUILDINGS } from '../../src/game/data/buildings.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST, NORTH } from '../../src/game/world/coordinates.js';
import { createPlaygroundGenerator } from '../../src/game/world/world-generator.js';
import { World } from '../../src/game/world/world.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The controller. See ironflow.md C07 task 1.
 *
 * The criteria this file carries:
 *
 * - **every returned view is a frozen snapshot** (§13), so a panel that tries
 *   to write to one fails instead of quietly editing the game's idea of itself;
 * - **a rejected command produces exactly one event**, whichever half of §7's
 *   split validation refused it;
 * - the UI can only ever ask — no method here changes authoritative state
 *   except by putting a command in the queue for a tick to judge.
 *
 * It runs in the `sim` project, in a plain Node process with no DOM. That is
 * not incidental: `game-controller.ts` lives under `src/game/`, so if it ever
 * reaches for a browser API this file stops working (§4, §17).
 */

function makeGame(): { game: Game; simulation: Simulation; scheduler: FakeScheduler } {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  const scheduler = new FakeScheduler();
  const game = new Game({ simulation, scheduler, render: () => {} });
  return { game, simulation, scheduler };
}

function stocked(simulation: Simulation, amount = 10): void {
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, amount);
}

describe('GameController views', () => {
  it('freezes every view it hands out, including the arrays inside them', () => {
    const { game, simulation } = makeGame();
    stocked(simulation);
    const controller = new GameController({ game });

    const hud = controller.getHudView();
    expect(Object.isFrozen(hud)).toBe(true);
    expect(Object.isFrozen(hud.items)).toBe(true);
    expect(hud.items.every((item) => Object.isFrozen(item))).toBe(true);

    const menu = controller.getBuildMenuView();
    expect(Object.isFrozen(menu)).toBe(true);
    expect(Object.isFrozen(menu.entries)).toBe(true);
    expect(menu.entries.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.cost))).toBe(true);
  });

  it('reports the tick, the stock and the world as the HUD reads them', () => {
    const { game, simulation } = makeGame();
    simulation.inventory.add('chest', 3);
    const controller = new GameController({ game });

    for (let i = 0; i < 30; i++) simulation.tick();
    const hud = controller.getHudView();

    expect(hud.tick).toBe(30);
    // 30 ticks is exactly one simulated second (§8), by integer division.
    expect(hud.playtimeSeconds).toBe(1);
    expect(hud.itemTotal).toBe(3);
    expect(hud.items).toEqual([{ itemId: 'chest', name: 'Chest', count: 3 }]);
    expect(hud.paused).toBe(false);
  });

  it('prices the build menu against what the player actually holds', () => {
    const { game, simulation } = makeGame();
    simulation.inventory.add('chest', 2);
    const controller = new GameController({ game });

    const entries = controller.getBuildMenuView().entries;
    const chest = entries.find((entry) => entry.buildingId === 'chest');
    const miner = entries.find((entry) => entry.buildingId === 'miner');

    expect(chest?.affordable).toBe(true);
    expect(chest?.cost).toEqual([{ itemId: 'chest', count: 1, held: 2 }]);
    expect(miner?.affordable).toBe(false);
    // Content order is hotbar order, and only the first nine get a key. Taken
    // from the content table rather than written out, so the building C15 adds
    // does not fail an assertion about hotkeys.
    expect(entries.map((entry) => entry.hotkey)).toEqual(
      BUILDINGS.slice(0, HOTBAR_SLOTS).map((_definition, index) => index + 1),
    );
  });

  it('returns null for a building view of something that is not there', () => {
    const { game } = makeGame();
    const controller = new GameController({ game });
    expect(controller.getBuildingView(999)).toBeNull();
  });

  it('describes a placed building for the inspector', () => {
    const { game, simulation } = makeGame();
    stocked(simulation);
    const controller = new GameController({ game });

    controller.dispatch({ type: 'build', buildingId: 'chest', x: 1, y: 1, rotation: NORTH });
    simulation.tick();

    const entity = simulation.entities.at(1, 1);
    const view = controller.getBuildingView(entity?.id ?? 0);
    expect(Object.isFrozen(view)).toBe(true);
    expect(view?.name).toBe('Chest');
    expect(view?.status).toBe('idle');
    // Null rather than zero: a chest is not a machine that is 0% of the way
    // through something, and C12's panel draws no bar and no rate for it.
    expect(view?.progress).toBeNull();
    expect(view?.ratePerMinute).toBeNull();
    expect(view?.outputs).toEqual([]);
  });
});

describe('GameController commands', () => {
  it('queues a command and changes nothing until a tick runs', () => {
    const { game, simulation } = makeGame();
    stocked(simulation);
    const controller = new GameController({ game });

    expect(controller.dispatch({ type: 'build', buildingId: 'chest', x: 2, y: 2, rotation: NORTH })).toEqual({
      queued: true,
    });
    expect(simulation.entities.size).toBe(0);

    simulation.tick();
    expect(simulation.entities.at(2, 2)).toBeDefined();
  });

  it('emits exactly one event per rejected command, with the reason', () => {
    const { game, simulation } = makeGame();
    const controller = new GameController({ game });
    const seen: string[] = [];
    controller.subscribe('rejected', (event) => seen.push(`${event.command.type}:${event.reason}`));

    // Nothing is affordable: the stock is empty.
    controller.dispatch({ type: 'build', buildingId: 'chest', x: 2, y: 2, rotation: NORTH });
    simulation.tick();
    controller.pump();

    expect(seen).toEqual(['build:unaffordable']);
  });

  it('reports a malformed command through the same single event', () => {
    const { game } = makeGame();
    const controller = new GameController({ game });
    const seen: string[] = [];
    controller.subscribe('rejected', (event) => seen.push(event.reason));

    // A fractional tile never reaches the queue (C04 decision 3), and the
    // player must still be told — one rejection, one event, same as any other.
    expect(controller.dispatch({ type: 'remove', x: 1.5, y: 0 })).toEqual({ queued: false });
    controller.pump();

    expect(seen).toEqual(['malformed']);
  });

  it('counts every rejection for the HUD alert tile', () => {
    const { game, simulation } = makeGame();
    const controller = new GameController({ game });

    controller.dispatch({ type: 'build', buildingId: 'chest', x: 2, y: 2, rotation: NORTH });
    controller.dispatch({ type: 'remove', x: 3, y: 3 });
    simulation.tick();
    controller.pump();

    expect(controller.getHudView().alerts).toBe(2);
  });
});

describe('GameController build tool', () => {
  it('resolves a hotbar slot against the content table and toggles on repeat', () => {
    const { game } = makeGame();
    const cursor = new DetachedCursor();
    const controller = new GameController({ game, cursor });

    controller.selectSlot(1);
    expect(controller.getSelectedBuilding()).toBe('miner');
    expect(cursor.buildTool).toEqual({ buildingId: 'miner', rotationCount: 4, lineBuild: false });

    controller.selectSlot(1);
    expect(controller.getSelectedBuilding()).toBeNull();

    // The slot past the last building has nothing behind it, and a slot past
    // the hotbar is not a slot at all. Neither may throw; both empty the hand.
    controller.selectSlot(BUILDINGS.length);
    controller.selectSlot(BUILDINGS.length + 1);
    expect(controller.getSelectedBuilding()).toBeNull();
    controller.selectSlot(HOTBAR_SLOTS + 1);
    expect(controller.getSelectedBuilding()).toBeNull();
  });

  it('reads the cursor live, so a rotation pressed elsewhere shows up at once', () => {
    const { game } = makeGame();
    const cursor = new DetachedCursor();
    const controller = new GameController({ game, cursor });

    controller.selectBuilding('miner');
    expect(controller.getBuildMenuView().rotation).toBe(NORTH);

    cursor.buildRotation = EAST;
    expect(controller.getBuildMenuView().rotation).toBe(EAST);
  });

  it('previews a placement with the simulation own answer, not a guess', () => {
    const { game, simulation } = makeGame();
    stocked(simulation);
    const cursor = new DetachedCursor();
    const controller = new GameController({ game, cursor });

    controller.selectBuilding('miner');
    cursor.buildRotation = EAST;
    cursor.hover = { x: 40, y: 40 };
    // Standing there, so the answer is about the ground rather than about
    // C10's build range — which the preview also asks, and which would
    // otherwise be the first thing wrong with a tile forty tiles away.
    simulation.player.setTilePosition(40, 40);

    const preview = controller.getPlacementView();
    expect(Object.isFrozen(preview)).toBe(true);
    expect(preview?.buildingId).toBe('miner');
    // A 2x2 stays 2x2 through every rotation; the reason is the miner's, and
    // it is the same string the rejection toast would carry.
    expect(preview?.width).toBe(2);
    expect(preview?.valid).toBe(false);
    expect(preview?.reason).toBe('no_resource');
  });

  it('shows nothing when the hand is empty or the pointer is off the world', () => {
    const { game } = makeGame();
    const cursor = new DetachedCursor();
    const controller = new GameController({ game, cursor });

    cursor.hover = { x: 0, y: 0 };
    expect(controller.getPlacementView()).toBeNull();

    controller.selectBuilding('chest');
    cursor.hover = null;
    expect(controller.getPlacementView()).toBeNull();
  });
});

describe('GameController events', () => {
  it('announces a build-menu change once, when something behind it moved', () => {
    const { game, simulation } = makeGame();
    const controller = new GameController({ game });
    let changes = 0;
    controller.subscribe('buildMenuChanged', () => (changes += 1));

    controller.pump();
    expect(changes).toBe(0);

    simulation.inventory.add('chest', 1);
    controller.pump();
    expect(changes).toBe(1);

    // Nothing moved: no second event, which is what "on change event only"
    // (§13) has to mean if the panel is not to repaint every frame.
    controller.pump();
    expect(changes).toBe(1);
  });

  it('treats selecting a building as a build-menu change', () => {
    const { game } = makeGame();
    const controller = new GameController({ game });
    let changes = 0;
    controller.subscribe('buildMenuChanged', () => (changes += 1));

    controller.selectSlot(1);
    controller.pump();
    expect(changes).toBe(1);
  });

  it('stops calling a listener that unsubscribed', () => {
    const { game, simulation } = makeGame();
    const controller = new GameController({ game });
    let calls = 0;
    const off = controller.subscribe('buildMenuChanged', () => (calls += 1));

    simulation.inventory.add('chest', 1);
    controller.pump();
    off();
    simulation.inventory.add('chest', 1);
    controller.pump();

    expect(calls).toBe(1);
  });
});

describe('GameController pause', () => {
  it('stops the simulation without stopping the frames', () => {
    const { simulation, scheduler } = makeGame();
    let frames = 0;
    // A second `Game` over the same simulation, so the render callback can be
    // counted. `makeGame`'s own loop is never started.
    const paused = new Game({ simulation, scheduler, render: () => (frames += 1) });
    const controller = new GameController({ game: paused });

    paused.start();
    scheduler.runFrames(6, 33_333);
    const ticksWhileRunning = simulation.getTick();
    expect(ticksWhileRunning).toBeGreaterThan(0);

    controller.setPaused(true);
    scheduler.runFrames(30, 33_333);

    expect(simulation.getTick()).toBe(ticksWhileRunning);
    // Still drawing: a paused game is one you can still look around.
    expect(frames).toBeGreaterThan(6);
  });

  it('runs no catch-up ticks when it resumes, however long the pause was', () => {
    const { simulation, scheduler } = makeGame();
    const game = new Game({ simulation, scheduler, render: () => {} });
    const controller = new GameController({ game });

    game.start();
    // 40 ms is comfortably more than one tick's 33.33 ms, so each frame here
    // owes exactly one tick and the arithmetic below is not about rounding.
    scheduler.runFrame(40_000);
    controller.setPaused(true);
    // Ten seconds of paused frames, which would be 300 ticks of debt if the
    // clock were still counting.
    scheduler.runFrames(10, 1_000_000);
    const held = simulation.getTick();

    controller.setPaused(false);
    scheduler.runFrame(40_000);

    expect(held).toBe(1);
    expect(simulation.getTick()).toBe(2);
  });

  it('emits pauseChanged once per real change', () => {
    const { game } = makeGame();
    const controller = new GameController({ game });
    const states: boolean[] = [];
    controller.subscribe('pauseChanged', (event) => states.push(event.paused));

    controller.togglePause();
    controller.setPaused(true);
    controller.togglePause();

    expect(states).toEqual([true, false]);
  });
});

describe('the cursor interface', () => {
  it('is satisfied by anything with the four members, and nothing more', () => {
    // The shape `InputManager` already had before C07 existed. Written out
    // here because that assignability is what keeps §4 intact: the UI sees
    // what the player is holding without `ui/**` ever importing `input/**`.
    const cursor: Cursor = new DetachedCursor();
    const { game } = makeGame();
    const controller = new GameController({ game, cursor });

    controller.selectBuilding('chest');
    expect(cursor.buildTool?.buildingId).toBe('chest');
    expect(cursor.buildRotation).toBe(NORTH);
  });
});
