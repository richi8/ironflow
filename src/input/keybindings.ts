/**
 * Keyboard bindings, as data. See ironflow.md C04 task 3.
 *
 * The acceptance criterion is "keybindings are data and can be remapped
 * without touching handler code", so this file holds no handlers and no
 * behaviour — only a map from a physical key to a named action, and the two
 * functions that read and rewrite it. `KeyboardInput` translates events into
 * actions using this map; `InputManager` acts on actions and never sees a key.
 * A rebinding UI (C30) changes the map and nothing else.
 *
 * Keys are `KeyboardEvent.code`, not `key`. `code` names the physical key, so
 * a binding on `KeyW` is the same finger on a QWERTY, AZERTY or Dvorak layout,
 * and it does not change under shift. `key` would make `W` and `w` different
 * bindings and would move under every layout switch — the classic bug where a
 * French player's build hotkey lands on `Z`.
 */

/**
 * Something the game can be asked to do with a key.
 *
 * Only actions some layer actually carries out are listed; the panels get
 * theirs from the chunks that implement them (§19 rule 4), because an action
 * with no handler is a keybinding that silently does nothing, which is worse
 * than no keybinding at all.
 *
 * The nine build slots are C06's, and all nine are handled — by
 * `GameController.selectSlot`, which selects whatever building the player put
 * on that slot of the hotbar (the first nine buildings until they arrange it).
 * The toolbar's nine tiles go through the same call.
 *
 * Pan directions are named for the **screen**, not for tile space: this is a
 * view control, the player is pushing the picture around, and nothing here
 * knows which way north is (§5).
 */
export type InputAction =
  | 'camera.panUp'
  | 'camera.panDown'
  | 'camera.panLeft'
  | 'camera.panRight'
  | 'camera.zoomIn'
  | 'camera.zoomOut'
  /** Held, not tapped: turns a left-drag into a camera drag (C04 task 4). */
  | 'camera.dragModifier'
  | 'selection.clear'
  /**
   * Walk. Named for the **screen**, like the pan actions above and for the same
   * reason: the player pushes a direction on the picture, and which tile
   * direction that is depends on the projection, which §5 keeps out of here.
   * `InputManager` asks the camera to translate (C10 task 2).
   */
  | 'player.moveUp'
  | 'player.moveDown'
  | 'player.moveLeft'
  | 'player.moveRight'
  /** Cycle the held building's rotation (C06 task 5). */
  | 'build.rotate'
  /**
   * Held, not tapped: turns a right-click into "copy this machine's recipe"
   * and a left-click into "paste it here" (C20 task 5).
   *
   * The genre's gesture, and the reason it is worth having is that a factory
   * is built by repetition: eight assemblers all making gears is eight trips
   * into the recipe picker, and the eighth is where the player picks the wrong
   * one without noticing.
   */
  | 'machine.copyModifier'
  | 'build.slot1'
  | 'build.slot2'
  | 'build.slot3'
  | 'build.slot4'
  | 'build.slot5'
  | 'build.slot6'
  | 'build.slot7'
  | 'build.slot8'
  | 'build.slot9'
  /**
   * Open and close the inventory, which is also the hand-craft bench (C21A).
   *
   * Two keys, and neither of them is a compromise. `I` is what the word
   * starts with and what the HUD's tooltip names; `E` is where this genre has
   * put it for a decade, and the hand that reaches for it is already on WASD.
   */
  | 'ui.toggleInventory'
  /**
   * Open and close the technology tree (C22).
   *
   * `T`, which is what this genre has bound it to for as long as it has had
   * one, and which is free: it is nowhere near the number row or WASD, so it
   * cannot be hit mid-drag.
   */
  | 'ui.toggleResearch'
  /**
   * Open and close the map (C23).
   *
   * `M`, which is what the word starts with and what the toolbar's button is
   * labelled, and which is as free as `T` was: nowhere near the number row or
   * WASD, so it cannot be hit mid-drag.
   */
  | 'ui.toggleMap'
  /**
   * Show what every machine is making, over the world (C20 task 5).
   *
   * A **toggle**, not a hold, which is the one decision in it. The genre's
   * convention is to hold the key, and a browser cannot honour that: `Alt` is
   * the window manager's on two platforms, and a key held while the pointer
   * leaves the canvas is a key the page never sees released — so a held alt
   * mode would stick on, and the player's only way out would be to press and
   * release it over the canvas. A tap is unambiguous whatever the OS does
   * with the key in between.
   */
  | 'ui.toggleAltMode'
  /**
   * Open and close the save menu (C25).
   *
   * `F2`, beside `F3`'s debug overlay and for the same reason: the function
   * row is nowhere near the hand that is building, so a save menu cannot open
   * mid-drag — and `F2` is one of the few function keys no browser claims.
   * The letter keys are not free any more, and the letter a save menu would
   * want (`S`) is the key that walks the player south.
   */
  | 'ui.toggleSaveMenu'
  /**
   * Pause into the game menu, or close it and play on (C07, §8). The menu is
   * the save menu for now; the loop is held still behind it.
   */
  | 'game.togglePause'
  | 'debug.toggleOverlay';

/** A map from `KeyboardEvent.code` to the action that key performs. */
export type KeyBindings = Readonly<Record<string, InputAction>>;

/**
 * The shipped defaults.
 *
 * Arrows pan and WASD walks. C04 reserved WASD for exactly this, rather than
 * binding it to the camera and taking it away here — a binding that has to be
 * withdrawn is worse than one that was never offered. Space is the drag modifier for the same reason it is in
 * every map editor: it is the largest key and it is not a letter anyone needs
 * while dragging. `R` rotates and the number row selects, which is what every
 * game in this genre has trained the player's left hand to expect. `P` pauses
 * into the game menu, and is free: it is not reachable by the left hand while
 * it is on the number row, so it cannot be hit by accident mid-drag. `I` and `E` both open the bag (C21A) — see the action.
 */
export const DEFAULT_KEYBINDINGS: KeyBindings = Object.freeze({
  ArrowUp: 'camera.panUp',
  ArrowDown: 'camera.panDown',
  ArrowLeft: 'camera.panLeft',
  ArrowRight: 'camera.panRight',
  Equal: 'camera.zoomIn',
  NumpadAdd: 'camera.zoomIn',
  Minus: 'camera.zoomOut',
  NumpadSubtract: 'camera.zoomOut',
  Space: 'camera.dragModifier',
  KeyW: 'player.moveUp',
  KeyA: 'player.moveLeft',
  KeyS: 'player.moveDown',
  KeyD: 'player.moveRight',
  Escape: 'selection.clear',
  KeyR: 'build.rotate',
  ShiftLeft: 'machine.copyModifier',
  ShiftRight: 'machine.copyModifier',
  KeyI: 'ui.toggleInventory',
  KeyE: 'ui.toggleInventory',
  KeyT: 'ui.toggleResearch',
  KeyM: 'ui.toggleMap',
  // Tab too, where this genre keeps its map. A bound key's default is
  // prevented, so Tab no longer walks focus around the page while playing —
  // and it still does in a text field, which the keyboard layer ignores.
  Tab: 'ui.toggleMap',
  // Both alts, because which one is under the player's thumb depends on the
  // keyboard, and `KeyV` beside it for the platforms that swallow alt entirely.
  AltLeft: 'ui.toggleAltMode',
  AltRight: 'ui.toggleAltMode',
  KeyV: 'ui.toggleAltMode',
  F2: 'ui.toggleSaveMenu',
  KeyP: 'game.togglePause',
  Pause: 'game.togglePause',
  Digit1: 'build.slot1',
  Digit2: 'build.slot2',
  Digit3: 'build.slot3',
  Digit4: 'build.slot4',
  Digit5: 'build.slot5',
  Digit6: 'build.slot6',
  Digit7: 'build.slot7',
  Digit8: 'build.slot8',
  Digit9: 'build.slot9',
  F3: 'debug.toggleOverlay',
});

/** The action bound to a physical key, or null if that key does nothing. */
export function actionFor(bindings: KeyBindings, code: string): InputAction | null {
  return Object.prototype.hasOwnProperty.call(bindings, code) ? (bindings[code] ?? null) : null;
}

/**
 * A copy of `bindings` with `code` bound to `action`, or unbound for `null`.
 *
 * Returns a new frozen map rather than mutating, so a binding change is a
 * value the caller can keep, compare and undo. A rebinding UI that has to
 * mutate shared state to work is a rebinding UI with a race in it.
 */
export function rebind(bindings: KeyBindings, code: string, action: InputAction | null): KeyBindings {
  const next: Record<string, InputAction> = { ...bindings };
  if (action === null) {
    delete next[code];
  } else {
    next[code] = action;
  }
  return Object.freeze(next);
}

/** Every key currently bound to an action. For a rebinding UI and for tests. */
export function keysFor(bindings: KeyBindings, action: InputAction): string[] {
  return Object.keys(bindings).filter((code) => bindings[code] === action);
}
