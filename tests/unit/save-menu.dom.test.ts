import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { World } from '../../src/game/world/world.js';
import {
  DELETE_ARM_MS,
  SAVE_ROWS,
  SaveMenu,
  formatAge,
  formatPlaytime,
  formatSize,
  type SaveMenuView,
  type SaveSlotRow,
} from '../../src/ui/save-menu.js';
import { GameUI } from '../../src/ui/ui.js';

import { FakeScheduler } from '../fixtures/fake-scheduler.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * The save menu's DOM. See ironflow.md C25 task 7 and §13.
 *
 * Three things this file is responsible for, and one it is not.
 *
 * It checks that the panel **builds its DOM once** — with a real
 * `MutationObserver`, the same instrument C07 introduced and every panel since
 * has been held to — that `DELETE` takes two clicks, and that a panel which
 * cannot reach storage (§4) still turns a click into the right id and string.
 *
 * It is *not* responsible for what happens after the click. That is
 * `save-controller.test.ts`, headlessly, where the failure paths of §14 can
 * actually be staged.
 */

const NOW = 1_700_000_000_000;

function row(overrides: Partial<SaveSlotRow> = {}): SaveSlotRow {
  return {
    id: 'manual-1',
    name: 'Copper outpost',
    kind: 'manual',
    savedAt: NOW - 4 * 60 * 1000,
    playtimeSeconds: 4332,
    bytes: 148_000,
    current: false,
    ...overrides,
  };
}

function view(overrides: Partial<SaveMenuView> = {}): SaveMenuView {
  return {
    slots: [row()],
    hidden: 0,
    status: null,
    tone: 'info',
    canWrite: true,
    busy: false,
    offerTakeOver: false,
    ...overrides,
  };
}

interface Calls {
  save: string[];
  overwrite: [string, string][];
  load: string[];
  remove: string[];
  rename: [string, string][];
  exports: [string | null, string][];
  imports: string[];
  takeOver: number;
  close: number;
}

interface Harness {
  readonly menu: SaveMenu;
  readonly root: HTMLElement;
  readonly calls: Calls;
}

let harness: Harness;

function mountMenu(): Harness {
  const calls: Calls = {
    save: [],
    overwrite: [],
    load: [],
    remove: [],
    rename: [],
    exports: [],
    imports: [],
    takeOver: 0,
    close: 0,
  };
  const menu = new SaveMenu({
    onSave: (name) => calls.save.push(name),
    onOverwrite: (id, name) => calls.overwrite.push([id, name]),
    onLoad: (id) => calls.load.push(id),
    onDelete: (id) => calls.remove.push(id),
    onRename: (id, name) => calls.rename.push([id, name]),
    onExport: (id, name) => calls.exports.push([id, name]),
    onImport: (file) => calls.imports.push(file.name),
    onTakeOver: () => (calls.takeOver += 1),
    onClose: () => (calls.close += 1),
  });
  const root = document.createElement('div');
  document.body.append(root);
  menu.mount(root);
  menu.setOpen(true);
  return { menu, root, calls };
}

function rows(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('.if-save-row')];
}

function visibleRows(root: HTMLElement): HTMLButtonElement[] {
  return rows(root).filter((button) => !button.hidden);
}

function action(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('.if-saves__action')].find((button) =>
    (button.textContent ?? '').startsWith(label),
  );
  if (found === undefined) throw new Error(`no ${label} button`);
  return found;
}

function nameInput(root: HTMLElement): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>('.if-saves__name');
  if (input === null) throw new Error('no name input');
  return input;
}

beforeEach(() => {
  vi.setSystemTime(NOW);
  harness = mountMenu();
});

afterEach(() => {
  harness.menu.destroy();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

describe('the panel', () => {
  it('builds its rows once and hides the unused ones (§13)', () => {
    const { menu, root } = harness;
    expect(rows(root).length).toBe(SAVE_ROWS);
    expect(visibleRows(root).length).toBe(0);

    const observer = new MutationObserver(() => undefined);
    observer.observe(root, { childList: true, subtree: true });

    menu.update(view());
    menu.update(view({ slots: [row(), row({ id: 'auto-1', name: 'Autosave 1', kind: 'auto' })] }));
    menu.update(view({ slots: [] }));

    // A save list is the first panel whose length is not decided by a content
    // table, so the pool is a cap rather than a shape — and nothing is created
    // or destroyed while the game runs. Text nodes are exempt: `textContent`
    // replaces one by assignment, which is what §13 asks a panel to do. An
    // *element* here would mean a rebuilt row.
    const elements = observer
      .takeRecords()
      .flatMap((record) => [...record.addedNodes, ...record.removedNodes])
      .filter((node) => node.nodeType === Node.ELEMENT_NODE);
    expect(elements).toEqual([]);
    observer.disconnect();
    expect(rows(root).length).toBe(SAVE_ROWS);
  });

  it('shows a save with its age, playtime and size', () => {
    const { menu, root } = harness;
    menu.update(view());

    const [first] = visibleRows(root);
    expect(first?.textContent).toContain('Copper outpost');
    expect(first?.textContent).toContain('manual');
    expect(first?.textContent).toContain('4 min ago');
    expect(first?.textContent).toContain('1h 12m');
    expect(first?.textContent).toContain('148.0 kB');
  });

  it('says how many saves it is not showing', () => {
    const { menu, root } = harness;
    const many = Array.from({ length: SAVE_ROWS + 3 }, (_unused, index) => row({ id: `manual-${index}` }));
    menu.update(view({ slots: many, hidden: 3 }));

    expect(visibleRows(root).length).toBe(SAVE_ROWS);
    expect(root.querySelector('.if-saves__more')?.textContent).toContain('3 more');
  });

  it('tells the player when there is nothing to load', () => {
    const { menu, root } = harness;
    menu.update(view({ slots: [] }));
    const empty = root.querySelector<HTMLElement>('.if-inventory__empty');
    expect(empty?.hidden).toBe(false);
    expect(empty?.textContent).toContain('autosaves every three minutes');
  });
});

describe('the verbs', () => {
  it('saves under the typed name', () => {
    const { root, calls } = harness;
    nameInput(root).value = '  Copper outpost  ';
    action(root, 'SAVE').click();
    expect(calls.save).toEqual(['Copper outpost']);
  });

  it('names an unnamed save rather than writing an empty string', () => {
    const { root, calls } = harness;
    action(root, 'SAVE').click();
    expect(calls.save).toEqual(['Factory']);
  });

  it('does nothing until a row is picked', () => {
    const { menu, root, calls } = harness;
    menu.update(view());
    expect(action(root, 'LOAD').disabled).toBe(true);
    expect(action(root, 'DELETE').disabled).toBe(true);

    visibleRows(root)[0]?.click();
    expect(action(root, 'LOAD').disabled).toBe(false);
    action(root, 'LOAD').click();
    expect(calls.load).toEqual(['manual-1']);
  });

  it('fills the name box from the row that was picked', () => {
    const { menu, root, calls } = harness;
    menu.update(view());
    visibleRows(root)[0]?.click();

    expect(nameInput(root).value).toBe('Copper outpost');
    action(root, 'RENAME').click();
    expect(calls.rename).toEqual([['manual-1', 'Copper outpost']]);
  });

  it('will not overwrite an autosave slot', () => {
    const { menu, root, calls } = harness;
    menu.update(view({ slots: [row({ id: 'auto-1', name: 'Autosave 1', kind: 'auto' })] }));
    visibleRows(root)[0]?.click();

    // The rotation would take it back within nine minutes, and the player
    // would have been told it was saved.
    expect(action(root, 'OVERWRITE').disabled).toBe(true);
    action(root, 'OVERWRITE').click();
    expect(calls.overwrite).toEqual([]);
  });

  it('deletes only on the second click', () => {
    const { menu, root, calls } = harness;
    menu.update(view());
    visibleRows(root)[0]?.click();

    action(root, 'DELETE').click();
    expect(calls.remove).toEqual([]);
    expect(action(root, 'DELETE').textContent).toBe('DELETE?');

    action(root, 'DELETE').click();
    expect(calls.remove).toEqual(['manual-1']);
    expect(action(root, 'DELETE').textContent).toBe('DELETE');
  });

  it('forgets an armed delete after a while', () => {
    const { menu, root, calls } = harness;
    menu.update(view());
    visibleRows(root)[0]?.click();
    action(root, 'DELETE').click();

    // A player who walks away must not come back to a live delete under the
    // cursor.
    vi.setSystemTime(NOW + DELETE_ARM_MS + 1);
    action(root, 'DELETE').click();
    expect(calls.remove).toEqual([]);
  });

  it('forgets an armed delete when the panel is closed', () => {
    const { menu, root, calls } = harness;
    menu.update(view());
    visibleRows(root)[0]?.click();
    action(root, 'DELETE').click();

    menu.setOpen(false);
    menu.setOpen(true);
    action(root, 'DELETE').click();
    expect(calls.remove).toEqual([]);
  });

  it('drops a selection whose slot has gone', () => {
    const { menu, root } = harness;
    menu.update(view());
    visibleRows(root)[0]?.click();
    expect(menu.getSelection()).toBe('manual-1');

    menu.update(view({ slots: [] }));
    expect(menu.getSelection()).toBeNull();
    expect(action(root, 'LOAD').disabled).toBe(true);
  });
});

describe('what it says when it cannot save', () => {
  it('greys the writing verbs and shows the reason', () => {
    const { menu, root } = harness;
    menu.update(
      view({
        canWrite: false,
        offerTakeOver: true,
        status: 'Another tab has this game open and is the one saving.',
        tone: 'warn',
      }),
    );
    visibleRows(root)[0]?.click();

    expect(action(root, 'SAVE').disabled).toBe(true);
    expect(action(root, 'DELETE').disabled).toBe(true);
    // Loading is still allowed: reading is not writing, and a second tab that
    // cannot even look at its own saves is worse than one that cannot save.
    expect(action(root, 'LOAD').disabled).toBe(false);

    const status = root.querySelector<HTMLElement>('.if-saves__status');
    expect(status?.textContent).toContain('Another tab');
    expect(status?.classList.contains('is-warn')).toBe(true);
  });

  it('offers to take the lock over, and hides the offer otherwise', () => {
    const { menu, root, calls } = harness;
    menu.update(view({ canWrite: false, offerTakeOver: true }));
    const takeOver = action(root, 'TAKE OVER');
    expect(takeOver.hidden).toBe(false);
    takeOver.click();
    expect(calls.takeOver).toBe(1);

    menu.update(view());
    expect(action(root, 'TAKE OVER').hidden).toBe(true);
  });

  it('holds every button while an operation is in flight', () => {
    const { menu, root } = harness;
    menu.update(view({ busy: true }));
    visibleRows(root)[0]?.click();
    for (const label of ['SAVE', 'LOAD', 'OVERWRITE', 'RENAME', 'DELETE']) {
      expect(action(root, label).disabled).toBe(true);
    }
  });

  it('draws a failure differently from a warning', () => {
    const { menu, root } = harness;
    menu.update(view({ status: 'Out of storage space.', tone: 'error' }));
    const status = root.querySelector<HTMLElement>('.if-saves__status');
    expect(status?.classList.contains('is-error')).toBe(true);
    expect(status?.classList.contains('is-warn')).toBe(false);
  });
});

describe('the panel inside GameUI', () => {
  it('opens, closes, and puts the other panels away', () => {
    const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
    const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => undefined });
    const controller = new GameController({ game, cursor: new DetachedCursor() });
    const root = document.createElement('div');
    document.body.append(root);

    const visibility: boolean[] = [];
    const ui = new GameUI({
      root,
      controller,
      saves: {
        onSave: () => undefined,
        onOverwrite: () => undefined,
        onLoad: () => undefined,
        onDelete: () => undefined,
        onRename: () => undefined,
        onExport: () => undefined,
        onImport: () => undefined,
        onTakeOver: () => undefined,
        onVisibility: (open) => visibility.push(open),
      },
    });
    ui.mount();
    ui.toggleResearch();

    expect(ui.toggleSaveMenu()).toBe(true);
    expect(ui.isSaveMenuOpen()).toBe(true);
    // The fifth panel to want the same half of the screen, and the same rule.
    expect(ui.isResearchOpen()).toBe(false);
    // §8: the composition root is told, so it can stop the loop behind it.
    expect(visibility).toEqual([true]);

    ui.toggleInventory();
    expect(ui.isSaveMenuOpen()).toBe(false);
    expect(visibility).toEqual([true, false]);

    ui.destroy();
  });

  it('is drawn and inert when the game was mounted without storage', () => {
    const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
    const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => undefined });
    const controller = new GameController({ game, cursor: new DetachedCursor() });
    const root = document.createElement('div');
    document.body.append(root);

    const ui = new GameUI({ root, controller });
    ui.mount();
    ui.toggleSaveMenu();
    ui.setSaveMenuView(view());

    // A test that mounts the UI without a database gets a menu whose buttons
    // do nothing, which is what they would do with no storage behind them.
    expect(() => action(root, 'SAVE').click()).not.toThrow();
    ui.destroy();
  });
});

describe('the readouts', () => {
  it('says how long ago in the unit the player is asking in', () => {
    expect(formatAge(5_000)).toBe('just now');
    expect(formatAge(4 * 60_000)).toBe('4 min ago');
    expect(formatAge(90 * 60_000)).toBe('1h 30m ago');
    expect(formatAge(25 * 3_600_000)).toBe('yesterday');
    expect(formatAge(3 * 24 * 3_600_000)).toBe('3 days ago');
    // A clock that went backwards must not print a negative age.
    expect(formatAge(-1)).toBe('just now');
  });

  it('says playtime in hours and minutes', () => {
    expect(formatPlaytime(45)).toBe('45s');
    expect(formatPlaytime(4332)).toBe('1h 12m');
    expect(formatPlaytime(600)).toBe('10m 00s');
    expect(formatPlaytime(Number.NaN)).toBe('0m');
  });

  it('says size the way a disk does', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(148_000)).toBe('148.0 kB');
    expect(formatSize(2_500_000)).toBe('2.50 MB');
  });
});


describe('export and import', () => {
  it('exports the selected slot, and the running game when nothing is selected', () => {
    harness = mountMenu();
    harness.menu.update(view({ slots: [row({ id: 'a', name: 'Copper outpost' })] }));

    // Nothing picked: the button offers the game itself, under the typed name.
    expect(action(harness.root, 'EXPORT GAME').disabled).toBe(false);
    nameInput(harness.root).value = 'Live factory';
    action(harness.root, 'EXPORT GAME').click();
    expect(harness.calls.exports).toEqual([[null, 'Live factory']]);

    visibleRows(harness.root)[0]?.click();
    action(harness.root, 'EXPORT').click();
    expect(harness.calls.exports[1]).toEqual(['a', 'Copper outpost']);
  });

  it('opens the file picker and reports what came back', () => {
    harness = mountMenu();
    const input = harness.root.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(input?.hidden).toBe(true);
    expect(input?.accept).toContain('.ifsave');

    let clicked = 0;
    if (input !== null) input.click = (): void => void (clicked += 1);
    action(harness.root, 'IMPORT').click();
    expect(clicked).toBe(1);

    // The change event is what the panel actually listens to; jsdom will not
    // let a test set `files`, so it is defined on the element directly.
    const file = new File(['bytes'], 'factory.ifsave');
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    input?.dispatchEvent(new Event('change'));
    expect(harness.calls.imports).toEqual(['factory.ifsave']);
  });

  it('keeps both verbs available when storage will not take a write', () => {
    // A browser with no IndexedDB is the browser a player most needs to get a
    // factory out of, and into.
    harness = mountMenu();
    harness.menu.update(view({ canWrite: false, slots: [row({ id: 'a' })] }));

    expect(action(harness.root, 'SAVE').disabled).toBe(true);
    expect(action(harness.root, 'EXPORT GAME').disabled).toBe(false);
    expect(action(harness.root, 'IMPORT').disabled).toBe(false);
  });

  it('holds both while an operation is in flight', () => {
    harness = mountMenu();
    harness.menu.update(view({ busy: true }));
    expect(action(harness.root, 'EXPORT GAME').disabled).toBe(true);
    expect(action(harness.root, 'IMPORT').disabled).toBe(true);
  });
});
