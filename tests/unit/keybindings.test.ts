import { describe, expect, it } from 'vitest';

import {
  DEFAULT_KEYBINDINGS,
  actionFor,
  keysFor,
  rebind,
  type InputAction,
} from '../../src/input/keybindings.js';

/**
 * Bindings are data. See ironflow.md C04 task 3.
 *
 * The acceptance criterion is that they can be remapped without touching
 * handler code, which makes two things worth pinning: that the map really is
 * the only thing consulted, and that rewriting it produces a new value rather
 * than mutating the shared default — a rebinding UI that edits the defaults in
 * place is one undo away from a game with no keys.
 */

describe('the default bindings', () => {
  it('binds no key to two actions', () => {
    // A `Record` cannot express the conflict, but a hand-edited literal with a
    // repeated key silently keeps the last one. This is the check for that.
    const codes = Object.keys(DEFAULT_KEYBINDINGS);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives WASD to the player, which is what C04 reserved it for', () => {
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyW')).toBe('player.moveUp');
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyA')).toBe('player.moveLeft');
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyS')).toBe('player.moveDown');
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyD')).toBe('player.moveRight');
  });

  it('keeps walking and panning on separate keys, so one never does both', () => {
    for (const action of ['player.moveUp', 'player.moveDown', 'player.moveLeft', 'player.moveRight'] as const) {
      for (const code of keysFor(DEFAULT_KEYBINDINGS, action)) {
        expect(code.startsWith('Arrow'), code).toBe(false);
      }
    }
  });

  it('offers both the main row and the numpad for zoom', () => {
    expect(keysFor(DEFAULT_KEYBINDINGS, 'camera.zoomIn')).toEqual(['Equal', 'NumpadAdd']);
    expect(keysFor(DEFAULT_KEYBINDINGS, 'camera.zoomOut')).toEqual(['Minus', 'NumpadSubtract']);
  });

  it('answers with null for a key nobody bound', () => {
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyQ')).toBeNull();
    // Not `undefined` from a prototype walk: `constructor` is a property of
    // every object literal's prototype and would otherwise look like a binding.
    expect(actionFor(DEFAULT_KEYBINDINGS, 'constructor')).toBeNull();
    expect(actionFor(DEFAULT_KEYBINDINGS, '__proto__')).toBeNull();
  });
});

describe('rebinding', () => {
  it('returns a new map and leaves the original alone', () => {
    const next = rebind(DEFAULT_KEYBINDINGS, 'KeyQ', 'debug.toggleOverlay');

    expect(actionFor(next, 'KeyQ')).toBe('debug.toggleOverlay');
    expect(actionFor(DEFAULT_KEYBINDINGS, 'KeyQ')).toBeNull();
  });

  it('unbinds with null', () => {
    const next = rebind(DEFAULT_KEYBINDINGS, 'F3', null);

    expect(actionFor(next, 'F3')).toBeNull();
    expect(keysFor(next, 'debug.toggleOverlay')).toEqual([]);
  });

  it('lets one action have as many keys as the player likes', () => {
    let bindings = DEFAULT_KEYBINDINGS;
    for (const code of ['KeyI', 'KeyO', 'KeyU']) {
      bindings = rebind(bindings, code, 'camera.zoomIn' satisfies InputAction);
    }

    expect(keysFor(bindings, 'camera.zoomIn')).toEqual(['Equal', 'NumpadAdd', 'KeyI', 'KeyO', 'KeyU']);
  });

  it('moves a key from one action to another', () => {
    const next = rebind(DEFAULT_KEYBINDINGS, 'Escape', 'debug.toggleOverlay');

    expect(keysFor(next, 'selection.clear')).toEqual([]);
    expect(keysFor(next, 'debug.toggleOverlay')).toEqual(['Escape', 'F3']);
  });
});
