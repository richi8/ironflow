import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandProcessor } from '../../src/game/commands/command-processor.js';
import { Simulation } from '../../src/game/simulation.js';
import type { TileCoord } from '../../src/game/world/coordinates.js';
import { createCheckerboardGenerator } from '../../src/game/world/world-generator.js';
import { World } from '../../src/game/world/world.js';
import { InputManager, type CameraControl, type TilePicker } from '../../src/input/input-manager.js';
import { DEFAULT_KEYBINDINGS, rebind, type InputAction } from '../../src/input/keybindings.js';
import { BUTTONS_LEFT, BUTTONS_MIDDLE, BUTTON_LEFT, BUTTON_MIDDLE, BUTTON_RIGHT } from '../../src/input/mouse-input.js';

/**
 * The input layer. See ironflow.md C04.
 *
 * The criteria this file carries, in the order the chunk states them:
 *
 * - drag-panning and wheel-zoom are frame-rate independent;
 * - **no DOM event handler mutates simulation state** — every path that could
 *   goes through a command, and a command does nothing until a tick runs;
 * - a held-down drag never enqueues more than one command per tile;
 * - keybindings are data and can be remapped without touching handler code.
 *
 * It runs in jsdom, which has no `PointerEvent` and no pointer capture. Both
 * absences are the reason `MouseInput` reads only the five fields synthesised
 * below and calls `setPointerCapture` optionally — a test DOM is a cheap
 * stand-in for the older engines that are missing the same things.
 */

/* -------------------------------------------------------------------------- *
 * Doubles
 * -------------------------------------------------------------------------- */

class FakeCamera implements CameraControl {
  panX = 0;
  panY = 0;
  panCalls = 0;
  zooms: { x: number; y: number; steps: number }[] = [];

  pan(dxPx: number, dyPx: number): void {
    this.panX += dxPx;
    this.panY += dyPx;
    this.panCalls += 1;
  }

  zoomAt(x: number, y: number, steps: number): void {
    this.zooms.push({ x, y, steps });
  }
}

/** Ten pixels to a tile, so a screen coordinate reads as its tile at a glance. */
class GridPicker implements TilePicker {
  pick(screenX: number, screenY: number): { tile: TileCoord; entityId: number | null } {
    return { tile: { x: Math.floor(screenX / 10), y: Math.floor(screenY / 10) }, entityId: null };
  }
}

function pointerEvent(type: string, init: Partial<PointerSampleInit> = {}): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
  return event;
}

interface PointerSampleInit {
  x: number;
  y: number;
  button: number;
  buttons: number;
  pointerId: number;
}

function wheelEvent(init: { x?: number; y?: number; deltaY: number; ctrlKey?: boolean; deltaMode?: number }): Event {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: init.x ?? 0,
    clientY: init.y ?? 0,
    deltaY: init.deltaY,
    deltaMode: init.deltaMode ?? 0,
    ctrlKey: init.ctrlKey ?? false,
  });
  return event;
}

function keyEvent(type: string, code: string, extra: { repeat?: boolean } = {}): Event {
  return new KeyboardEvent(type, { bubbles: true, cancelable: true, code, repeat: extra.repeat ?? false });
}

/* -------------------------------------------------------------------------- *
 * Fixture
 * -------------------------------------------------------------------------- */

let canvas: HTMLCanvasElement;
let camera: FakeCamera;
let commands: CommandProcessor;
let actions: [InputAction, 'down' | 'up'][];
let input: InputManager;

/**
 * Replace the fixture. Detaches first: the keyboard listens on `document`, so
 * a manager left attached keeps answering keys from the next test's events.
 */
function mount(bindings = DEFAULT_KEYBINDINGS): void {
  input?.detach();
  canvas?.remove();
  canvas = document.createElement('canvas');
  document.body.append(canvas);
  camera = new FakeCamera();
  commands = new CommandProcessor();
  actions = [];
  input = new InputManager({
    canvas,
    keyTarget: document,
    camera,
    picker: new GridPicker(),
    commands,
    bindings,
    onAction: (action, phase) => actions.push([action, phase]),
  });
  input.attach();
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  input.detach();
  canvas.remove();
});



/** Every mineTile command sitting in the queue, as `x,y` strings. */
function queuedTiles(): string[] {
  return commands.drain().map((c) => (c.type === 'mineTile' ? `${c.x},${c.y}` : c.type));
}

/* -------------------------------------------------------------------------- *
 * Tests
 * -------------------------------------------------------------------------- */

describe('camera dragging', () => {
  it('pans by the pointer delta on the middle button', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, button: BUTTON_MIDDLE, buttons: BUTTONS_MIDDLE }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 130, y: 80, buttons: BUTTONS_MIDDLE }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 130, y: 80, button: BUTTON_MIDDLE }));

    expect(camera.panX).toBe(30);
    expect(camera.panY).toBe(-20);
    expect(input.isDraggingCamera).toBe(false);
  });

  it('pans on a left drag only while the drag modifier is held', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 140, y: 100, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 140, y: 100, button: BUTTON_LEFT }));
    expect(camera.panX).toBe(0);

    document.dispatchEvent(keyEvent('keydown', 'Space'));
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 100, y: 100, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.isDraggingCamera).toBe(true);
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 140, y: 100, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 140, y: 100, button: BUTTON_LEFT }));

    expect(camera.panX).toBe(40);
  });

  it('is frame-rate independent: the pan follows the pointer, not the frames', () => {
    // One big move and ten small ones covering the same distance must land the
    // camera in the same place. Panning driven by anything but the delta —
    // a per-frame constant, an accumulated velocity — fails this.
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, button: BUTTON_MIDDLE, buttons: BUTTONS_MIDDLE }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 100, y: 50, buttons: BUTTONS_MIDDLE }));
    const oneStep = { x: camera.panX, y: camera.panY };
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 100, y: 50, button: BUTTON_MIDDLE }));

    mount();
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, button: BUTTON_MIDDLE, buttons: BUTTONS_MIDDLE }));
    for (let i = 1; i <= 10; i++) {
      canvas.dispatchEvent(pointerEvent('pointermove', { x: i * 10, y: i * 5, buttons: BUTTONS_MIDDLE }));
    }
    expect({ x: camera.panX, y: camera.panY }).toEqual(oneStep);
  });

  it('stops panning when the button is released off-canvas', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 0, y: 0, button: BUTTON_MIDDLE, buttons: BUTTONS_MIDDLE }));
    canvas.dispatchEvent(pointerEvent('pointercancel', { x: 20, y: 0, button: BUTTON_MIDDLE }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 200, y: 0, buttons: 0 }));

    expect(camera.panX).toBe(0);
  });
});

describe('zooming', () => {
  it('zooms at the cursor and swallows the browser gesture', () => {
    const event = wheelEvent({ x: 210, y: 120, deltaY: -100 });
    canvas.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(camera.zooms).toEqual([{ x: 210, y: 120, steps: 1 }]);
  });

  it('treats ctrl+wheel as a trackpad pinch, not a page zoom', () => {
    canvas.dispatchEvent(wheelEvent({ deltaY: -30, ctrlKey: true }));
    canvas.dispatchEvent(wheelEvent({ deltaY: -30 }));

    // The same delta is a whole notch of pinch and less than a third of a
    // wheel notch — the platform convention, and why they cannot share a scale.
    expect(camera.zooms[0]?.steps).toBe(1);
    expect(camera.zooms[1]?.steps).toBeCloseTo(0.3, 6);
  });

  it('normalises the line-mode deltas Firefox sends', () => {
    canvas.dispatchEvent(wheelEvent({ deltaY: -3, deltaMode: 1 }));
    expect(camera.zooms[0]?.steps).toBeCloseTo(0.48, 6);
  });

  it('caps a momentum spike instead of teleporting the camera', () => {
    canvas.dispatchEvent(wheelEvent({ deltaY: -100000 }));
    expect(camera.zooms[0]?.steps).toBe(4);
  });
});

describe('the canvas belongs to the game', () => {
  it('prevents the context menu', () => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('prevents the default for bound keys and leaves unbound ones alone', () => {
    const bound = keyEvent('keydown', 'ArrowLeft');
    document.dispatchEvent(bound);
    expect(bound.defaultPrevented).toBe(true);

    const unbound = keyEvent('keydown', 'KeyQ');
    document.dispatchEvent(unbound);
    expect(unbound.defaultPrevented).toBe(false);
  });
});

describe('hover', () => {
  it('tracks the pointer and clears when it leaves', () => {
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 35, y: 82 }));
    expect(input.hover).toEqual({ x: 3, y: 8 });

    canvas.dispatchEvent(pointerEvent('pointerleave', {}));
    expect(input.hover).toBeNull();
  });

  it('is re-resolved every frame, because the camera can move without the pointer', () => {
    const picker = new GridPicker();
    const spy = vi.spyOn(picker, 'pick');
    input.detach();
    input = new InputManager({ canvas, keyTarget: document, camera, picker, commands });
    input.attach();


    canvas.dispatchEvent(pointerEvent('pointermove', { x: 35, y: 82 }));
    const afterMove = spy.mock.calls.length;
    input.update(16);
    expect(spy.mock.calls.length).toBeGreaterThan(afterMove);
  });
});

describe('commands', () => {
  it('enqueues one mineTile per click, at the hovered tile', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 82, button: BUTTON_LEFT }));

    expect(queuedTiles()).toEqual(['3,8']);
  });

  it('enqueues once per tile crossed by a drag, however many events arrive', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    // Sixty moves across three tiles: the cap (§7) is a backstop, the
    // de-duplication is the plan, and this is the plan being tested.
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(pointerEvent('pointermove', { x: 5 + i * 0.5, y: 5, buttons: BUTTONS_LEFT }));
    }
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 5, button: BUTTON_LEFT }));

    expect(queuedTiles()).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('stops the drag when the button is no longer down', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 15, y: 5, buttons: 0 }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 25, y: 5, buttons: 0 }));

    expect(queuedTiles()).toEqual(['0,0']);
  });

  it('enqueues nothing at all for a camera drag', () => {
    document.dispatchEvent(keyEvent('keydown', 'Space'));
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 95, y: 95, buttons: BUTTONS_LEFT }));

    expect(queuedTiles()).toEqual([]);
  });

  it('never mutates simulation state from a handler: only a tick does that', () => {
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()) });
    input.detach();
    input = new InputManager({
      canvas,
      keyTarget: document,
      camera,
      picker: new GridPicker(),
      commands: simulation.commands,
    });
    input.attach();

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    // The command is waiting, nothing has happened, and no reason has been
    // produced — because no tick has run.
    expect(simulation.commands.pending).toBe(1);
    expect(simulation.getTick()).toBe(0);
    expect(simulation.commands.takeRejections()).toHaveLength(0);

    simulation.tick();

    expect(simulation.commands.pending).toBe(0);
    // C04 ships no effects, so the honest outcome is a visible refusal.
    expect(simulation.commands.takeRejections()).toEqual([
      { command: { type: 'mineTile', x: 3, y: 8 }, reason: 'not_implemented' },
    ]);
  });
});

describe('selection', () => {
  it('follows the left button and is cleared by the right one', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selected).toEqual({ x: 3, y: 8 });
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 82, button: BUTTON_LEFT }));

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 0 }));
    expect(input.selected).toBeNull();
  });

  it('ignores a second button pressed during a drag', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: BUTTONS_LEFT }));

    // Right-clicking mid-drag is a slip, not an instruction to deselect.
    expect(input.selected).toEqual({ x: 3, y: 8 });
  });

  it('is cleared by the bound action, not by a hard-coded Escape', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    document.dispatchEvent(keyEvent('keydown', 'Escape'));
    expect(input.selected).toBeNull();
  });
});

describe('the build tool', () => {
  const BELT = { buildingId: 'belt', rotationCount: 4 } as const;

  /**
   * A full press. `KeyboardInput` suppresses a second `keydown` without an
   * intervening `keyup`, because that is what an auto-repeating key looks like
   * — and a held R must not spin the ghost at the keyboard's repeat rate.
   */
  function press(code: string): void {
    document.dispatchEvent(keyEvent('keydown', code));
    document.dispatchEvent(keyEvent('keyup', code));
  }

  /** Every command in the queue, as a short readable string. */
  function queued(): string[] {
    return commands.drain().map((c) => {
      if (c.type === 'build') return `build ${c.buildingId} ${c.x},${c.y} r${c.rotation}`;
      if (c.type === 'remove') return `remove ${c.x},${c.y}`;
      return `${c.type} ${c.type === 'mineTile' ? `${c.x},${c.y}` : ''}`.trim();
    });
  }

  it('turns the left button into a build command while a building is held', () => {
    input.setBuildTool(BELT);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    expect(queued()).toEqual(['build belt 3,8 r0']);
  });

  it('leaves the empty hand mining, which is C10s job', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(queued()).toEqual(['mineTile 3,8']);
  });

  it('places once per tile crossed by a drag, and never twice for one tile', () => {
    input.setBuildTool(BELT);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    for (const x of [7, 12, 14, 25]) {
      canvas.dispatchEvent(pointerEvent('pointermove', { x, y: 5, buttons: BUTTONS_LEFT }));
    }

    expect(queued()).toEqual(['build belt 0,0 r0', 'build belt 1,0 r0', 'build belt 2,0 r0']);
  });

  it('cycles rotation with the bound key, within the rotations the building has', () => {
    input.setBuildTool(BELT);
    for (const expected of [1, 2, 3, 0]) {
      press('KeyR');
      expect(input.buildRotation).toBe(expected);
    }

    input.setBuildTool({ buildingId: 'chest', rotationCount: 1 });
    press('KeyR');
    expect(input.buildRotation).toBe(0);
  });

  it('builds with the rotation on screen', () => {
    input.setBuildTool(BELT);
    press('KeyR');
    press('KeyR');
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    expect(queued()).toEqual(['build belt 0,0 r2']);
  });

  it('rotates nothing when the hand is empty', () => {
    press('KeyR');
    expect(input.buildRotation).toBe(0);
    expect(input.buildTool).toBeNull();
  });

  it('keeps the rotation when the same building is re-selected and drops it otherwise', () => {
    input.setBuildTool(BELT);
    press('KeyR');

    input.setBuildTool({ ...BELT });
    expect(input.buildRotation).toBe(1);

    input.setBuildTool({ buildingId: 'chest', rotationCount: 1 });
    expect(input.buildRotation).toBe(0);
  });

  it('puts the building down on the right button instead of demolishing', () => {
    input.setBuildTool(BELT);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 0 }));

    expect(input.buildTool).toBeNull();
    // Nothing was demolished: the click that cancels a ghost must never be the
    // click that removes what is underneath it.
    expect(queued()).toEqual([]);
  });

  it('demolishes on the right button when the hand is empty', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 0 }));
    expect(queued()).toEqual(['remove 3,8']);
  });

  it('is dropped by the same key that clears a selection', () => {
    input.setBuildTool(BELT);
    document.dispatchEvent(keyEvent('keydown', 'Escape'));
    expect(input.buildTool).toBeNull();
  });

  it('forwards the slot hotkeys, because only the composition root knows the content', () => {
    press('Digit1');
    press('Digit9');

    expect(actions.filter(([, phase]) => phase === 'down').map(([action]) => action)).toEqual([
      'build.slot1',
      'build.slot9',
    ]);
    // The manager itself holds nothing: what slot 1 means is content.
    expect(input.buildTool).toBeNull();
  });

  it('does not move the selection while placing', () => {
    input.setBuildTool(BELT);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selected).toBeNull();
  });

  it('never touches simulation state: a held building still only enqueues', () => {
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()) });
    simulation.items.add('chest', 1);
    input.detach();
    input = new InputManager({
      canvas,
      keyTarget: document,
      camera,
      picker: new GridPicker(),
      commands: simulation.commands,
    });
    input.attach();
    input.setBuildTool({ buildingId: 'chest', rotationCount: 1 });

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(simulation.entities.size).toBe(0);

    simulation.tick();
    expect(simulation.entities.at(3, 8)).toBeDefined();
    expect(simulation.items.count('chest')).toBe(0);
  });
});

describe('keyboard camera control', () => {
  it('pans at a constant speed regardless of frame length', () => {
    document.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));

    input.update(100);
    const oneFrame = camera.panX;

    camera.panX = 0;
    for (let i = 0; i < 10; i++) input.update(10);

    expect(camera.panX).toBeCloseTo(oneFrame, 9);
    expect(oneFrame).toBeGreaterThan(0);
  });

  it('moves diagonally at the same speed as straight', () => {
    document.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    input.update(100);
    const straight = Math.hypot(camera.panX, camera.panY);

    mount();
    document.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    document.dispatchEvent(keyEvent('keydown', 'ArrowUp'));
    input.update(100);

    expect(Math.hypot(camera.panX, camera.panY)).toBeCloseTo(straight, 9);
  });

  it('stops when the key is released, and when the window loses focus', () => {
    document.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    document.dispatchEvent(keyEvent('keyup', 'ArrowLeft'));
    input.update(100);
    expect(camera.panX).toBe(0);

    // A key held while the window blurs never sends its keyup, and the camera
    // would pan forever after an alt-tab.
    document.dispatchEvent(keyEvent('keydown', 'ArrowRight'));
    globalThis.dispatchEvent(new Event('blur'));
    input.update(100);
    expect(camera.panX).toBe(0);
  });

  it('credits a long stall with one frame, not with the whole stall', () => {
    document.dispatchEvent(keyEvent('keydown', 'ArrowLeft'));
    input.update(100);
    const capped = camera.panX;

    camera.panX = 0;
    input.update(60_000);
    expect(camera.panX).toBe(capped);
  });
});

describe('keybindings are data', () => {
  it('acts on a rebound key without any handler changing', () => {
    mount(rebind(rebind(DEFAULT_KEYBINDINGS, 'F3', null), 'KeyP', 'debug.toggleOverlay'));

    document.dispatchEvent(keyEvent('keydown', 'KeyP'));
    expect(actions).toContainEqual(['debug.toggleOverlay', 'down']);

    actions.length = 0;
    document.dispatchEvent(keyEvent('keydown', 'F3'));
    expect(actions).toEqual([]);
  });

  it('swaps the whole map at runtime', () => {
    input.setBindings(rebind(DEFAULT_KEYBINDINGS, 'KeyZ', 'camera.panLeft'));
    document.dispatchEvent(keyEvent('keydown', 'KeyZ'));
    input.update(16);

    expect(camera.panX).toBeGreaterThan(0);
  });

  it('reports a press once, however many auto-repeats the OS sends', () => {
    document.dispatchEvent(keyEvent('keydown', 'Escape'));
    document.dispatchEvent(keyEvent('keydown', 'Escape', { repeat: true }));
    document.dispatchEvent(keyEvent('keydown', 'Escape', { repeat: true }));

    expect(actions.filter(([action]) => action === 'selection.clear')).toEqual([['selection.clear', 'down']]);
  });

  it('leaves keys alone while the player is typing', () => {
    const field = document.createElement('input');
    document.body.append(field);

    field.dispatchEvent(keyEvent('keydown', 'Space'));
    expect(actions).toEqual([]);

    field.remove();
  });
});
