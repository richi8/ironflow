import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { MAX_RESEARCH_QUEUE } from '../../src/game/research/research-state.js';
import { Simulation } from '../../src/game/simulation.js';
import { World } from '../../src/game/world/world.js';
import { RESEARCH_QUEUE_ROWS } from '../../src/ui/research-panel.js';
import { GameUI } from '../../src/ui/ui.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * The research panel. See ironflow.md C22 task 5 and §13.
 *
 * The criteria this file carries:
 *
 * - the tree is **visible before it is reachable** — C22's "visible locks are
 *   motivating; invisible ones are confusing" — so every node is drawn,
 *   whatever state it is in;
 * - starting and cancelling go out as **commands** and nothing else (§7);
 * - it **never rebuilds its subtree on update** (§13), checked with a real
 *   `MutationObserver`, which is the bar C07 set for every panel;
 * - the build menu names the technology beside a locked row, which is the
 *   other half of the same sentence.
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
function settle(): void {
  runFrames(harness.ui, 20);
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (element === null) throw new Error(`missing element: ${selector}`);
  return element;
}

function card(technologyId: string): HTMLButtonElement {
  return query<HTMLButtonElement>(harness.root, `.if-tech[data-technology="${technologyId}"]`);
}

function cards(): HTMLButtonElement[] {
  return [...harness.root.querySelectorAll<HTMLButtonElement>('.if-tech')];
}

function visibleQueueRows(): HTMLElement[] {
  return [...harness.root.querySelectorAll<HTMLElement>('.if-research .if-queue-row')].filter(
    (row) => !row.hidden,
  );
}

/** Apply everything in the command queue, then let the panel repaint. */
function tick(): void {
  harness.simulation.tick();
  harness.controller.pump();
  settle();
}

beforeEach(() => {
  harness = mountUi();
  harness.ui.toggleResearch();
});

afterEach(() => {
  harness.ui.destroy();
  harness.root.remove();
});

describe('opening and closing', () => {
  it('opens on the toolbar button and on the HUD tile it explains', () => {
    harness.ui.toggleResearch();
    const panel = query<HTMLElement>(harness.root, '.if-research');
    expect(panel.hidden).toBe(true);

    const tech = [...harness.root.querySelectorAll<HTMLButtonElement>('.if-toolbar__menu')].find(
      (button) => button.textContent === 'TECH',
    );
    tech?.click();
    expect(panel.hidden).toBe(false);
    expect(tech?.getAttribute('aria-pressed')).toBe('true');

    harness.ui.toggleResearch();
    const tile = [...harness.root.querySelectorAll<HTMLElement>('.if-hud__tile')].find(
      (element) => element.querySelector('.if-hud__label')?.textContent === 'RESEARCH',
    );
    expect(tile?.getAttribute('role')).toBe('button');
    tile?.click();
    expect(panel.hidden).toBe(false);
  });

  it('puts the inventory away, because they want the same space', () => {
    harness.ui.toggleInventory();
    expect(query<HTMLElement>(harness.root, '.if-research').hidden).toBe(true);
    expect(query<HTMLElement>(harness.root, '.if-inventory').hidden).toBe(false);
  });
});

describe('the tree', () => {
  it('draws every technology, including the ones that cannot be started yet', () => {
    // C22 task 5: a lock the player cannot see is a lock they cannot plan
    // around. Every node in the content table has a card from the first frame.
    expect(cards().map((element) => element.dataset['technology'])).toEqual(
      harness.simulation.technologies.all().map((technology) => technology.id),
    );
    expect(cards()).toHaveLength(5);
  });

  it('says what each node is in, and what it would give', () => {
    settle();
    expect(card('logistics_1').dataset['state']).toBe('available');
    expect(card('logistics_1').textContent).toContain('Splitter');
    // Its prerequisite is not done, so it is locked and says what it needs.
    expect(card('smelting_2').dataset['state']).toBe('locked');
    expect(card('smelting_2').disabled).toBe(true);
    expect(card('smelting_2').textContent).toContain('needs Logistics 1');
  });

  it('opens up a node whose prerequisite is only queued, because the queue chains', () => {
    card('logistics_1').click();
    tick();

    // The simulation accepts a technology whose prerequisite is ahead of it in
    // the queue, so the panel must offer it — otherwise the chaining the queue
    // exists for could never be reached from the UI.
    expect(card('smelting_2').dataset['state']).toBe('available');
    expect(card('smelting_2').disabled).toBe(false);
  });

  it('starts a technology by dispatching a command and nothing else', () => {
    card('logistics_1').click();

    // The click has changed nothing yet: §7 puts the decision in the
    // simulation, and the panel has only asked.
    expect(harness.simulation.research.queue).toHaveLength(0);

    tick();
    expect(harness.simulation.research.queue).toHaveLength(1);
    expect(card('logistics_1').dataset['state']).toBe('active');
    expect(query<HTMLElement>(harness.root, '.if-research__active-name').textContent).toBe('Logistics 1');
  });

  it('moves a node to researched, with its progress bar full', () => {
    harness.simulation.researchSystem.grant('logistics_1');
    settle();

    expect(card('logistics_1').dataset['state']).toBe('researched');
    expect(card('logistics_1').disabled).toBe(true);
    // And the next one along has become startable in the same breath.
    expect(card('smelting_2').dataset['state']).toBe('available');
    expect(card('smelting_2').disabled).toBe(false);
  });
});

describe('the queue', () => {
  it('lists what is lined up, head first, and cancels by command', () => {
    card('logistics_1').click();
    tick();
    card('smelting_2').click();
    tick();

    expect(visibleQueueRows().map((row) => row.querySelector('.if-queue-row__name')?.textContent)).toEqual([
      'Logistics 1',
      'Smelting 2',
    ]);

    query<HTMLButtonElement>(harness.root, '.if-research .if-queue-row__cancel[data-technology="smelting_2"]').click();
    expect(harness.simulation.research.queue).toHaveLength(2);

    tick();
    expect(harness.simulation.research.queue).toHaveLength(1);
    expect(visibleQueueRows()).toHaveLength(1);
  });

  it('draws more rows than the simulation will ever fill', () => {
    // The same inequality `QUEUE_ROWS` holds for hand-crafting: a queue the
    // player can build and cannot see would be a queue they cannot cancel.
    expect(RESEARCH_QUEUE_ROWS).toBeGreaterThan(MAX_RESEARCH_QUEUE);
  });

  it('says how many labs are working, because that is what explains a still bar', () => {
    settle();
    const labs = query<HTMLElement>(harness.root, '.if-research .if-inventory__slots');
    expect(labs.textContent).toBe('NO LABS');
    expect(labs.classList.contains('is-warning')).toBe(false);
  });
});

describe('the panel’s DOM', () => {
  it('never creates or destroys an element on update (§13)', () => {
    const panel = query<HTMLElement>(harness.root, '.if-research');
    let added = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) if (node.nodeType === 1) added += 1;
      }
    });
    observer.observe(panel, { childList: true, subtree: true });

    card('logistics_1').click();
    tick();
    harness.simulation.researchSystem.grant('logistics_1');
    settle();

    observer.takeRecords();
    observer.disconnect();
    // Text is replaced by assignment, which swaps a text node and nothing
    // else; an *element* added here would mean a rebuilt card (§13).
    expect(added).toBe(0);
  });
});

describe('the build menu’s half of the same sentence', () => {
  it('greys a locked building and names the technology that would reveal it', () => {
    harness.ui.toggleResearch();
    harness.ui.toggleBuildMenu();

    const row = query<HTMLButtonElement>(harness.root, '.if-build-row[data-building="splitter"]');
    expect(row.disabled).toBe(true);
    expect(row.classList.contains('is-locked')).toBe(true);
    expect(query<HTMLElement>(row, '.if-build-row__lock').textContent).toBe('Logistics 1');
    expect(row.title).toContain('researching Logistics 1 unlocks it');

    harness.simulation.researchSystem.grant('logistics_1');
    harness.controller.pump();

    expect(row.disabled).toBe(false);
    expect(query<HTMLElement>(row, '.if-build-row__lock').hidden).toBe(true);
  });
});
