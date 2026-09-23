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
  /**
   * Act on the tile in front of the player (C30): place what is held, feed
   * the machine there, open it, or mine the ground. Held, like the mouse
   * button it stands in for, so mining stops when it is let go.
   *
   * This and `world.remove` are what make the world reachable without a
   * mouse. The target is the tile the player faces, not a second cursor to
   * steer, because walking is already how a keyboard player points.
   */
  | 'world.interact'
  /** Demolish what stands in front of the player (C30). A right-click's other half. */
  | 'world.remove'
  /** Open and close the settings panel (C30). */
  | 'ui.toggleSettings'
  /** Run the simulation faster or slower (C30 task 5: "a speed control for testing"). */
  | 'game.speedUp'
  | 'game.speedDown'
  | 'debug.toggleOverlay';

/**
 * Every action, in the order the settings panel lists them, with the words it
 * uses (C30 task 3: rebindable keys).
 *
 * A `Record` over the union, so an action added above without a line here
 * is a type error — an action a player cannot see is an action they cannot
 * rebind.
 */
export const ACTION_LABELS: Readonly<Record<InputAction, string>> = Object.freeze({
  'player.moveUp': 'Walk up',
  'player.moveDown': 'Walk down',
  'player.moveLeft': 'Walk left',
  'player.moveRight': 'Walk right',
  'world.interact': 'Use the tile in front: build, feed, open, mine',
  'world.remove': 'Remove the building in front',
  'build.rotate': 'Rotate the held building',
  'build.slot1': 'Hotbar slot 1',
  'build.slot2': 'Hotbar slot 2',
  'build.slot3': 'Hotbar slot 3',
  'build.slot4': 'Hotbar slot 4',
  'build.slot5': 'Hotbar slot 5',
  'build.slot6': 'Hotbar slot 6',
  'build.slot7': 'Hotbar slot 7',
  'build.slot8': 'Hotbar slot 8',
  'build.slot9': 'Hotbar slot 9',
  'selection.clear': 'Put down / deselect',
  'machine.copyModifier': 'Copy / paste recipe (hold, with a click)',
  'camera.panUp': 'Look up',
  'camera.panDown': 'Look down',
  'camera.panLeft': 'Look left',
  'camera.panRight': 'Look right',
  'camera.zoomIn': 'Zoom in',
  'camera.zoomOut': 'Zoom out',
  'camera.dragModifier': 'Drag the view (hold, with a click)',
  'ui.toggleInventory': 'Inventory',
  'ui.toggleResearch': 'Technology tree',
  'ui.toggleMap': 'Map',
  'ui.toggleAltMode': 'Show what machines make',
  'ui.toggleSaveMenu': 'Save menu',
  'ui.toggleSettings': 'Settings',
  'game.togglePause': 'Pause / game menu',
  'game.speedUp': 'Game speed up',
  'game.speedDown': 'Game speed down',
  'debug.toggleOverlay': 'Debug overlay',
});

/** Every action, in `ACTION_LABELS` order. */
export const INPUT_ACTIONS: readonly InputAction[] = Object.freeze(Object.keys(ACTION_LABELS) as InputAction[]);

/** Is this string an action? For bindings read back from storage (C30). */
export function isInputAction(value: unknown): value is InputAction {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTION_LABELS, value);
}

/**
 * A key as a player reads it: `KeyW` is `W`, `Digit1` is `1`, `ArrowUp` is
 * `↑`. `code` names a physical key (see the header), so this is a label for
 * the key's usual legend, not a promise about the player's layout.
 */
export function keyLabel(code: string): string {
  const named: Readonly<Record<string, string>> = {
    ArrowUp: '↑',
    ArrowDown: '↓',
    ArrowLeft: '←',
    ArrowRight: '→',
    Equal: '=',
    Minus: '-',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num -',
    NumpadEnter: 'Num Enter',
    BracketLeft: '[',
    BracketRight: ']',
    ShiftLeft: 'Shift',
    ShiftRight: 'Right Shift',
    AltLeft: 'Alt',
    AltRight: 'Right Alt',
    ControlLeft: 'Ctrl',
    ControlRight: 'Right Ctrl',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Backslash: '\\',
    Backquote: '`',
  };
  const name = named[code];
  if (name !== undefined) return name;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  return code;
}

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
  // Tab is deliberately unbound (2026-09-23). A bound key's default is
  // prevented, and Tab is how a keyboard user moves focus between the
  // panels' buttons — taking it for the map took the UI's accessibility.
  KeyM: 'ui.toggleMap',
  // Both alts, because which one is under the player's thumb depends on the
  // keyboard, and `KeyV` beside it for the platforms that swallow alt entirely.
  AltLeft: 'ui.toggleAltMode',
  AltRight: 'ui.toggleAltMode',
  KeyV: 'ui.toggleAltMode',
  F2: 'ui.toggleSaveMenu',
  KeyP: 'game.togglePause',
  Pause: 'game.togglePause',
  // C30. Enter acts on the tile in front of the player and Delete clears it;
  // X beside the left hand's WASD, so a keyboard player need not reach
  // across. O for options. The brackets are the genre's speed keys.
  Enter: 'world.interact',
  NumpadEnter: 'world.interact',
  Delete: 'world.remove',
  KeyX: 'world.remove',
  KeyO: 'ui.toggleSettings',
  BracketRight: 'game.speedUp',
  BracketLeft: 'game.speedDown',
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

/**
 * Bindings read back from storage, or null if they are not bindings (C30).
 *
 * Every entry is checked: `localStorage` is written by this game and by
 * anyone with a console, and a map with one bad entry is refused whole
 * rather than half-applied — half a keyboard is harder to notice than none.
 * An action this build does not have is the one exception, and is dropped:
 * that is a save from a later build, and the rest of it is still good.
 */
export function parseBindings(raw: unknown): KeyBindings | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const next: Record<string, InputAction> = {};
  for (const [code, action] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9]{1,32}$/.test(code) || typeof action !== 'string') return null;
    if (isInputAction(action)) next[code] = action;
  }
  return Object.freeze(next);
}

/** Every key currently bound to an action. For a rebinding UI and for tests. */
export function keysFor(bindings: KeyBindings, action: InputAction): string[] {
  return Object.keys(bindings).filter((code) => bindings[code] === action);
}
