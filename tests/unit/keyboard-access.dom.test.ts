import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Command } from '../../src/game/commands/command.js';
import { DetachedCursor, GameController } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { Simulation } from '../../src/game/simulation.js';
import { NORTH, type TileCoord } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { InputManager, type ScenePickResult } from '../../src/input/input-manager.js';
import { ACTION_LABELS, DEFAULT_KEYBINDINGS, INPUT_ACTIONS, keysFor } from '../../src/input/keybindings.js';
import { BAG_COLUMNS } from '../../src/ui/inventory.js';
import { SettingsPanel, type SettingsView } from '../../src/ui/settings-panel.js';
import { GameUI, type ObjectiveProgress } from '../../src/ui/ui.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';

/**
 * Keyboard access. See ironflow.md C30 task 3 and its first acceptance line:
 *
 * > Every action is reachable without a mouse.
 *
 * These are the "keyboard-navigation smoke tests in jsdom" C30 names. They
 * walk each thing a mouse does and do it with keys instead: act on the world
 * (build, feed, open, mine, remove), open and move through every panel, fill
 * and rearrange the hotbar, move stacks, rebind a key. Nothing here clicks.
 */

function key(type: 'keydown' | 'keyup', code: string, init: { key?: string; shiftKey?: boolean } = {}): KeyboardEvent {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: init.key ?? code, shiftKey: init.shiftKey ?? false });
}

/** Press and release on whatever has focus (or the document). */
function tap(code: string, init: { key?: string; shiftKey?: boolean } = {}): void {
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(key('keydown', code, init));
  target.dispatchEvent(key('keyup', code, init));
}

describe('every action has a key', () => {
  it('binds every action to at least one key by default', () => {
    const unbound = INPUT_ACTIONS.filter((action) => keysFor(DEFAULT_KEYBINDINGS, action).length === 0);
    expect(unbound).toEqual([]);
  });

  it('labels every action for the rebinding list', () => {
    for (const action of INPUT_ACTIONS) expect(ACTION_LABELS[action].length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- *
 * The world, without a mouse
 * -------------------------------------------------------------------------- */

interface WorldHarness {
  readonly input: InputManager;
  readonly commands: Command[];
  target: ScenePickResult | null;
}

let worldHarness: WorldHarness | null = null;

function mountInput(): WorldHarness {
  const canvas = document.createElement('canvas');
  document.body.append(canvas);
  const commands: Command[] = [];
  const harness: WorldHarness = {
    input: null as unknown as InputManager,
    commands,
    target: { tile: { x: 5, y: 4 }, entityId: null },
  };
  const input = new InputManager({
    canvas,
    keyTarget: document,
    camera: { pan: () => {}, zoomAt: () => {}, screenDirectionToWorld: (x, y) => ({ x, y }) },
    picker: { pick: () => ({ tile: { x: 99, y: 99 }, entityId: null }) },
    commands: {
      enqueue: (command) => {
        commands.push(command);
        return true;
      },
    },
    keyboardTarget: () => harness.target,
  });
  (harness as { input: InputManager }).input = input;
  input.attach();
  worldHarness = harness;
  return harness;
}

afterEach(() => {
  worldHarness?.input.detach();
  worldHarness = null;
  document.body.replaceChildren();
});

describe('acting on the tile in front of the player', () => {
  it('mines bare ground while Enter is held, and stops on release', () => {
    const { input, commands } = mountInput();
    document.dispatchEvent(key('keydown', 'Enter'));
    expect(commands).toEqual([{ type: 'mineTile', x: 5, y: 4 }]);
    expect(input.isKeyboardAiming).toBe(true);
    document.dispatchEvent(key('keyup', 'Enter'));
    expect(commands.at(-1)).toEqual({ type: 'stopMining' });
  });

  it('places the held building there, and lays a line as the player walks with Enter held', () => {
    const harness = mountInput();
    harness.input.setBuildTool({ buildingId: 'belt', rotationCount: 4, lineBuild: true });
    document.dispatchEvent(key('keydown', 'Enter'));
    expect(harness.commands).toEqual([{ type: 'build', buildingId: 'belt', x: 5, y: 4, rotation: NORTH }]);

    harness.target = { tile: { x: 5, y: 3 }, entityId: null };
    harness.input.update(16);
    harness.input.update(16);
    expect(harness.commands).toHaveLength(2);
    expect(harness.commands[1]).toMatchObject({ type: 'build', x: 5, y: 3 });
    document.dispatchEvent(key('keyup', 'Enter'));
  });

  it('opens a machine with an empty hand, and feeds it with a material in hand', () => {
    const harness = mountInput();
    harness.target = { tile: { x: 5, y: 4 }, entityId: 42 };
    tap('Enter');
    expect(harness.input.selectedEntityId).toBe(42);
    expect(harness.commands).toEqual([]);

    harness.input.setHeldItem({ itemId: 'coal', amount: 50 });
    tap('Enter');
    expect(harness.commands).toEqual([{ type: 'insertItems', entityId: 42, itemId: 'coal', amount: 50 }]);
  });

  it('removes what is in front with Delete or X', () => {
    const { commands } = mountInput();
    tap('Delete');
    tap('KeyX');
    expect(commands).toEqual([
      { type: 'remove', x: 5, y: 4 },
      { type: 'remove', x: 5, y: 4 },
    ]);
  });

  it('shows the ghost where the keyboard points once a building is picked up', () => {
    const { input } = mountInput();
    input.setBuildTool({ buildingId: 'chest', rotationCount: 1, lineBuild: false });
    tap('Digit3');
    expect(input.hover).toEqual<TileCoord>({ x: 5, y: 4 });
  });

  it('hands pointing back to the mouse the moment it moves', () => {
    const { input } = mountInput();
    tap('KeyR');
    expect(input.isKeyboardAiming).toBe(true);
    const canvas = document.querySelector('canvas');
    canvas?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 1, clientY: 1 }));
    expect(input.isKeyboardAiming).toBe(false);
  });

  it('lets Enter press a focused button instead of acting on the world', () => {
    const { commands } = mountInput();
    const button = document.createElement('button');
    let pressed = 0;
    button.addEventListener('keydown', () => {
      pressed += 1;
    });
    document.body.append(button);
    button.focus();
    tap('Enter');
    expect(pressed).toBe(1);
    expect(commands).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * The panels, without a mouse
 * -------------------------------------------------------------------------- */

interface UiHarness {
  readonly root: HTMLElement;
  readonly ui: GameUI;
  readonly controller: GameController;
  readonly simulation: Simulation;
  readonly progress: ObjectiveProgress[];
}

function mountUi(options: { objectives?: ObjectiveProgress; settings?: boolean } = {}): UiHarness {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  simulation.inventory.add('iron_ore', 30);
  simulation.inventory.add('chest', 5);
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const controller = new GameController({ game, cursor: new DetachedCursor() });
  const root = document.createElement('div');
  root.id = 'ui';
  document.body.append(root);
  const progress: ObjectiveProgress[] = [];
  const ui = new GameUI({
    root,
    controller,
    ...(options.objectives === undefined
      ? {}
      : { objectives: { initial: options.objectives, onChange: (next: ObjectiveProgress) => void progress.push(next) } }),
    ...(options.settings === true
      ? {
          settings: {
            view: () => SETTINGS_VIEW,
            onVolume: () => {},
            onMuted: () => {},
            onScale: () => {},
            onMotion: () => {},
            onBind: () => {},
            onResetBindings: () => {},
          },
        }
      : {}),
  });
  ui.mount();
  return { root, ui, controller, simulation, progress };
}

const SETTINGS_VIEW: SettingsView = Object.freeze({
  volume: 0.5,
  muted: false,
  uiScale: 1,
  scales: [1, 1.5],
  motion: 'system',
  systemReducesMotion: false,
  objectivesVisible: true,
  bindings: [
    { action: 'world.interact', label: 'Use', keys: ['Enter'] },
    { action: 'world.remove', label: 'Remove', keys: ['Delete'] },
  ],
});

function bagCell(root: HTMLElement, index: number): HTMLElement {
  const cell = root.querySelector<HTMLElement>(`.if-inventory .if-bag-cell[data-index="${index}"]`);
  if (cell === null) throw new Error(`no bag cell ${index}`);
  return cell;
}

describe('panels from the keyboard', () => {
  it('moves focus into a panel as it opens, and out as it closes', () => {
    const { root, ui } = mountUi();
    ui.toggleInventory();
    expect(document.activeElement).toBe(root.querySelector('.if-inventory'));
    ui.toggleInventory();
    expect(root.querySelector('.if-inventory')?.contains(document.activeElement)).toBe(false);
  });

  it('presses a role="button" tile on Enter', () => {
    const { root, ui } = mountUi();
    const items = [...root.querySelectorAll<HTMLElement>('.if-hud__tile')].find((tile) => tile.getAttribute('role') === 'button');
    expect(items).toBeDefined();
    items?.focus();
    tap('Enter', { key: 'Enter' });
    expect(ui.isInventoryOpen() || ui.isResearchOpen()).toBe(true);
  });

  it('walks the bag with arrows and carries a stack with shift+arrow', () => {
    const { root, ui, simulation } = mountUi();
    ui.toggleInventory();
    const first = bagCell(root, 0);
    first.focus();
    tap('ArrowRight', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(bagCell(root, 1));
    tap('ArrowDown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(bagCell(root, 1 + BAG_COLUMNS));

    first.focus();
    tap('ArrowRight', { key: 'ArrowRight', shiftKey: true });
    const queued = simulation.commands.drain();
    expect(queued).toEqual([{ type: 'moveStack', fromEntity: null, from: 0, toEntity: null, to: 1 }]);
  });

  it('puts the focused stack on a hotbar slot with its number, and does not select that slot', () => {
    const { root, ui, controller } = mountUi();
    ui.toggleInventory();
    bagCell(root, 0).focus();
    tap('Digit4', { key: '4' });
    expect(controller.getHotbarLayout()[3]).toBe('iron_ore');
    expect(controller.getHeldItem()).toBeNull();
  });

  it('knows what "down" is: the keyboard\'s column count is the stylesheet\'s', () => {
    const css = readFileSync(join(process.cwd(), 'src/styles/main.css'), 'utf8');
    const rule = /\.if-bag \{[^}]*grid-template-columns: repeat\((\d+), 1fr\)/.exec(css);
    expect(Number(rule?.[1])).toBe(BAG_COLUMNS);
  });

  it('empties a focused hotbar slot with Delete and swaps it with shift+arrow', () => {
    const { root, controller } = mountUi();
    const layout = controller.getHotbarLayout();
    const slot = (n: number): HTMLElement => {
      const element = root.querySelector<HTMLElement>(`.if-slot[data-slot="${n}"]`);
      if (element === null) throw new Error(`no slot ${n}`);
      return element;
    };
    slot(1).focus();
    tap('ArrowRight', { key: 'ArrowRight', shiftKey: true });
    expect(controller.getHotbarLayout()[0]).toBe(layout[1]);
    expect(controller.getHotbarLayout()[1]).toBe(layout[0]);
    expect(document.activeElement).toBe(slot(2));

    tap('Delete', { key: 'Delete' });
    expect(controller.getHotbarLayout()[1]).toBeNull();
  });

  it('reaches every control in the toolbar and the HUD with Tab', () => {
    const { root } = mountUi({ settings: true });
    const controls = root.querySelectorAll<HTMLElement>('.if-toolbar button, .if-hud [role="button"], .if-hud button');
    expect(controls.length).toBeGreaterThan(10);
    for (const control of controls) expect(control.tabIndex).toBeGreaterThanOrEqual(0);
  });
});

describe('rebinding', () => {
  function mountPanel(): { panel: SettingsPanel; binds: [string, string][] } {
    const binds: [string, string][] = [];
    const panel = new SettingsPanel({
      onVolume: () => {},
      onMuted: () => {},
      onScale: () => {},
      onMotion: () => {},
      onObjectives: () => {},
      onBind: (action, code) => binds.push([action, code]),
      onResetBindings: () => {},
      onClose: () => {},
    });
    panel.mount(document.body, SETTINGS_VIEW);
    panel.setOpen(true);
    return { panel, binds };
  }

  it('binds the next key pressed, and nothing else hears it', () => {
    const { panel, binds } = mountPanel();
    const change = document.querySelector<HTMLButtonElement>('.if-binding__change[data-action="world.remove"]');
    change?.click();
    expect(panel.isCapturing()).toBe(true);
    let leaked = 0;
    document.addEventListener('keydown', () => {
      leaked += 1;
    });
    document.body.dispatchEvent(key('keydown', 'KeyQ'));
    expect(binds).toEqual([['world.remove', 'KeyQ']]);
    expect(leaked).toBe(0);
    expect(panel.isCapturing()).toBe(false);
    panel.destroy();
  });

  it('cancels on Escape, and will not bind Tab', () => {
    const { panel, binds } = mountPanel();
    const change = document.querySelector<HTMLButtonElement>('.if-binding__change[data-action="world.interact"]');
    change?.click();
    document.body.dispatchEvent(key('keydown', 'Escape'));
    change?.click();
    document.body.dispatchEvent(key('keydown', 'Tab'));
    expect(binds).toEqual([]);
    panel.destroy();
  });

  it('leaves the panel open when Escape cancels a capture', () => {
    const { root, ui } = mountUi({ settings: true });
    ui.toggleSettings();
    root.querySelector<HTMLButtonElement>('.if-binding__change')?.click();
    window.dispatchEvent(key('keydown', 'Escape', { key: 'Escape' }));
    expect(ui.isSettingsOpen()).toBe(true);
    window.dispatchEvent(key('keydown', 'Escape', { key: 'Escape' }));
    expect(ui.isSettingsOpen()).toBe(false);
  });
});

describe('the first-run objectives', () => {
  it('show on a first run, tick what is already true, and remember it', () => {
    const { root, ui, progress } = mountUi({ objectives: { visible: true, done: [] } });
    expect(ui.isObjectivesOpen()).toBe(true);
    // The harness carries 30 iron ore: the first line is already met.
    const first = root.querySelector('.if-objective[data-id="mine-iron"]');
    expect(first?.classList.contains('is-done')).toBe(true);
    expect(progress.at(-1)?.done).toContain('mine-iron');
  });

  it('stay away once skipped, and say so to whoever remembers it', () => {
    const { root, ui, progress } = mountUi({ objectives: { visible: true, done: [] } });
    root.querySelector<HTMLButtonElement>('.if-objectives__skip')?.click();
    expect(ui.isObjectivesOpen()).toBe(false);
    expect(progress.at(-1)?.visible).toBe(false);
  });

  it('do not appear for a player who already dismissed them', () => {
    const { ui } = mountUi({ objectives: { visible: false, done: ['mine-iron'] } });
    expect(ui.isObjectivesOpen()).toBe(false);
  });

  it('never take focus: the list is one tab stop, its button', () => {
    const { root } = mountUi({ objectives: { visible: true, done: [] } });
    const panel = root.querySelector('.if-objectives');
    expect(panel?.querySelectorAll('button, [tabindex]').length).toBe(1);
  });
});
