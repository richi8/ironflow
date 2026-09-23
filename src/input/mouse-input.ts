/**
 * Pointer and wheel events on the canvas. See ironflow.md C04 task 3.
 *
 * **Pointer events, not mouse events.** One set of handlers then covers mouse,
 * pen and touch, and pointer capture makes a drag that leaves the window keep
 * working — which is the difference between panning the map and panning it
 * until your cursor reaches the edge of the screen.
 *
 * This class translates DOM events into canvas-local samples and does nothing
 * else. It holds no camera, no selection and no notion of what a drag means;
 * `InputManager` decides all of that. Splitting it this way is what lets the
 * manager be tested without a DOM and this file be reviewed by reading it.
 */

/** `PointerEvent.button` values. The DOM numbers them; it does not name them. */
export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

/**
 * `PointerEvent.buttons` bitmask, which numbers the same buttons differently
 * from `button` — the classic off-by-one-bit in pointer code, and the reason
 * both sets are named here rather than written as literals at the call site.
 */
export const BUTTONS_LEFT = 1;
export const BUTTONS_RIGHT = 2;
export const BUTTONS_MIDDLE = 4;

/** `button` on an event where no button changed state, per the DOM spec. */
const NO_BUTTON = -1;

/**
 * One pointer event, reduced to what the game cares about.
 *
 * Coordinates are canvas-local CSS pixels — the space `Camera` works in — so
 * no consumer has to remember to subtract a bounding rect, and none of them
 * can forget.
 */
export interface PointerSample {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  /** Which button changed, or -1 on a move. */
  readonly button: number;
  /** Bitmask of every button currently down. */
  readonly buttons: number;
}

export interface MouseInputHandlers {
  onPointerDown(sample: PointerSample): void;
  onPointerMove(sample: PointerSample): void;
  onPointerUp(sample: PointerSample): void;
  /** The pointer left the canvas, or the gesture was cancelled by the browser. */
  onPointerExit(): void;
  /** `steps` is signed wheel notches, positive to zoom in, at `(x, y)`. */
  onZoom(x: number, y: number, steps: number): void;
}

/**
 * `deltaY` for one wheel notch in pixel mode, on every platform that matters.
 */
const WHEEL_PIXELS_PER_NOTCH = 100;

/** A line of text, for the line-mode deltas Firefox sends. */
const PIXELS_PER_LINE = 16;

/** A page, for the page-mode deltas a few configurations send. */
const LINES_PER_PAGE = 24;

/**
 * `deltaY` for one notch of a pinch gesture.
 *
 * A trackpad pinch arrives as a wheel event with `ctrlKey` set and a much
 * smaller delta than a wheel notch — that is the platform convention, not a
 * guess. Dividing pinches by the wheel constant makes them feel dead; dividing
 * wheel notches by this one makes a single notch cross the whole zoom range.
 */
const PINCH_PIXELS_PER_NOTCH = 30;

/** Beyond this, one event is a momentum spike and not a deliberate gesture. */
const MAX_STEPS_PER_EVENT = 4;

export class MouseInput {
  private readonly canvas: HTMLCanvasElement;
  private readonly handlers: MouseInputHandlers;
  private attached = false;

  constructor(canvas: HTMLCanvasElement, handlers: MouseInputHandlers) {
    this.canvas = canvas;
    this.handlers = handlers;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;

    this.canvas.addEventListener('pointerdown', this.handleDown);
    this.canvas.addEventListener('pointermove', this.handleMove);
    this.canvas.addEventListener('pointerup', this.handleUp);
    this.canvas.addEventListener('pointercancel', this.handleCancel);
    this.canvas.addEventListener('pointerleave', this.handleLeave);
    // Not passive: both of these exist to call preventDefault. The browser
    // assumes wheel listeners are passive by default and would scroll the page
    // out from under a zoom.
    this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.handleContextMenu);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;

    this.canvas.removeEventListener('pointerdown', this.handleDown);
    this.canvas.removeEventListener('pointermove', this.handleMove);
    this.canvas.removeEventListener('pointerup', this.handleUp);
    this.canvas.removeEventListener('pointercancel', this.handleCancel);
    this.canvas.removeEventListener('pointerleave', this.handleLeave);
    this.canvas.removeEventListener('wheel', this.handleWheel);
    this.canvas.removeEventListener('contextmenu', this.handleContextMenu);
  }

  /**
   * Route this pointer's events to the canvas until released.
   *
   * Called by the manager when a drag begins. Guarded because pointer capture
   * is missing in jsdom and on a few older engines, where losing the drag past
   * the window edge is a far better outcome than losing the input layer.
   */
  capture(pointerId: number): void {
    this.canvas.setPointerCapture?.(pointerId);
  }

  release(pointerId: number): void {
    if (this.canvas.hasPointerCapture?.(pointerId) === true) {
      this.canvas.releasePointerCapture?.(pointerId);
    }
  }

  private readonly handleDown = (event: Event): void => {
    const pointer = event as PointerEvent;
    this.handlers.onPointerDown(this.sample(pointer, pointer.button));
  };

  private readonly handleMove = (event: Event): void => {
    this.handlers.onPointerMove(this.sample(event as PointerEvent, NO_BUTTON));
  };

  private readonly handleUp = (event: Event): void => {
    const pointer = event as PointerEvent;
    this.handlers.onPointerUp(this.sample(pointer, pointer.button));
  };

  private readonly handleCancel = (event: Event): void => {
    const pointer = event as PointerEvent;
    this.handlers.onPointerUp(this.sample(pointer, pointer.button));
    this.handlers.onPointerExit();
  };

  private readonly handleLeave = (): void => {
    this.handlers.onPointerExit();
  };

  private readonly handleWheel = (event: Event): void => {
    const wheel = event as WheelEvent;
    // Always, including a pinch: `ctrl` + wheel is the browser's own page-zoom
    // gesture, and a factory that resizes the page when you zoom the map is
    // not a factory anyone will play twice.
    wheel.preventDefault();

    const steps = wheelSteps(wheel);
    if (steps === 0) return;

    const { x, y } = this.localPoint(wheel.clientX, wheel.clientY);
    this.handlers.onZoom(x, y, steps);
  };

  /** The canvas is the game's own surface; the browser's menu is not wanted. */
  private readonly handleContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  private sample(event: PointerEvent, button: number): PointerSample {
    const { x, y } = this.localPoint(event.clientX, event.clientY);
    return {
      // jsdom has no PointerEvent, so tests synthesise one; a missing id is a
      // single mouse, which is the only case that could produce it.
      pointerId: event.pointerId ?? 1,
      x,
      y,
      button,
      buttons: event.buttons,
    };
  }

  private localPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
}

/**
 * Signed wheel notches for one event, positive to zoom in.
 *
 * Three normalisations, all of them load-bearing: `deltaMode` (Firefox reports
 * lines, not pixels, and a zoom three times too slow reads as broken), the
 * pinch convention, and a cap — a trackpad's momentum tail can deliver a
 * single enormous delta, and crossing the entire zoom range in one frame is
 * indistinguishable from the camera teleporting.
 */
function wheelSteps(event: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  let pixels = event.deltaY;
  if (event.deltaMode === 1) pixels *= PIXELS_PER_LINE;
  else if (event.deltaMode === 2) pixels *= PIXELS_PER_LINE * LINES_PER_PAGE;

  const perNotch = event.ctrlKey ? PINCH_PIXELS_PER_NOTCH : WHEEL_PIXELS_PER_NOTCH;
  const steps = -pixels / perNotch;
  if (steps > MAX_STEPS_PER_EVENT) return MAX_STEPS_PER_EVENT;
  if (steps < -MAX_STEPS_PER_EVENT) return -MAX_STEPS_PER_EVENT;
  return steps;
}
