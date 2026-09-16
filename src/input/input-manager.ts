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
import type { EntityId } from '../game/commands/command.js';
import { NORTH, isRotation, type Rotation, type TileCoord } from '../game/world/coordinates.js';

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
  /**
   * Which way a screen direction points in tile space (C10 task 2).
   *
   * WASD is a direction on the picture and a `movePlayer` command carries a
   * tile-space one, so something has to translate — and §5 puts the projection
   * in one file that §4 forbids this layer from importing. Asking the camera is
   * the same arrangement `TilePicker` already is, in the same direction.
   */
  screenDirectionToWorld(dxPx: number, dyPx: number): { readonly x: number; readonly y: number };
}

/** What is under a pixel. Satisfied by `renderer/picker.ts`'s `ScenePicker`. */
export interface ScenePickResult {
  readonly tile: TileCoord;
  readonly entityId: number | null;
}

export interface TilePicker {
  pick(screenX: number, screenY: number): ScenePickResult;
}

/**
 * A building held over the cursor. See ironflow.md C06 task 4.
 *
 * `rotationCount` travels with the tool because `R` has to cycle within it and
 * this layer may not read content data (§4): a chest has one rotation and a
 * belt has four, and the composition root — which does know — says which. The
 * rotation itself is *not* here: the manager owns it, the same way it owns
 * hover and selection, because it is the thing the key changes.
 */
export interface BuildTool {
  readonly buildingId: string;
  readonly rotationCount: 1 | 2 | 4;
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

/**
 * How far off an axis a walk direction may be before it stops counting.
 *
 * `tan(22.5°)`. A screen direction unprojects into a tile vector whose
 * components are not comparable by sign — screen up-right unprojects to
 * something like `(-0.016, -0.047)`, and taking the sign of each would call
 * that "north-west" when what the player pressed is plainly north. Scaling by
 * the larger component and snapping anything under this threshold to zero picks
 * the nearest of the eight tile directions instead, which is what the keys mean.
 */
const DIRECTION_SNAP = Math.SQRT2 - 1;

/** A direction of "not walking". Shared so the no-op comparison never allocates. */
const STILL = Object.freeze({ x: 0, y: 0 });

/**
 * The nearest of the eight tile directions to a tile-space vector.
 *
 * Scaled by the larger component so the test is about the *shape* of the
 * vector rather than its length — the unprojected screen directions are tiny —
 * and each axis is then kept or dropped against `DIRECTION_SNAP`. The result is
 * always one of the nine vectors with components in `{-1, 0, 1}`.
 */
function snapToTileDirection(vector: { readonly x: number; readonly y: number }): { x: number; y: number } {
  const scale = Math.max(Math.abs(vector.x), Math.abs(vector.y));
  if (scale === 0) return { x: 0, y: 0 };
  return { x: axisStep(vector.x / scale), y: axisStep(vector.y / scale) };
}

function axisStep(value: number): -1 | 0 | 1 {
  if (Math.abs(value) < DIRECTION_SNAP) return 0;
  return value > 0 ? 1 : -1;
}

/** Set while the camera is being dragged, so the cursor can say so. */
const DRAGGING_CLASS = 'is-dragging';

/**
 * What a left-drag is doing. `tile` covers both mining and placing, because
 * which of the two it is depends on whether a building is held *at the moment
 * each tile is crossed*, not on what was true when the button went down.
 */
type DragKind = 'camera' | 'tile';

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
  private hoveredEntity: EntityId | null = null;
  private selection: EntityId | null = null;
  /** The tile the current drag last enqueued for. See `actOnTile`. */
  private lastActedTile: TileCoord | null = null;
  private tool: BuildTool | null = null;
  private toolRotation: Rotation = NORTH;
  /**
   * The last walk direction sent to the simulation.
   *
   * Commands go out **on change**, not every frame. The simulation holds the
   * direction and steps once per tick (see `player/player-state.ts`), so
   * re-sending the same vector sixty times a second would fill the queue to say
   * nothing — and sending one per frame in the first place is what would make
   * walking speed depend on frame rate.
   */
  private sentMove: { x: number; y: number } = { x: 0, y: 0 };
  /** True while the left button is held over a tile with an empty hand. */
  private mining = false;

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
  get hoverEntity(): EntityId | null {
    return this.hoveredEntity;
  }

  /**
   * The machine being inspected, or null (C12 task 4).
   *
   * Presentation state, like hover and the held building: it is not
   * serialized, no system reads it, and the controller sees it only through
   * the `Cursor` interface it declares for itself — which is why the name is
   * the interface's rather than the shorter one this file would pick.
   *
   * An *entity* rather than a tile, because what the inspector shows is a
   * machine. Clicking bare ground is how a player says "nothing", and that
   * falls out of reading the picker's answer straight: it is `null` exactly
   * when the pixel was ground.
   */
  get selectedEntityId(): EntityId | null {
    return this.selection;
  }

  /** Select a machine, or `null` for none. The inspector's close button. */
  setSelectedEntity(entityId: EntityId | null): void {
    this.selection = entityId;
  }

  /**
   * The building held over the cursor, or null for an empty hand.
   *
   * Presentation state, like hover and selection: it is not serialized, no
   * system reads it, and nothing happens until a click turns it into a `build`
   * command. C07's build menu sets it; C06's composition root does it from the
   * number-row hotkeys.
   */
  get buildTool(): BuildTool | null {
    return this.tool;
  }

  /** The rotation the held building would be placed with. */
  get buildRotation(): Rotation {
    return this.toolRotation;
  }

  /**
   * Hold a building, or `null` to empty the hand.
   *
   * Rotation resets to north when the building changes but survives
   * re-selecting the same one, which is what a player dragging out a row of
   * east-facing belts expects: picking the belt up again must not turn it.
   */
  setBuildTool(tool: BuildTool | null): void {
    if (tool !== null && this.tool?.buildingId === tool.buildingId) {
      this.tool = tool;
      return;
    }
    this.tool = tool;
    this.toolRotation = NORTH;
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
    this.updateWalk();
    this.refreshHover();
  }

  /**
   * Turn the held WASD keys into at most one `movePlayer` command.
   *
   * Read every frame and sent only when it changes. A key released while the
   * window is not focused never sends its keyup, which is why `KeyboardInput`
   * clears everything on blur — without that the player would keep walking off
   * the map behind a switched-away tab.
   */
  private updateWalk(): void {
    let screenX = 0;
    let screenY = 0;
    if (this.keyboard.isHeld('player.moveLeft')) screenX -= 1;
    if (this.keyboard.isHeld('player.moveRight')) screenX += 1;
    if (this.keyboard.isHeld('player.moveUp')) screenY -= 1;
    if (this.keyboard.isHeld('player.moveDown')) screenY += 1;

    const direction =
      screenX === 0 && screenY === 0
        ? STILL
        : snapToTileDirection(this.camera.screenDirectionToWorld(screenX, screenY));

    if (direction.x === this.sentMove.x && direction.y === this.sentMove.y) return;
    this.sentMove = direction;
    this.commands.enqueue({ type: 'movePlayer', dx: direction.x, dy: direction.y });
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
      this.beginDrag(sample, 'tile');
      // Placing does not move the selection: dragging out a row of chests
      // should not drag the inspector along behind it. With an empty hand the
      // picker's answer *is* the selection — a machine, or null for ground,
      // which is C12 task 4's "click empty ground to deselect" with no second
      // rule to write down.
      if (this.tool === null) this.selection = this.hoveredEntity;
      this.lastActedTile = null;
      this.actOnTile(this.hovered);
      return;
    }

    if (sample.button === BUTTON_RIGHT) {
      // With a building held, the right button puts it down — the genre's
      // universal "cancel", and the reason it does not also demolish: the
      // click that cancels a misplaced ghost must never be the click that
      // removes the building underneath it.
      if (this.tool !== null) {
        this.setBuildTool(null);
        return;
      }
      this.selection = null;
      this.removeAt(this.hovered);
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
    this.actOnTile(this.hovered);
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
    this.lastActedTile = null;
    this.mouse.release(drag.pointerId);
    this.canvas.classList.remove(DRAGGING_CLASS);
    this.stopMining();
  }

  /**
   * Tell the simulation the button is up, if it was ever told it was down.
   *
   * Guarded by `this.mining` so that letting go of a camera drag, or of a
   * build drag, does not enqueue a command to stop something that was never
   * started — one command per press, one per release, and none otherwise.
   */
  private stopMining(): void {
    if (!this.mining) return;
    this.mining = false;
    this.commands.enqueue({ type: 'stopMining' });
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  private handleAction(action: InputAction, phase: 'down' | 'up'): void {
    if (phase === 'down') {
      if (action === 'selection.clear') {
        // One key that means "stop what you are doing": it drops the held
        // building as well as the selection, so Escape is always the way out.
        this.selection = null;
        this.setBuildTool(null);
      }
      if (action === 'build.rotate') this.rotateTool();
      // Picking up a building while mining stops the mining: the two gestures
      // share the left button, and a held-over mining target would keep ticking
      // under a ghost the player is now placing.
      if (action === 'selection.clear') this.stopMining();
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
   * Act on a tile, at most once per tile per drag.
   *
   * With a building held this places it; with an empty hand it mines. The
   * de-duplication is what keeps a drag from enqueueing sixty commands a
   * second for the tile the cursor is resting on — the queue's per-tick cap
   * (§7) is a backstop, not a plan. Together they are the acceptance criterion
   * "a held-down build drag never enqueues more than 1024 commands per tick":
   * a drag can only produce one command per tile it crosses, and the processor
   * refuses to hand the tick more than 1024 of them however they arrive.
   *
   * Dragging places one building per tile crossed, which is not C06's
   * out-of-scope "drag-to-build lines" — that is C13's straight-line snapping
   * for belts. This is the same one-command-per-tile path mining already used.
   *
   * With an empty hand over a building the answer is neither: the click has
   * already selected it (C12), and mining the tile a machine stands on is not
   * something a player could have meant.
   */
  private actOnTile(tile: TileCoord | null): void {
    if (tile === null) return;
    if (this.lastActedTile !== null && this.lastActedTile.x === tile.x && this.lastActedTile.y === tile.y) return;
    this.lastActedTile = tile;

    const tool = this.tool;
    if (tool === null) {
      // Clicking a machine inspects it; it does not try to mine the ground
      // underneath it (C12 task 4). Without this a miner sitting on ore — the
      // only place a miner ever sits — could not be clicked without also
      // starting to dig the tile it stands on.
      if (this.hoveredEntity !== null) return;
      this.mining = true;
      this.commands.enqueue({ type: 'mineTile', x: tile.x, y: tile.y });
      return;
    }
    // Dragging from bare ground onto a building's tile with something in hand
    // switches from mining to placing, so the mining that was running has to
    // be told to stop.
    this.stopMining();
    this.commands.enqueue({
      type: 'build',
      buildingId: tool.buildingId,
      x: tile.x,
      y: tile.y,
      rotation: this.toolRotation,
    });
  }

  /** Ask the simulation to demolish whatever stands on a tile (C06 task 6). */
  private removeAt(tile: TileCoord | null): void {
    if (tile === null) return;
    this.commands.enqueue({ type: 'remove', x: tile.x, y: tile.y });
  }

  private rotateTool(): void {
    const tool = this.tool;
    if (tool === null) return;
    const next = (this.toolRotation + 1) % tool.rotationCount;
    this.toolRotation = isRotation(next) ? next : NORTH;
  }
}
