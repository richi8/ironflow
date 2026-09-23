/**
 * The player's preferences, kept in `localStorage`. See C30.
 *
 * C30 says it in as many words: volume and mute are "persisted in
 * `localStorage` (UI preference — **not** game state)". Everything here is
 * the same kind of thing — how loud, how big, how much motion, which keys,
 * whether the first-run objectives are still showing — so it is one record in
 * one key, and none of it goes near a save file. A factory moved to another
 * machine keeps its hotbar (§13), because that is part of the factory; it
 * does not take the old machine's volume with it.
 *
 * ## Storage is distrusted, and optional
 *
 * `localStorage` throws in some private modes, is shared with anything else
 * on the origin, and can be edited from a console. So every field is read
 * back through its own check and falls back to the default on its own — one
 * bad field costs that field, not the whole record — and a store that cannot
 * be read or written is a store with defaults in it. Nothing here throws.
 *
 * Key bindings are held as the raw map. Checking them is the input layer's
 * job (`keybindings.ts`'s `parseBindings`), because what counts as an action
 * is something only that layer knows, and §4 keeps this one out of it.
 */

/** How the game treats motion. `system` follows `prefers-reduced-motion`. */
export type MotionPreference = 'system' | 'reduce' | 'full';

export interface Settings {
  /** 0 to 1. */
  readonly volume: number;
  readonly muted: boolean;
  /** One of `UI_SCALES`. */
  readonly uiScale: number;
  readonly motion: MotionPreference;
  /** `KeyboardEvent.code` to action name, or null for the shipped defaults. */
  readonly bindings: Readonly<Record<string, string>> | null;
  /** The first-run objectives: shown, and which are done. */
  readonly objectives: ObjectiveProgress;
}

export interface ObjectiveProgress {
  /** False once skipped or finished. The settings panel can turn it back on. */
  readonly visible: boolean;
  /** Ids of the objectives already met, in the order they were met. */
  readonly done: readonly string[];
}

/** The scales the settings panel offers. 1 is the layout as designed. */
export const UI_SCALES: readonly number[] = Object.freeze([0.85, 1, 1.15, 1.3, 1.5]);

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  volume: 0.7,
  muted: false,
  uiScale: 1,
  motion: 'system',
  bindings: null,
  objectives: Object.freeze({ visible: true, done: Object.freeze([]) }),
});

/** The key everything is stored under. Versioned, so a later shape can start fresh. */
export const SETTINGS_KEY = 'ironflow.settings.v1';

/** The slice of `Storage` this needs. `localStorage` satisfies it; so does a test's map. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class SettingsStore {
  private readonly storage: KeyValueStorage | null;
  private current: Settings;

  constructor(storage: KeyValueStorage | null) {
    this.storage = storage;
    this.current = readSettings(storage);
  }

  get(): Settings {
    return this.current;
  }

  /** Change some fields and write the whole record back. Returns what is now in effect. */
  update(patch: Partial<Settings>): Settings {
    this.current = normalise({ ...this.current, ...patch });
    try {
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify(this.current));
    } catch {
      // Full, blocked or gone: the setting still applies for this session.
    }
    return this.current;
  }
}

/** `localStorage`, or null where touching it throws (some private modes do). */
export function browserStorage(): KeyValueStorage | null {
  try {
    const storage = globalThis.localStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function readSettings(storage: KeyValueStorage | null): Settings {
  let raw: unknown = null;
  try {
    const text = storage?.getItem(SETTINGS_KEY) ?? null;
    raw = text === null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  return normalise(raw);
}

/** Every field checked on its own, each falling back to its default. */
export function normalise(raw: unknown): Settings {
  const input = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const volume = typeof input['volume'] === 'number' && Number.isFinite(input['volume'])
    ? Math.max(0, Math.min(1, input['volume']))
    : DEFAULT_SETTINGS.volume;
  const muted = typeof input['muted'] === 'boolean' ? input['muted'] : DEFAULT_SETTINGS.muted;
  const uiScale = typeof input['uiScale'] === 'number' && UI_SCALES.includes(input['uiScale'])
    ? input['uiScale']
    : DEFAULT_SETTINGS.uiScale;
  const motion = input['motion'] === 'reduce' || input['motion'] === 'full' || input['motion'] === 'system'
    ? input['motion']
    : DEFAULT_SETTINGS.motion;
  return Object.freeze({
    volume,
    muted,
    uiScale,
    motion,
    bindings: readBindings(input['bindings']),
    objectives: readObjectives(input['objectives']),
  });
}

function readBindings(raw: unknown): Readonly<Record<string, string>> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [code, action] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof action === 'string') out[code] = action;
  }
  return Object.freeze(out);
}

function readObjectives(raw: unknown): ObjectiveProgress {
  if (raw === null || typeof raw !== 'object') return DEFAULT_SETTINGS.objectives;
  const input = raw as Record<string, unknown>;
  const visible = typeof input['visible'] === 'boolean' ? input['visible'] : true;
  const done = Array.isArray(input['done'])
    ? input['done'].filter((id): id is string => typeof id === 'string' && id.length <= 64).slice(0, 64)
    : [];
  return Object.freeze({ visible, done: Object.freeze([...new Set(done)]) });
}
