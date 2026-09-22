import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandProcessor } from '../../src/game/commands/command-processor.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST, NORTH, SOUTH, WEST, type TileCoord } from '../../src/game/world/coordinates.js';
import { createCheckerboardGenerator } from '../fixtures/world-fixtures.js';
import { World } from '../../src/game/world/world.js';
import { Camera } from '../../src/renderer/camera.js';
import {
  InputManager,
  MAX_LINE_TILES,
  beltLine,
  type CameraControl,
  type TilePicker,
} from '../../src/input/input-manager.js';
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

  /**
   * A stand-in for the projection (C10 task 2).
   *
   * Deliberately the identity, and kept as a double even though C27A made the
   * real one the identity too: what these tests check is that WASD becomes
   * exactly one command when the direction changes, not what the projection
   * does to it. The one test that does care uses `ProjectedCamera` below, and
   * it is what would fail if a projection with a rotation ever came back.
   */
  screenDirectionToWorld(dxPx: number, dyPx: number): { x: number; y: number } {
    return { x: dxPx, y: dyPx };
  }
}

/**
 * Ten pixels to a tile, so a screen coordinate reads as its tile at a glance.
 *
 * `entitiesAt` is C12's addition: the picker is what decides whether a pixel is
 * a machine or bare ground, and selection is now that answer rather than the
 * tile beside it. Tiles are named `"x,y"` and map to the entity id the pick
 * reports; everything not listed is ground.
 */
class GridPicker implements TilePicker {
  readonly entitiesAt = new Map<string, number>();

  pick(screenX: number, screenY: number): { tile: TileCoord; entityId: number | null } {
    const tile = { x: Math.floor(screenX / 10), y: Math.floor(screenY / 10) };
    return { tile, entityId: this.entitiesAt.get(`${tile.x},${tile.y}`) ?? null };
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
let picker: GridPicker;
let input: InputManager;

/**
 * Replace the fixture. Detaches first: the keyboard listens on `document`, so
 * a manager left attached keeps answering keys from the next test's events.
 */
/** The entity id `recipeOf` answers "nothing" for. See `mount`. */
const EMPTY_MACHINE = 41;

function mount(bindings = DEFAULT_KEYBINDINGS): void {
  input?.detach();
  canvas?.remove();
  canvas = document.createElement('canvas');
  document.body.append(canvas);
  camera = new FakeCamera();
  commands = new CommandProcessor();
  actions = [];
  picker = new GridPicker();
  input = new InputManager({
    canvas,
    keyTarget: document,
    camera,
    picker,
    commands,
    bindings,
    // C20's copy-settings needs one question answered about the world, and a
    // single function is the whole of what this layer is allowed to ask.
    // `EMPTY_MACHINE` stands for a machine that is making nothing.
    recipeOf: (entityId): string | null => (entityId === EMPTY_MACHINE ? null : 'make_gear'),
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

    // The release is a command too: mining is a *held* action, so the
    // simulation has to be told the button came up (C10 task 4).
    expect(queuedTiles()).toEqual(['3,8', 'stopMining']);
  });

  it('enqueues once per tile crossed by a drag, however many events arrive', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    // Sixty moves across three tiles: the cap (§7) is a backstop, the
    // de-duplication is the plan, and this is the plan being tested.
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(pointerEvent('pointermove', { x: 5 + i * 0.5, y: 5, buttons: BUTTONS_LEFT }));
    }
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 5, button: BUTTON_LEFT }));

    expect(queuedTiles()).toEqual(['0,0', '1,0', '2,0', '3,0', 'stopMining']);
  });

  it('stops the drag when the button is no longer down', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 15, y: 5, buttons: 0 }));
    canvas.dispatchEvent(pointerEvent('pointermove', { x: 25, y: 5, buttons: 0 }));

    expect(queuedTiles()).toEqual(['0,0', 'stopMining']);
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
    // Refused because the default player stands at the origin and (3, 8) is
    // nine tiles away (C10 task 4). The point of the assertion is unchanged
    // from C04: the outcome exists only after the tick, and it is visible.
    expect(simulation.commands.takeRejections()).toEqual([
      { command: { type: 'mineTile', x: 3, y: 8 }, reason: 'out_of_reach' },
    ]);
  });
});

/**
 * Selection. C12 task 4: click a machine to select it, click empty ground or
 * press Escape to deselect, and none of it is simulation state.
 */
describe('selection', () => {
  /** A machine at tile (3, 8), which is the pixel (35, 82) every test clicks. */
  const MACHINE = 7;

  beforeEach(() => {
    picker.entitiesAt.set('3,8', MACHINE);
  });

  it('follows the left button and is cleared by the right one', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selectedEntityId).toBe(MACHINE);
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 82, button: BUTTON_LEFT }));

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 0 }));
    expect(input.selectedEntityId).toBeNull();
  });

  it('is cleared by clicking bare ground', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerup', { x: 35, y: 82, button: BUTTON_LEFT }));
    expect(input.selectedEntityId).toBe(MACHINE);

    // (9, 9) has nothing on it, so the pick reports ground and the panel shuts.
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 95, y: 95, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selectedEntityId).toBeNull();
  });

  it('inspects a machine instead of mining the ground under it', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    // A miner always stands on ore, so without this rule every click on one
    // would also start digging the tile it is standing on.
    expect(input.selectedEntityId).toBe(MACHINE);
    expect(commands.pending).toBe(0);
  });

  it('ignores a second button pressed during a drag', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: BUTTONS_LEFT }));

    // Right-clicking mid-drag is a slip, not an instruction to deselect.
    expect(input.selectedEntityId).toBe(MACHINE);
  });

  it('is cleared by the bound action, not by a hard-coded Escape', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selectedEntityId).toBe(MACHINE);
    document.dispatchEvent(keyEvent('keydown', 'Escape'));
    expect(input.selectedEntityId).toBeNull();
  });
});

describe('the build tool', () => {
  // A four-rotation building placed **one tile at a time**. It was called
  // BELT until C13 made a belt the one thing that is not placed that way.
  const MINER = { buildingId: 'miner', rotationCount: 4, lineBuild: false } as const;

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
    input.setBuildTool(MINER);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    expect(queued()).toEqual(['build miner 3,8 r0']);
  });

  it('leaves the empty hand mining, which is C10s job', () => {
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(queued()).toEqual(['mineTile 3,8']);
  });

  it('places once per tile crossed by a drag, and never twice for one tile', () => {
    input.setBuildTool(MINER);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    for (const x of [7, 12, 14, 25]) {
      canvas.dispatchEvent(pointerEvent('pointermove', { x, y: 5, buttons: BUTTONS_LEFT }));
    }

    expect(queued()).toEqual(['build miner 0,0 r0', 'build miner 1,0 r0', 'build miner 2,0 r0']);
  });

  it('cycles rotation with the bound key, within the rotations the building has', () => {
    input.setBuildTool(MINER);
    for (const expected of [1, 2, 3, 0]) {
      press('KeyR');
      expect(input.buildRotation).toBe(expected);
    }

    input.setBuildTool({ buildingId: 'chest', rotationCount: 1, lineBuild: false });
    press('KeyR');
    expect(input.buildRotation).toBe(0);
  });

  it('builds with the rotation on screen', () => {
    input.setBuildTool(MINER);
    press('KeyR');
    press('KeyR');
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 5, y: 5, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

    expect(queued()).toEqual(['build miner 0,0 r2']);
  });

  it('rotates nothing when the hand is empty', () => {
    press('KeyR');
    expect(input.buildRotation).toBe(0);
    expect(input.buildTool).toBeNull();
  });

  it('keeps the rotation when the same building is re-selected and drops it otherwise', () => {
    input.setBuildTool(MINER);
    press('KeyR');

    input.setBuildTool({ ...MINER });
    expect(input.buildRotation).toBe(1);

    input.setBuildTool({ buildingId: 'chest', rotationCount: 1, lineBuild: false });
    expect(input.buildRotation).toBe(0);
  });

  it('puts the building down on the right button instead of demolishing', () => {
    input.setBuildTool(MINER);
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
    input.setBuildTool(MINER);
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

  /**
   * Copy-settings (C20 task 5): shift-right-click copies a machine's recipe,
   * shift-left-click pastes it.
   *
   * What this layer owns is the *gesture*, and the two things that could go
   * wrong with it are both about which click wins: a shift-right-click must
   * not be the click that demolishes, and a shift-left-click must not be the
   * click that places a building. Whether the paste is honoured is the
   * simulation's (§7) and is `hand-system.ts`'s to answer.
   */
  describe('copy-settings', () => {
    function shiftDown(): void {
      document.dispatchEvent(keyEvent('keydown', 'ShiftLeft'));
    }

    it('copies on shift-right-click and pastes on shift-left-click', () => {
      picker.entitiesAt.set('3,8', 7);
      picker.entitiesAt.set('5,8', 9);
      shiftDown();

      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 2 }));
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 55, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

      expect(commands.drain()).toEqual([{ type: 'setRecipe', entityId: 9, recipeId: 'make_gear' }]);
    });

    it('does not demolish the machine it copies from', () => {
      picker.entitiesAt.set('3,8', 7);
      shiftDown();
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 2 }));
      expect(commands.drain()).toEqual([]);
    });

    it('does not place a building on the click that pastes', () => {
      picker.entitiesAt.set('3,8', 7);
      input.setBuildTool(MINER);
      shiftDown();
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

      expect(commands.drain().map((command) => command.type)).toEqual(['setRecipe']);
    });

    it('pastes "nothing" when the copied machine was making nothing', () => {
      // Deliberate: it is the only way to tell a row of assemblers to stop
      // without opening every panel. `recipeOf` answering null is a *copy*,
      // not a failure to copy.
      picker.entitiesAt.set('3,8', EMPTY_MACHINE);
      picker.entitiesAt.set('5,8', 9);
      shiftDown();
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 2 }));
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 55, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

      expect(commands.drain()).toEqual([{ type: 'setRecipe', entityId: 9, recipeId: null }]);
    });

    it('leaves the clipboard alone when the copy click misses everything', () => {
      picker.entitiesAt.set('3,8', 7);
      picker.entitiesAt.set('5,8', 9);
      shiftDown();
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_RIGHT, buttons: 2 }));
      // Bare ground: a shift-right-click that missed must not silently empty
      // what the player copied a moment ago.
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 95, y: 92, button: BUTTON_RIGHT, buttons: 2 }));
      canvas.dispatchEvent(pointerEvent('pointerdown', { x: 55, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));

      expect(commands.drain()).toEqual([{ type: 'setRecipe', entityId: 9, recipeId: 'make_gear' }]);
    });
  });

  it('does not move the selection while placing', () => {
    picker.entitiesAt.set('3,8', 7);
    input.setBuildTool(MINER);
    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(input.selectedEntityId).toBeNull();
  });

  it('never touches simulation state: a held building still only enqueues', () => {
    const simulation = new Simulation({ world: new World(createCheckerboardGenerator()) });
    simulation.inventory.add('chest', 1);
    // Build range is eight tiles from the player (C10 task 5), and this test is
    // about the command path rather than about reach.
    simulation.player.setTilePosition(3, 8);
    input.detach();
    input = new InputManager({
      canvas,
      keyTarget: document,
      camera,
      picker: new GridPicker(),
      commands: simulation.commands,
    });
    input.attach();
    input.setBuildTool({ buildingId: 'chest', rotationCount: 1, lineBuild: false });

    canvas.dispatchEvent(pointerEvent('pointerdown', { x: 35, y: 82, button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
    expect(simulation.entities.size).toBe(0);

    simulation.tick();
    expect(simulation.entities.at(3, 8)).toBeDefined();
    expect(simulation.inventory.count('chest')).toBe(0);
  });
});

/**
 * Walking (C10 task 2).
 *
 * Two properties, and they are the reason the input layer does not simply send
 * a step per frame:
 *
 * - **One command per change of direction.** The simulation holds the
 *   direction and steps once per tick, so re-sending it every frame would fill
 *   the queue to say nothing.
 * - **The keys mean a direction on the screen.** WASD is named for the
 *   picture; the command carries tile space; the camera translates. Because the
 *   projection turns the grid 45 degrees, W alone is a *diagonal* tile move and
 *   W+D is a cardinal one — which is the part that is easy to get backwards, so
 *   `ProjectedCamera` below uses the real transform rather than the identity.
 */
describe('walking', () => {
  /** A camera double that unprojects the way the real one does. */
  class ProjectedCamera extends FakeCamera {
    private readonly real = new Camera({ viewportWidth: 100, viewportHeight: 100 });

    override screenDirectionToWorld(dxPx: number, dyPx: number): { x: number; y: number } {
      return this.real.screenDirectionToWorld(dxPx, dyPx);
    }
  }

  function walkCommands(): { dx: number; dy: number }[] {
    return commands
      .drain()
      .filter((c) => c.type === 'movePlayer')
      .map((c) => ({ dx: c.dx, dy: c.dy }));
  }

  it('sends one command when a key goes down and one when it comes up', () => {
    document.dispatchEvent(keyEvent('keydown', 'KeyS'));
    input.update(16);
    input.update(16);
    input.update(16);
    expect(walkCommands()).toEqual([{ dx: 0, dy: 1 }]);

    document.dispatchEvent(keyEvent('keyup', 'KeyS'));
    input.update(16);
    input.update(16);
    expect(walkCommands()).toEqual([{ dx: 0, dy: 0 }]);
  });

  it('sends nothing at all while no walk key is held', () => {
    input.update(16);
    input.update(16);
    expect(walkCommands()).toEqual([]);
  });

  it('stops walking when the window takes the keys away', () => {
    document.dispatchEvent(keyEvent('keydown', 'KeyD'));
    input.update(16);
    // The fixture's camera is the identity, so this is screen-right verbatim;
    // what the projection makes of it is the case below.
    expect(walkCommands()).toEqual([{ dx: 1, dy: 0 }]);

    globalThis.dispatchEvent(new Event('blur'));
    input.update(16);
    expect(walkCommands()).toEqual([{ dx: 0, dy: 0 }]);
  });

  it('turns screen directions into tile directions', () => {
    mount();
    input.detach();
    input = new InputManager({
      canvas,
      keyTarget: document,
      camera: new ProjectedCamera(),
      picker: new GridPicker(),
      commands,
    });
    input.attach();

    // Since C27A this is the identity, and that is the point of the chunk:
    // screen up *is* north, so W walks north. It is still routed through the
    // camera rather than hard-coded, because §4 forbids the input layer from
    // knowing the projection — the day one arrives that is not the identity,
    // this test is what says so.
    const cases: [readonly string[], { dx: number; dy: number }][] = [
      [['KeyW'], { dx: 0, dy: -1 }],
      [['KeyS'], { dx: 0, dy: 1 }],
      [['KeyD'], { dx: 1, dy: 0 }],
      [['KeyA'], { dx: -1, dy: 0 }],
      // Two keys together are a diagonal, which is the half that a naive sign
      // test on an unprojected vector gets wrong.
      [['KeyW', 'KeyD'], { dx: 1, dy: -1 }],
      [['KeyW', 'KeyA'], { dx: -1, dy: -1 }],
      [['KeyS', 'KeyD'], { dx: 1, dy: 1 }],
      [['KeyS', 'KeyA'], { dx: -1, dy: 1 }],
    ];

    for (const [keys, expected] of cases) {
      for (const code of keys) document.dispatchEvent(keyEvent('keydown', code));
      input.update(16);
      expect(walkCommands(), keys.join('+')).toEqual([expected]);
      for (const code of keys) document.dispatchEvent(keyEvent('keyup', code));
      input.update(16);
      commands.drain();
    }
  });

  it('cancels out when opposite keys are held, rather than picking one', () => {
    document.dispatchEvent(keyEvent('keydown', 'KeyW'));
    input.update(16);
    commands.drain();

    document.dispatchEvent(keyEvent('keydown', 'KeyS'));
    input.update(16);
    expect(walkCommands()).toEqual([{ dx: 0, dy: 0 }]);
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

/**
 * Drag-to-build belt lines. See ironflow.md C13 task 7.
 *
 * "Belts without drag-building are miserable to place", and the plan says so
 * in as many words. What makes it more than a convenience is the *rotation*:
 * a line laid one tile at a time faces whichever way the ghost happened to be
 * turned, so a player laying a run east and then south has to stop and press
 * R at the corner. The path decides instead, and the corner falls out of it.
 */
describe('laying a belt line', () => {
  const BELT = { buildingId: 'belt', rotationCount: 4, lineBuild: true } as const;

  /** Every command in the queue, as a short readable string. */
  function queued(): string[] {
    return commands.drain().map((c) => {
      if (c.type === 'build') return `build ${c.buildingId} ${c.x},${c.y} r${c.rotation}`;
      if (c.type === 'remove') return `remove ${c.x},${c.y}`;
      return c.type;
    });
  }

  /** Tile coordinates, in the picker's ten-pixel grid. */
  function at(tileX: number, tileY: number): { x: number; y: number } {
    return { x: tileX * 10 + 5, y: tileY * 10 + 5 };
  }

  describe('the path itself', () => {
    it('faces every tile at the next one, and the last at the one before it', () => {
      expect(beltLine({ x: 0, y: 0 }, { x: 3, y: 0 }, NORTH)).toEqual([
        { x: 0, y: 0, rotation: EAST },
        { x: 1, y: 0, rotation: EAST },
        { x: 2, y: 0, rotation: EAST },
        { x: 3, y: 0, rotation: EAST },
      ]);
    });

    it('keeps the held rotation for a path of one tile', () => {
      // A click with a belt held must place the belt the player can see under
      // the cursor, not one turned to face a direction they never dragged in.
      expect(beltLine({ x: 4, y: 4 }, { x: 4, y: 4 }, SOUTH)).toEqual([{ x: 4, y: 4, rotation: SOUTH }]);
    });

    it('turns the corner once, on the long axis first', () => {
      expect(beltLine({ x: 0, y: 0 }, { x: 3, y: 2 }, NORTH)).toEqual([
        { x: 0, y: 0, rotation: EAST },
        { x: 1, y: 0, rotation: EAST },
        { x: 2, y: 0, rotation: EAST },
        // The corner tile faces the second leg, which is what makes items go
        // round it rather than off the end of the first one.
        { x: 3, y: 0, rotation: SOUTH },
        { x: 3, y: 1, rotation: SOUTH },
        { x: 3, y: 2, rotation: SOUTH },
      ]);
    });

    it('walks the other axis first when that is the long one', () => {
      expect(beltLine({ x: 0, y: 0 }, { x: 1, y: 3 }, NORTH).map((s) => `${s.x},${s.y}`)).toEqual([
        '0,0',
        '0,1',
        '0,2',
        '0,3',
        '1,3',
      ]);
    });

    it('runs backwards as happily as forwards', () => {
      expect(beltLine({ x: 2, y: 2 }, { x: 0, y: 2 }, NORTH).map((s) => s.rotation)).toEqual([WEST, WEST, WEST]);
      expect(beltLine({ x: 2, y: 2 }, { x: 2, y: 0 }, EAST).map((s) => s.rotation)).toEqual([NORTH, NORTH, NORTH]);
    });

    it('never asks for more tiles than the burst limit allows', () => {
      expect(beltLine({ x: 0, y: 0 }, { x: 5000, y: 0 }, NORTH).length).toBe(MAX_LINE_TILES);
    });
  });

  describe('the drag', () => {
    it('lays one belt per tile, all facing the way the drag went', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(2, 0), buttons: BUTTONS_LEFT }));
      // The tile under the cursor is still a guess — it is what becomes the
      // corner if the player turns — so it waits for the drag to pass it.
      expect(queued()).toEqual(['build belt 0,0 r1', 'build belt 1,0 r1']);

      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(2, 0), button: BUTTON_LEFT, buttons: 0 }));
      expect(queued()).toEqual(['build belt 2,0 r1']);
    });

    it('places a single belt, facing the ghost, for a press that never moves', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(3, 3), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      // Nothing yet: a line commits on the move, so that the anchor tile is
      // never laid the wrong way round and immediately taken up again.
      expect(queued()).toEqual([]);

      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(3, 3), button: BUTTON_LEFT, buttons: 0 }));
      expect(queued()).toEqual(['build belt 3,3 r0']);
    });

    it('asks for each tile once however many times the pointer crosses it', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      for (const tile of [1, 2, 2, 1, 2, 2]) {
        canvas.dispatchEvent(pointerEvent('pointermove', { ...at(tile, 0), buttons: BUTTONS_LEFT }));
      }

      // The anchored path is recomputed on every move and almost all of it is
      // already asked for. Without the de-duplication every tile after the
      // first would come back 'occupied', one toast per frame (§7).
      expect(queued()).toEqual(['build belt 0,0 r1', 'build belt 1,0 r1']);
    });

    it('turns the corner without ever taking a belt up again', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(2, 0), buttons: BUTTONS_LEFT }));
      expect(queued()).toEqual(['build belt 0,0 r1', 'build belt 1,0 r1']);

      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(2, 2), buttons: BUTTONS_LEFT }));
      // (2,0) is the corner, and it is laid facing **south** the first time
      // it is laid at all — there is no `remove` here, which is the whole
      // point of holding the last tile back. A remove and a build in the same
      // tick cannot work: C05 defers removal to cleanup, so the build would be
      // refused as 'occupied' and the corner would be a hole.
      expect(queued()).toEqual(['build belt 2,0 r2', 'build belt 2,1 r2']);
    });

    it('lays the L the drag drew, and not the rectangle around it', () => {
      // The reported bug: a drag east and then south built all four sides.
      // A path recomputed from the *anchor* changes shape as the cursor moves
      // — the long-axis rule flips the corner to the other side of the
      // rectangle the moment the drag is taller than it is wide — and since a
      // tile once asked for is never taken back, both routes got built.
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      // Deliberately taller than it is wide, so the anchored path's long axis
      // flips from x to y partway down the second leg — the exact moment the
      // old code started building the opposite two sides.
      const route = [
        [1, 0], [2, 0], [3, 0],
        [3, 1], [3, 2], [3, 3], [3, 4], [3, 5],
      ] as const;
      for (const [x, y] of route) {
        canvas.dispatchEvent(pointerEvent('pointermove', { ...at(x, y), buttons: BUTTONS_LEFT }));
      }
      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(3, 5), button: BUTTON_LEFT, buttons: 0 }));

      expect(queued()).toEqual([
        'build belt 0,0 r1',
        'build belt 1,0 r1',
        'build belt 2,0 r1',
        // The corner, laid facing south the first time it is laid at all.
        'build belt 3,0 r2',
        'build belt 3,1 r2',
        'build belt 3,2 r2',
        'build belt 3,3 r2',
        'build belt 3,4 r2',
        'build belt 3,5 r2',
      ]);
    });

    it('lays one clean L when the cursor jumps the whole way in one move', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(3, 2), buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(3, 2), button: BUTTON_LEFT, buttons: 0 }));

      expect(queued()).toEqual([
        'build belt 0,0 r1',
        'build belt 1,0 r1',
        'build belt 2,0 r1',
        'build belt 3,0 r2',
        'build belt 3,1 r2',
        'build belt 3,2 r2',
      ]);
    });

    it('lays nothing new when the drag retraces its own line', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      for (const [x, y] of [[1, 0], [2, 0], [3, 0]] as const) {
        canvas.dispatchEvent(pointerEvent('pointermove', { ...at(x, y), buttons: BUTTONS_LEFT }));
      }
      expect(queued()).toEqual(['build belt 0,0 r1', 'build belt 1,0 r1', 'build belt 2,0 r1']);

      // Back along the line it just laid. Nothing is asked for: extending into
      // a tile already laid would put a belt at the head facing backwards,
      // nose to nose with the run behind it.
      for (const [x, y] of [[2, 0], [1, 0], [0, 0]] as const) {
        canvas.dispatchEvent(pointerEvent('pointermove', { ...at(x, y), buttons: BUTTONS_LEFT }));
      }
      expect(queued()).toEqual([]);
    });

    it('never enqueues a remove, however the drag wanders', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      for (const tile of [[2, 0], [2, 2], [1, 2], [0, 0], [3, 1], [3, 3]] as const) {
        canvas.dispatchEvent(pointerEvent('pointermove', { ...at(tile[0], tile[1]), buttons: BUTTONS_LEFT }));
      }
      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(3, 3), button: BUTTON_LEFT, buttons: 0 }));

      const all = queued();
      expect(all.every((c) => c.startsWith('build belt'))).toBe(true);
      // And never the same tile twice, whatever route the cursor took.
      const tiles = all.map((c) => c.split(' ')[2]);
      expect(new Set(tiles).size).toBe(tiles.length);
      // Only tiles the cursor actually walked through, in the box it stayed
      // inside: a wandering drag must not fill anything in.
      for (const tile of tiles) {
        const [x, y] = (tile ?? '').split(',').map(Number);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(3);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(3);
      }
    });

    it('leaves the held rotation following the line, so the next click continues it', () => {
      input.setBuildTool(BELT);
      expect(input.buildRotation).toBe(NORTH);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(0, 3), buttons: BUTTONS_LEFT }));

      expect(input.buildRotation).toBe(SOUTH);
    });

    it('starts a fresh line on the next press rather than extending the last one', () => {
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(2, 0), buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointerup', { ...at(2, 0), button: BUTTON_LEFT, buttons: 0 }));
      queued();

      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(5, 5), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(6, 5), buttons: BUTTONS_LEFT }));
      expect(queued()).toEqual(['build belt 5,5 r1']);
    });

    it('changes nothing about the world by itself: every tile is a command', () => {
      // C04's standing criterion, restated for the one gesture that enqueues
      // more than one command at a time (§19 rule 16).
      input.setBuildTool(BELT);
      canvas.dispatchEvent(pointerEvent('pointerdown', { ...at(0, 0), button: BUTTON_LEFT, buttons: BUTTONS_LEFT }));
      canvas.dispatchEvent(pointerEvent('pointermove', { ...at(4, 3), buttons: BUTTONS_LEFT }));

      for (const command of commands.drain()) {
        expect(command.type).toBe('build');
      }
    });
  });
});
