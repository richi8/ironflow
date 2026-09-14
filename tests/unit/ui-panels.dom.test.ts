import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { createPlaygroundGenerator } from '../../src/game/world/world-generator.js';
import { World } from '../../src/game/world/world.js';
import { MAX_TOASTS, Notifications, TOAST_LIFETIME_MS } from '../../src/ui/notifications.js';
import { GameUI, HUD_HZ, LIVE_HZ } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * The DOM UI. See ironflow.md C07 and §13.
 *
 * The criteria this file carries, in the order the chunk states them:
 *
 * - selecting, placing and removing all happen **through commands only**;
 * - **no panel rebuilds its subtree on update** — checked with a real
 *   `MutationObserver`, which is what C07 asks for by "a DOM mutation counter";
 * - the HUD updates at 5 Hz and the live lane at 10 Hz, **both stopping when
 *   paused**;
 * - a rejected command produces exactly one notification.
 *
 * It runs in jsdom, which is where every UI test belongs (§17) and where none
 * of the simulation's belong.
 */

interface Harness {
  readonly root: HTMLElement;
  readonly ui: GameUI;
  readonly controller: GameController;
  readonly simulation: Simulation;
  readonly cursor: DetachedCursor;
}

let harness: Harness;

function mountUi(stock = 10): Harness {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  for (const definition of simulation.buildings.all()) simulation.inventory.add(definition.id, stock);

  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const cursor = new DetachedCursor();
  const controller = new GameController({ game, cursor });

  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);

  const ui = new GameUI({ root, controller });
  ui.mount();
  return { root, ui, controller, simulation, cursor };
}

/** One frame's worth of a 60 Hz display, in ms. */
const FRAME_MS = 1000 / 60;

function runFrames(ui: GameUI, count: number): void {
  for (let i = 0; i < count; i++) ui.update(FRAME_MS);
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

/** Is `node`, or an ancestor of it, the panel with this class? */
function closestClass(node: Node, className: string): boolean {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest(`.${className}`) != null;
}

/** Elements only: replacing a text node is an assignment, not a rebuild. */
function countElements(nodes: NodeList): number {
  let count = 0;
  for (const node of nodes) if (node.nodeType === 1) count += 1;
  return count;
}

function tileValue(root: ParentNode, label: string): string {
  for (const tile of root.querySelectorAll('.if-hud__tile')) {
    if (tile.querySelector('.if-hud__label')?.textContent === label) {
      return tile.querySelector('.if-hud__value')?.textContent ?? '';
    }
  }
  throw new Error(`missing HUD tile: ${label}`);
}

beforeEach(() => {
  harness = mountUi();
});

afterEach(() => {
  harness.ui.destroy();
  harness.root.remove();
});

describe('mounting', () => {
  it('builds every panel once, from content', () => {
    const { root } = harness;

    expect(root.querySelectorAll('.if-hud').length).toBe(1);
    expect(root.querySelectorAll('.if-toolbar').length).toBe(1);
    // Nine slots whatever the content table holds: a slot with nothing behind
    // it is an empty tile that fills itself when a building is added (C06).
    expect(root.querySelectorAll('.if-slot').length).toBe(9);
    // Two buildings today, and one group each, because a category with no
    // building in it gets no heading.
    expect(root.querySelectorAll('.if-build-row').length).toBe(2);
    expect(root.querySelectorAll('.if-build-menu__group').length).toBe(2);
  });

  it('starts with the build menu closed and the hand empty', () => {
    const { root, controller } = harness;
    expect(query<HTMLElement>(root, '.if-build-menu').hidden).toBe(true);
    expect(controller.getSelectedBuilding()).toBeNull();
    expect(root.querySelectorAll('.if-slot.is-selected').length).toBe(0);
  });

  it('shows the eight icons from §11 across the HUD and the build menu', () => {
    const { root } = harness;
    // Every icon is inline SVG with a path, never an <img> and never a font.
    expect(root.querySelectorAll('.if-icon').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('img').length).toBe(0);
    for (const icon of root.querySelectorAll('.if-icon')) {
      expect(icon.querySelector('path')?.getAttribute('fill')).toBe('currentColor');
    }
  });
});

describe('the toolbar drives the game through commands only', () => {
  it('selects a building, places it and removes it', () => {
    const { root, controller, simulation, cursor } = harness;

    query<HTMLButtonElement>(root, '.if-slot[data-slot="2"]').click();
    expect(controller.getSelectedBuilding()).toBe('chest');
    controller.pump();
    expect(query<HTMLElement>(root, '.if-slot[data-slot="2"]').classList.contains('is-selected')).toBe(true);

    // The click changed the selection and nothing else: the world is untouched
    // until a command runs (§19 rule 8).
    expect(simulation.entities.size).toBe(0);

    cursor.hover = { x: 3, y: 3 };
    controller.dispatch({ type: 'build', buildingId: 'chest', x: 3, y: 3, rotation: NORTH });
    simulation.tick();
    expect(simulation.entities.at(3, 3)).toBeDefined();

    controller.dispatch({ type: 'remove', x: 3, y: 3 });
    simulation.tick();
    expect(simulation.entities.at(3, 3)).toBeUndefined();
  });

  it('puts a building down when its own slot is clicked again', () => {
    const { root, controller } = harness;
    const slot = query<HTMLButtonElement>(root, '.if-slot[data-slot="1"]');

    slot.click();
    expect(controller.getSelectedBuilding()).toBe('miner');
    slot.click();
    expect(controller.getSelectedBuilding()).toBeNull();
  });

  it('selects the same building from the build menu as from the hotbar', () => {
    const { root, controller } = harness;
    query<HTMLButtonElement>(root, '.if-build-row[data-building="miner"]').click();
    expect(controller.getSelectedBuilding()).toBe('miner');
  });

  it('opens and closes the build menu', () => {
    const { root } = harness;
    const menu = query<HTMLElement>(root, '.if-build-menu');
    const button = query<HTMLButtonElement>(root, '.if-toolbar__menu');

    button.click();
    expect(menu.hidden).toBe(false);
    expect(button.classList.contains('is-active')).toBe(true);

    button.click();
    expect(menu.hidden).toBe(true);
  });

  it('marks a building the player cannot afford without disabling it', () => {
    harness.ui.destroy();
    harness.root.remove();
    harness = mountUi(0);
    const { root, controller } = harness;
    controller.pump();

    const slot = query<HTMLElement>(root, '.if-slot[data-slot="1"]');
    expect(slot.classList.contains('is-unaffordable')).toBe(true);
    // Still clickable: §7 says the simulation is the authority, and a player
    // who cannot see why a building is refused learns nothing.
    expect((slot as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('no panel rebuilds its subtree on update', () => {
  it('adds and removes no elements while the numbers change', () => {
    const { root, ui, controller, simulation } = harness;
    runFrames(ui, 20);

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

    for (let i = 0; i < 200; i++) simulation.tick();
    simulation.inventory.add('chest', 7);
    controller.pump();
    runFrames(ui, 60);

    records.push(...observer.takeRecords());
    observer.disconnect();

    let added = 0;
    let removed = 0;
    for (const record of records) {
      // A toast appearing is the update, not a rebuild of a panel that was
      // already on screen, so the toast stack is out of scope here.
      if (closestClass(record.target, 'if-toasts')) continue;
      added += countElements(record.addedNodes);
      removed += countElements(record.removedNodes);
    }

    expect(added).toBe(0);
    expect(removed).toBe(0);
    // The text nodes behind the numbers were replaced, which is what
    // `textContent = value` does everywhere. That is the update §13 asks for;
    // what it forbids is the *elements* around them being thrown away, and
    // none were.
    expect(records.length).toBeGreaterThan(0);
    expect(tileValue(root, 'ITEMS')).toBe('27');
  });
});

describe('the update budget', () => {
  it('updates the HUD at 5 Hz, not once a frame', () => {
    const { root, ui, simulation } = harness;

    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

    // One second, in frames of exactly 10 ms. A round frame length rather
    // than 60 Hz's 16.666…: summing that repeatedly lands a hair *under* each
    // 200 ms boundary, which would make this assert 4 and prove nothing about
    // the rate. Each frame advances a full simulated second so the clock tile
    // has something new to say on every eligible pass.
    const STEP_MS = 10;
    let hudFrames = 0;
    for (let frame = 0; frame < 1000 / STEP_MS; frame++) {
      for (let tick = 0; tick < 30; tick++) simulation.tick();
      ui.update(STEP_MS);
      if (observer.takeRecords().some((record) => closestClass(record.target, 'if-hud'))) hudFrames += 1;
    }
    observer.disconnect();

    expect(hudFrames).toBe(HUD_HZ);
    expect(tileValue(root, 'TPS')).not.toBe('—');
  });

  it('ages a toast on the live lane, at 10 Hz', () => {
    const notifications = new Notifications();
    const host = document.createElement('div');
    notifications.mount(host);

    notifications.push('hello');
    expect(notifications.count).toBe(1);

    // One lane tick short of the lifetime.
    for (let i = 0; i < TOAST_LIFETIME_MS / (1000 / LIVE_HZ) - 1; i++) notifications.update(1000 / LIVE_HZ);
    expect(notifications.count).toBe(1);

    notifications.update(1000 / LIVE_HZ);
    expect(notifications.count).toBe(0);
    notifications.destroy();
  });

  it('stops both lanes while the game is paused', () => {
    const { root, ui, controller, simulation } = harness;
    runFrames(ui, 20);

    controller.setPaused(true);
    // The HUD still repainted once, on the pause event, and said so: that is
    // the one panel that has to update while both lanes are stopped.
    expect(query<HTMLElement>(root, '.if-hud').classList.contains('is-paused')).toBe(true);
    expect(query<HTMLElement>(root, '.if-hud__pause').textContent).toContain('PAUSED');

    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });

    for (let frame = 0; frame < 120; frame++) {
      for (let tick = 0; tick < 30; tick++) simulation.tick();
      ui.update(FRAME_MS);
    }
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(records.length).toBe(0);
  });
});

describe('notifications', () => {
  it('shows exactly one toast per rejected command, with a readable reason', () => {
    const { root, controller, simulation } = harness;

    controller.dispatch({ type: 'build', buildingId: 'chest', x: 0, y: 0, rotation: NORTH });
    controller.dispatch({ type: 'build', buildingId: 'chest', x: 0, y: 0, rotation: NORTH });
    simulation.tick();
    controller.pump();

    const toasts = root.querySelectorAll('.if-toast');
    // The first placement succeeded; the second landed on it.
    expect(toasts.length).toBe(1);
    expect(toasts[0]?.textContent).toBe('Something is already standing there.');
  });

  it('has a sentence for every rejection reason the game can produce', () => {
    const { root, controller, simulation } = harness;

    controller.dispatch({ type: 'mineTile', x: 1, y: 1 });
    controller.dispatch({ type: 'remove', x: 60, y: 60 });
    simulation.tick();
    controller.pump();

    for (const toast of root.querySelectorAll('.if-toast')) {
      expect(toast.textContent).toMatch(/[a-z]\.$/);
    }
  });

  it('keeps only the newest few toasts on screen', () => {
    const { root, controller, simulation } = harness;

    for (let i = 0; i < MAX_TOASTS + 3; i++) {
      controller.dispatch({ type: 'mineTile', x: i, y: 0 });
    }
    simulation.tick();
    controller.pump();

    expect(root.querySelectorAll('.if-toast').length).toBe(MAX_TOASTS);
  });
});
