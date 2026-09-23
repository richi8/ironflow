/**
 * Keyboard events to named actions. See ironflow.md C04 task 3.
 *
 * This class knows about keys; nothing downstream of it does. It translates
 * through the `KeyBindings` map it is given, tracks which actions are being
 * held, and reports edges. It contains no `if (code === ...)` — that is the
 * whole point, and it is what makes "remappable without touching handler code"
 * true rather than aspirational.
 */

import { actionFor, type InputAction, type KeyBindings } from './keybindings.js';

export interface KeyboardInputOptions {
  /** Usually `document`: hotkeys should work without clicking the canvas first. */
  readonly target: EventTarget;
  readonly bindings: KeyBindings;
  /**
   * An action started or stopped. `repeat` is suppressed, so `'down'` fires
   * once per physical press — a held key is reported through `isHeld`, which
   * is the form a frame-rate-independent camera pan needs.
   */
  readonly onAction: (action: InputAction, phase: 'down' | 'up') => void;
}

export class KeyboardInput {
  private readonly target: EventTarget;
  private readonly onAction: KeyboardInputOptions['onAction'];
  private bindings: KeyBindings;
  private readonly held = new Set<InputAction>();
  private attached = false;

  constructor(options: KeyboardInputOptions) {
    this.target = options.target;
    this.bindings = options.bindings;
    this.onAction = options.onAction;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.target.addEventListener('keydown', this.handleKeyDown);
    this.target.addEventListener('keyup', this.handleKeyUp);
    // A key held while the window loses focus never sends its keyup, and the
    // camera would pan forever. Blur is the only notification we get.
    globalThis.addEventListener?.('blur', this.handleBlur);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.target.removeEventListener('keydown', this.handleKeyDown);
    this.target.removeEventListener('keyup', this.handleKeyUp);
    globalThis.removeEventListener?.('blur', this.handleBlur);
    this.releaseAll();
  }

  /** Is this action's key currently down? */
  isHeld(action: InputAction): boolean {
    return this.held.has(action);
  }

  /** Swap the binding map. Anything held under the old map is released first. */
  setBindings(bindings: KeyBindings): void {
    this.releaseAll();
    this.bindings = bindings;
  }

  private readonly handleKeyDown = (event: Event): void => {
    const key = event as KeyboardEvent;
    if (isTypingTarget(key.target)) return;
    if (pressesControl(key)) return;

    const action = actionFor(this.bindings, key.code);
    if (action === null) return;

    // Bound keys belong to the game: arrows scroll the page and space scrolls
    // it a screenful, both of which are indistinguishable from the game
    // breaking. Unbound keys are left alone so the browser's own shortcuts and
    // C07's text fields keep working.
    key.preventDefault();

    if (key.repeat || this.held.has(action)) return;
    this.held.add(action);
    this.onAction(action, 'down');
  };

  private readonly handleKeyUp = (event: Event): void => {
    const key = event as KeyboardEvent;
    const action = actionFor(this.bindings, key.code);
    if (action === null) return;

    key.preventDefault();
    if (!this.held.delete(action)) return;
    this.onAction(action, 'up');
  };

  private readonly handleBlur = (): void => {
    this.releaseAll();
  };

  private releaseAll(): void {
    if (this.held.size === 0) return;
    // Iterating a copy: a listener is free to change bindings, and releasing a
    // set while something else may touch it is how a stuck key survives.
    for (const action of [...this.held]) {
      this.held.delete(action);
      this.onAction(action, 'up');
    }
  }
}

/**
 * Is this Enter or Space pressing a button the player moved focus to (C30)?
 *
 * Those two keys are how a keyboard presses a button, and both are bound to
 * the world — Enter builds, Space drags the view. A focused button has to
 * win, or Tab-ing to BAG and pressing Enter would place a building instead.
 *
 * Only a button focused *by the keyboard*: a button keeps focus after a
 * mouse click, and a mouse player who clicked MAP and then pressed Enter
 * meant the world. `:focus-visible` is the browser's own answer to "how did
 * focus get here". Where the selector is not understood (an old engine, a
 * test DOM) any focused control counts, which errs towards the button.
 */
function pressesControl(key: KeyboardEvent): boolean {
  if (key.code !== 'Enter' && key.code !== 'NumpadEnter' && key.code !== 'Space') return false;
  const target = key.target as { tagName?: unknown; getAttribute?: unknown; matches?: unknown } | null;
  if (target === null || typeof target !== 'object') return false;
  const tag = typeof target.tagName === 'string' ? target.tagName : '';
  const role = typeof target.getAttribute === 'function' ? (target as Element).getAttribute('role') : null;
  if (tag !== 'BUTTON' && tag !== 'A' && role !== 'button') return false;
  if (typeof target.matches !== 'function') return true;
  try {
    return (target as Element).matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * Is the event going to something the player is typing into?
 *
 * C07 brings text fields — a save name, an import box — and a game that eats
 * the space bar while you are naming a save is a game with a bug report
 * waiting. Checked structurally rather than with `instanceof HTMLElement`,
 * which is false across documents and in a test DOM.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  const tag = typeof element.tagName === 'string' ? element.tagName : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}
