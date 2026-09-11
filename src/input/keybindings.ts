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
 * The nine build slots are C06's, and all nine are handled — by the
 * composition root, which maps slot *n* to the *n*th building in
 * `data/buildings.ts`. Their meaning is therefore content: a slot past the end
 * of that table selects nothing today and becomes a real hotkey the moment a
 * building is added, with no code change anywhere. That is the chunk's last
 * acceptance criterion, expressed as a keymap.
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
  /** Cycle the held building's rotation (C06 task 5). */
  | 'build.rotate'
  | 'build.slot1'
  | 'build.slot2'
  | 'build.slot3'
  | 'build.slot4'
  | 'build.slot5'
  | 'build.slot6'
  | 'build.slot7'
  | 'build.slot8'
  | 'build.slot9'
  | 'debug.toggleOverlay';

/** A map from `KeyboardEvent.code` to the action that key performs. */
export type KeyBindings = Readonly<Record<string, InputAction>>;

/**
 * The shipped defaults.
 *
 * Arrows pan and WASD does not, because WASD moves the *player* from C10
 * onwards and a binding that has to be taken away later is worse than one that
 * is never offered. Space is the drag modifier for the same reason it is in
 * every map editor: it is the largest key and it is not a letter anyone needs
 * while dragging. `R` rotates and the number row selects, which is what every
 * game in this genre has trained the player's left hand to expect.
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
  Escape: 'selection.clear',
  KeyR: 'build.rotate',
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
