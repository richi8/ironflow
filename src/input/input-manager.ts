/**
 * Browser input to camera moves and commands. See ironflow.md C04 and §7.
 *
 * This is the layer's only stateful piece: it owns what is hovered, what is
 * selected, and which drag is in progress. Everything it does falls into
 * exactly two categories, and the split is the chunk's whole point:
 *
 * - **View changes** — pan, zoom, hover, selection — are applied directly.
 *   None of them is authoritative state (§10), none is serialized, and none is
 *   a command. Sending a pan through the command queue would put camera
 *   smoothing on a 30 Hz clock and make the view stutter for no gain.
 * - **Anything that would change the world** becomes a `Command` handed to a
 *   `CommandSink`, and nothing else. No handler in this layer touches the
 *   simulation — it cannot: the only simulation object it holds is a sink with
 *   one method on it.
 *
 * ## What it is allowed to know
 *
 * §4 forbids `input/` from importing `renderer/`, so the camera and the picker
 * arrive as the two interfaces below. `Camera` and `ScenePicker` satisfy them
 * structurally and the composition root does the wiring. That is not ceremony:
 * it is what keeps a pan from reaching into a draw call, and it is why this
 * file's tests need neither a canvas nor a projection.
 */

import type { CommandSink } from '../game/commands/command-processor.js';
import type { TileCoord } from '../game/world/coordinates.js';

import { KeyboardInput } from './keyboard-input.js';
import { DEFAULT_KEYBINDINGS, type InputAction, type KeyBindings } from './keybindings.js';
import {
  BUTTONS_LEFT,
  BUTTON_LEFT,
  BUTTON_MIDDLE,
  BUTTON_RIGHT,
  MouseInput,
  type PointerSample,
} from './mouse-input.js';

/**
 * The view, as the input layer is allowed to see it.
 *
 * Three methods, all of them "move the picture". Satisfied by `Camera`; there
 * is deliberately no way to read the camera's position back, because nothing
 * here needs it and the ones that might — a minimap, a follow-cam — belong to
 * the chunks that add them.
 */
export interface CameraControl {
  pan(dxPx: number, dyPx: number): void;
  zoomAt(screenX: number, screenY: number, steps: number): void;
}

/** What is under a pixel. Satisfied by `renderer/picker.ts`'s `ScenePicker`. */
export interface ScenePickResult {
  readonly tile: TileCoord;
  readonly entityId: number | null;
}

export interface TilePicker {
  pick(screenX: number, screenY: number): ScenePickResult;
}

export interface InputManagerOptions {
  readonly canvas: HTMLCanvasElement;
  /** Where keyboard events are listened for. Usually `document`. */
  readonly keyTarget: EventTarget;
  readonly camera: CameraControl;
  readonly picker: TilePicker;
  readonly commands: CommandSink;
  readonly bindings?: KeyBindings;
  /**
   * Actions this manager does not handle itself, forwarded verbatim.
   *
   * `debug.toggleOverlay` is the only one today. The alternative — giving the
   * manager a `DebugOverlay` — would put a `debug/` import in `input/` for one
   * boolean, and would be the first crack in "input produces intent, something
   * else decides what it means".
   */
  readonly onAction?: (action: InputAction, phase: 'down' | 'up') => void;
}

/** Keyboard pan speed, in CSS pixels per second. About a screen every 1.5 s. */
const KEY_PAN_PIXELS_PER_SECOND = 900;

/** Zoom notches per second while a zoom key is held. */
const KEY_ZOOM_STEPS_PER_SECOND = 3;

/** Longest frame a held key is credited with, so an alt-tab does not lurch. */
const MAX_KEY_STEP_MS = 100;

/** Set while the camera is being dragged, so the cursor can say so. */
const DRAGGING_CLASS = 'is-dragging';

type DragKind = 'camera' | 'mine';

interface Drag {
  readonly pointerId: number;
  readonly kind: DragKind;
  lastX: number;
  lastY: number;
}

export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly camera: CameraControl;
  private readonly picker: TilePicker;
  private readonly commands: CommandSink;
  private readonly onAction: InputManagerOptions['onAction'];
  private readonly mouse: MouseInput;
  private readonly keyboard: KeyboardInput;

  private drag: Drag | null = null;
  private pointerX: number | null = null;
  private pointerY: number | null = null;
  private hovered: TileCoord | null = null;
  private hoveredEntity: number | null = null;
  private selectedTile: TileCoord | null = null;
  /** The tile the current mine-drag last enqueued for. See `mineAt`. */
  private lastMined: TileCoord | null = null;

  constructor(options: InputManagerOptions) {
    this.canvas = options.canvas;
    this.camera = options.camera;
    this.picker = options.picker;
    this.commands = options.commands;
    this.onAction = options.onAction;

    this.mouse = new MouseInput(options.canvas, {
      onPointerDown: (sample) => this.handleDown(sample),
      onPointerMove: (sample) => this.handleMove(sample),
      onPointerUp: (sample) => this.handleUp(sample),
      onPointerExit: () => this.handleExit(),
      onZoom: (x, y, steps) => this.camera.zoomAt(x, y, steps),
    });

    this.keyboard = new KeyboardInput({
      target: options.keyTarget,
      bindings: options.bindings ?? DEFAULT_KEYBINDINGS,
      onAction: (action, phase) => this.handleAction(action, phase),
    });
  }

  attach(): void {
    this.mouse.attach();
    this.keyboard.attach();
  }

  detach(): void {
    this.mouse.detach();
    this.keyboard.detach();
    this.endDrag();
  }

  /** The tile under the cursor, or null when the pointer is off the canvas. */
  get hover(): TileCoord | null {
    return this.hovered;
  }

  /** The entity under the cursor, if the cursor is on one rather than on ground. */
  get hoverEntity(): number | null {
    return this.hoveredEntity;
  }

  /** The last tile clicked. Presentation state; C12's inspector reads it. */
  get selected(): TileCoord | null {
    return this.selectedTile;
  }

  /** True while the camera is being dragged. For the debug readout. */
  get isDraggingCamera(): boolean {
    return this.drag?.kind === 'camera';
  }

  setBindings(bindings: KeyBindings): void {
    this.keyboard.setBindings(bindings);
  }

  /**
   * Advance held-key motion and re-resolve hover. Once per rendered frame.
   *
   * Both halves have to happen here rather than in an event handler. Keyboard
   * panning is continuous, so it must be integrated against real elapsed time
   * or it would run at whatever rate the browser chooses to repeat keys — the
   * frame-rate independence the acceptance criteria ask for. Hover has to be
   * recomputed because the camera can move without the pointer moving: during
   * a zoom ease, under a keyboard pan, and on every frame of a drag, the tile
   * under a stationary cursor changes.
   */
  update(dtMs: number): void {
    const step = Math.min(Math.max(dtMs, 0), MAX_KEY_STEP_MS);
    if (step > 0) {
      this.applyHeldKeys(step);
    }
    this.refreshHover();
  }

  /* ---------------------------------------------------------------- *
   * Pointer
   * ---------------------------------------------------------------- */

  private handleDown(sample: PointerSample): void {
    this.pointerX = sample.x;
    this.pointerY = sample.y;
    this.refreshHover();

    if (this.drag !== null) return; // a second button during a drag is ignored

    // Middle button, or left button with the drag modifier held. The left
    // button on its own belongs to the game (C04 task 4), which is why the
    // space-drag alternative exists at all: a trackpad has no middle button.
    const isCameraDrag =
      sample.button === BUTTON_MIDDLE ||
      (sample.button === BUTTON_LEFT && this.keyboard.isHeld('camera.dragModifier'));

    if (isCameraDrag) {
      this.beginDrag(sample, 'camera');
      return;
    }

    if (sample.button === BUTTON_LEFT) {
      this.beginDrag(sample, 'mine');
      this.selectedTile = this.hovered;
      this.lastMined = null;
      this.mineAt(this.hovered);
      return;
    }

    if (sample.button === BUTTON_RIGHT) {
      this.selectedTile = null;
    }
  }

  private handleMove(sample: PointerSample): void {
    this.pointerX = sample.x;
    this.pointerY = sample.y;

    const drag = this.drag;
    if (drag === null || drag.pointerId !== sample.pointerId) {
      this.refreshHover();
      return;
    }

    const dx = sample.x - drag.lastX;
    const dy = sample.y - drag.lastY;
    drag.lastX = sample.x;
    drag.lastY = sample.y;

    if (drag.kind === 'camera') {
      this.camera.pan(dx, dy);
      this.refreshHover();
      return;
    }

    // A mine drag. The button may have been released outside the canvas and
    // the release event lost; `buttons` is the authority on what is still down.
    if ((sample.buttons & BUTTONS_LEFT) === 0) {
      this.endDrag();
      this.refreshHover();
      return;
    }

    this.refreshHover();
    this.mineAt(this.hovered);
  }

  private handleUp(sample: PointerSample): void {
    if (this.drag?.pointerId !== sample.pointerId) return;
    this.endDrag();
  }

  private handleExit(): void {
    this.pointerX = null;
    this.pointerY = null;
    this.hovered = null;
    this.hoveredEntity = null;
  }

  private beginDrag(sample: PointerSample, kind: DragKind): void {
    this.drag = { pointerId: sample.pointerId, kind, lastX: sample.x, lastY: sample.y };
    this.mouse.capture(sample.pointerId);
    if (kind === 'camera') this.canvas.classList.add(DRAGGING_CLASS);
  }

  private endDrag(): void {
    const drag = this.drag;
    if (drag === null) return;
    this.drag = null;
    this.lastMined = null;
    this.mouse.release(drag.pointerId);
    this.canvas.classList.remove(DRAGGING_CLASS);
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  private handleAction(action: InputAction, phase: 'down' | 'up'): void {
    if (phase === 'down' && action === 'selection.clear') {
      this.selectedTile = null;
    }
    this.onAction?.(action, phase);
  }

  private applyHeldKeys(dtMs: number): void {
    const seconds = dtMs / 1000;

    // Pan by moving the world, which is the direction a held arrow should send
    // the *view*: pressing "up" shows what is above, so the world slides down.
    let dx = 0;
    let dy = 0;
    if (this.keyboard.isHeld('camera.panLeft')) dx += 1;
    if (this.keyboard.isHeld('camera.panRight')) dx -= 1;
    if (this.keyboard.isHeld('camera.panUp')) dy += 1;
    if (this.keyboard.isHeld('camera.panDown')) dy -= 1;

    if (dx !== 0 || dy !== 0) {
      // Normalised, so holding two arrows moves diagonally at the same speed
      // rather than 1.41 times faster.
      const scale = (KEY_PAN_PIXELS_PER_SECOND * seconds) / Math.hypot(dx, dy);
      this.camera.pan(dx * scale, dy * scale);
    }

    let steps = 0;
    if (this.keyboard.isHeld('camera.zoomIn')) steps += 1;
    if (this.keyboard.isHeld('camera.zoomOut')) steps -= 1;
    if (steps !== 0) {
      // Anchored on the pointer when there is one, so keyboard zoom behaves
      // like wheel zoom, and on the viewport centre when there is not.
      const x = this.pointerX ?? this.canvas.clientWidth / 2;
      const y = this.pointerY ?? this.canvas.clientHeight / 2;
      this.camera.zoomAt(x, y, steps * KEY_ZOOM_STEPS_PER_SECOND * seconds);
    }
  }

  /* ---------------------------------------------------------------- *
   * Hover and commands
   * ---------------------------------------------------------------- */

  private refreshHover(): void {
    if (this.pointerX === null || this.pointerY === null) {
      this.hovered = null;
      this.hoveredEntity = null;
      return;
    }

    const pick = this.picker.pick(this.pointerX, this.pointerY);
    this.hovered = pick.tile;
    this.hoveredEntity = pick.entityId;
  }

  /**
   * Ask the simulation to mine a tile, at most once per tile per drag.
   *
   * The de-duplication is what keeps a drag from enqueueing sixty commands a
   * second for the tile the cursor is resting on — the queue's per-tick cap
   * (§7) is a backstop, not a plan. Together they are the acceptance criterion
   * "a held-down build drag never enqueues more than 1024 commands per tick":
   * a drag can only produce one command per tile it crosses, and the processor
   * refuses to hand the tick more than 1024 of them however they arrive.
   *
   * C06 replaces this with the selected build tool's command; until then it is
   * `mineTile`, which is what the left button does in this genre when no tool
   * is held. Its effect is C10's. Today the simulation rejects it with
   * `'not_implemented'` and the rejection is shown — which is exactly the path
   * this chunk exists to build, end to end, with something visible at the end.
   */
  private mineAt(tile: TileCoord | null): void {
    if (tile === null) return;
    if (this.lastMined !== null && this.lastMined.x === tile.x && this.lastMined.y === tile.y) return;
    this.lastMined = tile;
    this.commands.enqueue({ type: 'mineTile', x: tile.x, y: tile.y });
  }
}
