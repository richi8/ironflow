import { describe, expect, it } from 'vitest';

import { DEFAULT_KEYBINDINGS, actionFor, parseBindings, rebind } from '../../src/input/keybindings.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  SettingsStore,
  normalise,
  type KeyValueStorage,
} from '../../src/platform/settings-store.js';

/**
 * Settings persistence. See ironflow.md C30: volume and mute "persisted in
 * `localStorage` (UI preference — not game state)", and the same for scale,
 * motion, key bindings and the first-run list.
 *
 * What is pinned: a change survives a reload; storage that is garbage, hostile
 * or missing costs the bad field and never the game.
 */

class MapStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('SettingsStore', () => {
  it('starts from the defaults with nothing stored', () => {
    expect(new SettingsStore(new MapStorage()).get()).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps every preference across a reload', () => {
    const storage = new MapStorage();
    const first = new SettingsStore(storage);
    first.update({ volume: 0.25, muted: true, uiScale: 1.3, motion: 'reduce' });
    first.update({ bindings: { ...rebind(DEFAULT_KEYBINDINGS, 'KeyQ', 'world.interact') } });
    first.update({ objectives: { visible: false, done: ['mine-iron', 'place-miner'] } });

    const reloaded = new SettingsStore(storage).get();
    expect(reloaded.volume).toBe(0.25);
    expect(reloaded.muted).toBe(true);
    expect(reloaded.uiScale).toBe(1.3);
    expect(reloaded.motion).toBe('reduce');
    expect(reloaded.objectives).toEqual({ visible: false, done: ['mine-iron', 'place-miner'] });
    const bindings = parseBindings(reloaded.bindings);
    expect(bindings === null ? null : actionFor(bindings, 'KeyQ')).toBe('world.interact');
  });

  it('writes nothing into a save: the key is its own', () => {
    const storage = new MapStorage();
    new SettingsStore(storage).update({ volume: 0.5 });
    expect([...storage.map.keys()]).toEqual([SETTINGS_KEY]);
  });

  it('falls back field by field on garbage', () => {
    const settings = normalise({
      volume: 7,
      muted: 'yes',
      uiScale: 0.123,
      motion: 'wobbly',
      bindings: 'KeyW',
      objectives: { visible: 'no', done: ['mine-iron', 3, 'mine-iron'] },
    });
    expect(settings.volume).toBe(1);
    expect(settings.muted).toBe(DEFAULT_SETTINGS.muted);
    expect(settings.uiScale).toBe(DEFAULT_SETTINGS.uiScale);
    expect(settings.motion).toBe('system');
    expect(settings.bindings).toBeNull();
    expect(settings.objectives).toEqual({ visible: true, done: ['mine-iron'] });
  });

  it('survives storage that is not JSON, and storage that throws', () => {
    const broken = new MapStorage();
    broken.setItem(SETTINGS_KEY, '{not json');
    expect(new SettingsStore(broken).get()).toEqual(DEFAULT_SETTINGS);

    const hostile: KeyValueStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const store = new SettingsStore(hostile);
    expect(store.update({ volume: 0.1 }).volume).toBe(0.1);
    expect(new SettingsStore(null).get()).toEqual(DEFAULT_SETTINGS);
  });
});

describe('parseBindings', () => {
  it('reads back what rebinding wrote', () => {
    const bindings = rebind(DEFAULT_KEYBINDINGS, 'KeyQ', 'game.speedUp');
    expect(parseBindings(JSON.parse(JSON.stringify(bindings)))).toEqual(bindings);
  });

  it('drops an action this build does not have, and keeps the rest', () => {
    const parsed = parseBindings({ KeyW: 'player.moveUp', KeyJ: 'player.jetpack' });
    expect(parsed).toEqual({ KeyW: 'player.moveUp' });
  });

  it('refuses a map with a malformed key or value outright', () => {
    expect(parseBindings({ 'Key W': 'player.moveUp' })).toBeNull();
    expect(parseBindings({ KeyW: 3 })).toBeNull();
    expect(parseBindings(['KeyW'])).toBeNull();
    expect(parseBindings(null)).toBeNull();
  });
});
