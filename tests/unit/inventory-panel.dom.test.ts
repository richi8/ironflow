import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { MAX_CRAFT_ORDERS } from '../../src/game/player/player-state.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { World } from '../../src/game/world/world.js';
import { BATCH_CRAFT, QUEUE_ROWS } from '../../src/ui/inventory.js';
import { GameUI } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * The inventory panel. See ironflow.md C21A and §13.
 *
 * The criteria this file carries:
 *
 * - the panel shows **what the player is carrying**, which is the thing that
 *   had no home in the UI for twelve chunks;
 * - it is reachable **three ways** — the key, the toolbar and the HUD tile
 *   whose number it explains;
 * - a craft goes out as a **command** and nothing else (§7), including the
 *   shift-click batch;
 * - it **never rebuilds its subtree on update** (§13), checked with a real
 *   `MutationObserver`, which is the same bar C07 set for every other panel;
 * - a stalled craft **says so**, because §13 forbids a bar that sits still
 *   with no explanation.
 */

interface Harness {
  readonly root: HTMLElement;
  readonly ui: GameUI;
  readonly controller: GameController;
  readonly simulation: Simulation;
}

let harness: Harness;

function mountUi(): Harness {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const controller = new GameController({ game, cursor: new DetachedCursor() });

  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);

  const ui = new GameUI({ root, controller });
  ui.mount();
  return { root, ui, controller, simulation };
}

/** One frame's worth of a 60 Hz display, in ms. */
const FRAME_MS = 1000 / 60;

function runFrames(ui: GameUI, count: number): void {
  for (let i = 0; i < count; i++) ui.update(FRAME_MS);
}

/** Enough frames for the 5 Hz lane to beat at least once. */
function settle(harness: Harness): void {
  runFrames(harness.ui, 20);
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

function give(simulation: Simulation, itemId: string, count: number): void {
  simulation.player.inventory.add(simulation.items.idOf(itemId), count);
}

/** The visible bag rows, as "Name count". */
function bagRows(root: ParentNode): string[] {
  return [...root.querySelectorAll('.if-bag-cell')]
    .filter((cell) => !(cell as HTMLElement).hidden)
    .map((cell) => {
      const name = cell.querySelector('.if-bag-cell__name')?.textContent ?? '';
      const count = cell.querySelector('.if-bag-cell__count')?.textContent ?? '';
      return `${name} ${count}`;
    });
}

function craftButton(root: ParentNode, recipeId: string): HTMLButtonElement {
  return query<HTMLButtonElement>(root, `.if-craft[data-recipe="${recipeId}"]`);
}

function visibleQueueRows(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.if-queue-row')].filter((row) => !row.hidden);
}

beforeEach(() => {
  harness = mountUi();
});

afterEach(() => {
  harness.ui.destroy();
  harness.root.remove();
});

describe('opening and closing', () => {
  it('starts closed and opens on the toolbar button', () => {
    const panel = query<HTMLElement>(harness.root, '.if-inventory');
    expect(panel.hidden).toBe(true);

    const bag = [...harness.root.querySelectorAll<HTMLButtonElement>('.if-toolbar__menu')].find(
      (button) => button.textContent === 'BAG',
    );
    expect(bag).toBeDefined();
    bag?.click();

    expect(panel.hidden).toBe(false);
    expect(bag?.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens on the HUD tile whose number it explains', () => {
    const items = [...harness.root.querySelectorAll<HTMLElement>('.if-hud__tile')].find(
      (tile) => tile.querySelector('.if-hud__label')?.textContent === 'ITEMS',
    );
    expect(items?.getAttribute('role')).toBe('button');

    items?.click();
    expect(query<HTMLElement>(harness.root, '.if-inventory').hidden).toBe(false);
  });

  it('picks up a carried building on a click and gets out of the way', () => {
    harness.ui.toggleInventory();
    const cell = query<HTMLElement>(harness.root, '.if-bag-cell[data-building="chest"]');
    expect(cell.draggable).toBe(true);

    cell.click();
    expect(harness.controller.getSelectedBuilding()).toBe('chest');
    expect(harness.ui.isInventoryOpen()).toBe(false);

    // Picking up what is already held keeps holding it.
    harness.ui.toggleInventory();
    cell.click();
    expect(harness.controller.getSelectedBuilding()).toBe('chest');
  });

  it('offers nothing to pick up or drag for an item that builds nothing', () => {
    const ore = [...harness.root.querySelectorAll<HTMLElement>('.if-bag-cell')].find(
      (cell) => cell.querySelector('.if-bag-cell__name')?.textContent === 'Iron Ore',
    );
    expect(ore).toBeDefined();
    expect(ore?.draggable).toBe(false);
    expect(ore?.classList.contains('is-placeable')).toBe(false);
  });

  it('repaints on the frame it opens, even while paused', () => {
    harness.controller.setPaused(true);
    give(harness.simulation, 'iron_ore', 7);

    harness.ui.toggleInventory();

    // No frame has run — a paused game stops both lanes — and the row is
    // already there, which is the whole point of repainting on the way in.
    expect(bagRows(harness.root)).toContain('Iron Ore 7');
  });
});

describe('what the player is carrying', () => {
  it('says so, which is what had no home in the UI before', () => {
    harness.ui.toggleInventory();
    expect(bagRows(harness.root)).toEqual([]);
    expect(query<HTMLElement>(harness.root, '.if-inventory__empty').hidden).toBe(false);

    give(harness.simulation, 'iron_ore', 12);
    give(harness.simulation, 'coal', 3);
    settle(harness);

    expect(bagRows(harness.root)).toEqual(['Iron Ore 12', 'Coal 3']);
    expect(query<HTMLElement>(harness.root, '.if-inventory__empty').hidden).toBe(true);
  });

  it('counts slots the way the container does', () => {
    harness.ui.toggleInventory();
    // Iron ore stacks in 50s, so 60 is two slots — which is the number the
    // bag is full on, not the 60 the HUD's total shows.
    give(harness.simulation, 'iron_ore', 60);
    settle(harness);

    const slots = query<HTMLElement>(harness.root, '.if-inventory__slots');
    expect(slots.textContent).toBe(`2 / ${harness.simulation.player.inventory.slots} SLOTS`);
    expect(query<HTMLElement>(harness.root, '.if-bag-cell__slots').textContent).toBe('2 slots');
  });

  it('warns when the last slot has gone', () => {
    harness.ui.toggleInventory();
    const coal = harness.simulation.items.idOf('coal');
    harness.simulation.player.inventory.add(coal, harness.simulation.player.inventory.spaceFor(coal));
    settle(harness);

    expect(query<HTMLElement>(harness.root, '.if-inventory__slots').classList.contains('is-warning')).toBe(true);
  });

  it('never rebuilds its subtree when the contents change', () => {
    harness.ui.toggleInventory();
    const panel = query<HTMLElement>(harness.root, '.if-inventory');

    let added = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) added += record.addedNodes.length;
    });
    observer.observe(panel, { childList: true, subtree: true });

    give(harness.simulation, 'iron_ore', 4);
    settle(harness);
    give(harness.simulation, 'copper_ore', 9);
    settle(harness);

    observer.takeRecords();
    observer.disconnect();
    // Text nodes are replaced by assignment, which `textContent` does without
    // adding a node; an element added here would mean a rebuilt row (§13).
    expect(added).toBe(0);
  });
});

describe('crafting by hand', () => {
  it('lists what §15 says the hands can make, and nothing else', () => {
    harness.ui.toggleInventory();
    const ids = [...harness.root.querySelectorAll<HTMLElement>('.if-craft')].map(
      (button) => button.dataset['recipe'],
    );
    expect(ids).toEqual(harness.simulation.recipes.handCraftable().map((recipe) => recipe.id));
    expect(ids).not.toContain('smelt_iron');
    expect(ids).not.toContain('make_assembler');
  });

  it('prints the time the simulation will actually take', () => {
    harness.ui.toggleInventory();
    const ticks = harness.simulation.crafts.handTicksFor(
      harness.simulation.recipes.get('make_gear').recipeId,
    );
    expect(craftButton(harness.root, 'make_gear').querySelector('.if-craft__time')?.textContent).toBe(
      `${(ticks / TPS).toFixed(1)}s`,
    );
  });

  it('greys out what the bag cannot pay for, and names the short line', () => {
    harness.ui.toggleInventory();
    const button = craftButton(harness.root, 'make_gear');
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.if-craft__parts')?.textContent).toBe('0/2 Iron Plate');

    give(harness.simulation, 'iron_plate', 5);
    settle(harness);

    expect(button.disabled).toBe(false);
    expect(button.querySelector('.if-craft__parts')?.textContent).toBe('5/2 Iron Plate');
  });

  it('queues one on a click and a handful on a shift-click, as commands', () => {
    harness.ui.toggleInventory();
    give(harness.simulation, 'iron_plate', 40);
    settle(harness);

    craftButton(harness.root, 'make_gear').click();
    harness.simulation.tick();
    expect(harness.simulation.player.crafts[0]?.remaining).toBe(1);

    craftButton(harness.root, 'make_gear').dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    harness.simulation.tick();
    expect(harness.simulation.player.crafts[0]?.remaining).toBe(1 + BATCH_CRAFT);
  });

  it('shows the queue, with a bar on the head order only', () => {
    harness.ui.toggleInventory();
    give(harness.simulation, 'iron_plate', 10);
    give(harness.simulation, 'copper_plate', 10);
    settle(harness);

    craftButton(harness.root, 'make_gear').click();
    craftButton(harness.root, 'make_wire').click();
    for (let i = 0; i < 10; i++) harness.simulation.tick();
    settle(harness);

    const rows = visibleQueueRows(harness.root);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelector('.if-queue-row__name')?.textContent).toBe('Gear');
    expect(rows[0]?.dataset['state']).toBe('active');
    expect(rows[1]?.dataset['state']).toBe('waiting');
    expect(rows[1]?.querySelector<HTMLElement>('.if-queue-row__bar')?.style.width).toBe('0%');
  });

  it('cancels through a command, and the ingredients come back', () => {
    harness.ui.toggleInventory();
    give(harness.simulation, 'iron_plate', 4);
    settle(harness);

    craftButton(harness.root, 'make_gear').dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    harness.simulation.tick();
    settle(harness);
    // Five gears want ten plates and the bag holds four, so the batch is
    // refused whole (see the test below). One craft is what four plates buy.
    expect(harness.simulation.player.crafts).toHaveLength(0);

    craftButton(harness.root, 'make_gear').click();
    harness.simulation.tick();
    settle(harness);
    expect(harness.simulation.player.inventory.count(harness.simulation.items.idOf('iron_plate'))).toBe(2);

    query<HTMLButtonElement>(harness.root, '.if-queue-row__cancel').click();
    harness.simulation.tick();

    expect(harness.simulation.player.crafts).toHaveLength(0);
    expect(harness.simulation.player.inventory.count(harness.simulation.items.idOf('iron_plate'))).toBe(4);
  });

  it('refuses a batch the bag cannot pay for in full', () => {
    harness.ui.toggleInventory();
    give(harness.simulation, 'iron_plate', 4);
    settle(harness);

    // Four plates buy two gears; a shift-click asks for five. The order is
    // all-or-nothing, so it is refused rather than quietly shortened.
    craftButton(harness.root, 'make_gear').dispatchEvent(
      new MouseEvent('click', { bubbles: true, shiftKey: true }),
    );
    harness.simulation.tick();

    expect(harness.simulation.player.crafts).toHaveLength(0);
    expect(harness.simulation.commands.takeRejections()[0]?.reason).toBe('unaffordable');
  });

  it('says a finished craft is stuck rather than showing a bar that stopped', () => {
    harness.ui.toggleInventory();
    give(harness.simulation, 'iron_plate', 2);
    settle(harness);

    craftButton(harness.root, 'make_gear').click();
    harness.simulation.tick();

    // Fill the bag behind the craft, so the gear has nowhere to land.
    const coal = harness.simulation.items.idOf('coal');
    harness.simulation.player.inventory.add(coal, harness.simulation.player.inventory.spaceFor(coal));
    const duration = harness.simulation.crafts.handTicksFor(
      harness.simulation.recipes.get('make_gear').recipeId,
    );
    for (let i = 0; i < duration + 5; i++) harness.simulation.tick();
    settle(harness);

    const row = visibleQueueRows(harness.root)[0];
    expect(row?.dataset['state']).toBe('blocked');
    expect(row?.title).toContain('bag is full');
  });
});

describe('the pools are big enough for the state they draw', () => {
  it('has a queue row for every order the simulation will hold', () => {
    expect(QUEUE_ROWS).toBeGreaterThanOrEqual(MAX_CRAFT_ORDERS);
  });

  it('agrees with the simulation about how long a second is', () => {
    // The panel divides ticks by its own copy of the rate, because §4 will not
    // let it import the clock. This is the assertion that keeps the copy true.
    harness.ui.toggleInventory();
    const belt = harness.simulation.recipes.get('make_belt');
    const ticks = harness.simulation.crafts.handTicksFor(belt.recipeId);
    expect(craftButton(harness.root, 'make_belt').querySelector('.if-craft__time')?.textContent).toBe(
      `${(ticks / TPS).toFixed(1)}s`,
    );
  });
});
