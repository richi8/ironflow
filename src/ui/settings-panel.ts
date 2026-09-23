/**
 * Settings: sound, size, motion and keys. See ironflow.md C30 tasks 1 and 3.
 *
 * The tenth panel. It changes nothing in the game — every control is a
 * preference, kept in `localStorage` by the composition root (§4 keeps
 * `ui/**` out of `platform/**`), and nothing here reaches the simulation or
 * a save. It follows §13 as the others do: built once in `mount()` from the
 * first view, then repainted by assignment.
 *
 * ## Rebinding
 *
 * Every action is a row: what it does, the keys on it, and CHANGE. CHANGE
 * listens for the next key, on `window` in the capture phase so nothing else
 * hears it — not the game, which would act on it, and not the UI's Escape,
 * which would close the panel. Escape and Tab cancel instead of binding: a
 * game with Escape bound to "walk left" has no way back out of anything, and
 * Tab is how a keyboard moves between these very buttons.
 *
 * A key taken from another action leaves that action without it, and the row
 * says so by showing its keys, or "unbound". The key list comes from the
 * input layer through the view, so this panel never learns what a binding is.
 */

import { createIcon } from './icons.js';

export type MotionChoice = 'system' | 'reduce' | 'full';

export interface BindingRowView {
  readonly action: string;
  readonly label: string;
  /** What is on it, as the player reads it: `W`, `↑`, `Num +`. */
  readonly keys: readonly string[];
}

export interface SettingsView {
  readonly volume: number;
  readonly muted: boolean;
  readonly uiScale: number;
  readonly scales: readonly number[];
  readonly motion: MotionChoice;
  /** Does the operating system ask for reduced motion? For the SYSTEM label. */
  readonly systemReducesMotion: boolean;
  readonly objectivesVisible: boolean;
  readonly bindings: readonly BindingRowView[];
}

export interface SettingsPanelOptions {
  readonly onVolume: (volume: number) => void;
  readonly onMuted: (muted: boolean) => void;
  readonly onScale: (scale: number) => void;
  readonly onMotion: (motion: MotionChoice) => void;
  readonly onObjectives: (visible: boolean) => void;
  /** Put `code` on `action`, in place of the keys it had. */
  readonly onBind: (action: string, code: string) => void;
  readonly onResetBindings: () => void;
  readonly onClose: () => void;
}

/** The words. Central, per C30's out-of-scope line on localisation. */
const TEXT = Object.freeze({
  title: 'SETTINGS',
  sound: 'SOUND',
  volume: 'Volume',
  mute: 'Mute',
  display: 'DISPLAY',
  scale: 'Interface size',
  motion: 'Motion',
  motionSystem: (reduces: boolean) => `Follow the system (${reduces ? 'reduced' : 'full'})`,
  motionReduce: 'Reduced — belts, arms and machines hold still',
  motionFull: 'Full',
  help: 'HELP',
  objectives: 'Show the first-steps list',
  keys: 'KEYS',
  change: 'Change',
  listening: 'Press a key…',
  unbound: 'unbound',
  reset: 'Reset all keys',
  keysNote: 'Escape cancels. Escape and Tab cannot be bound.',
});

interface BindingRow {
  readonly root: HTMLElement;
  readonly keys: HTMLElement;
  readonly change: HTMLButtonElement;
}

export class SettingsPanel {
  private readonly root = document.createElement('section');
  private readonly closeButton = document.createElement('button');
  private readonly volume = document.createElement('input');
  private readonly volumeValue = document.createElement('span');
  private readonly mute = document.createElement('input');
  private readonly scale = document.createElement('select');
  private readonly motion = document.createElement('select');
  private readonly objectives = document.createElement('input');
  private readonly resetButton = document.createElement('button');
  private readonly rows = new Map<string, BindingRow>();
  private readonly options: SettingsPanelOptions;

  /** The action CHANGE is listening for, or null. */
  private capturing: string | null = null;

  constructor(options: SettingsPanelOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement, view: SettingsView): void {
    this.root.className = 'if-settings';
    this.root.hidden = true;
    this.root.tabIndex = -1;
    this.root.setAttribute('aria-label', 'Settings');

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = TEXT.title;
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (O)';
    this.closeButton.setAttribute('aria-label', 'Close the settings');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('settings'), title, this.closeButton);

    const body = document.createElement('div');
    body.className = 'if-settings__body';
    body.append(this.createGeneral(view), this.createKeys(view));

    this.root.append(head, body);
    parent.append(this.root);
    this.update(view);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Is CHANGE waiting for a key? The UI's Escape leaves the panel alone while it is. */
  isCapturing(): boolean {
    return this.capturing !== null;
  }

  setOpen(open: boolean): void {
    this.root.hidden = !open;
    if (!open) this.stopCapture();
  }

  /** Repaint. Assignment only (§13). */
  update(view: SettingsView): void {
    const percent = Math.round(view.volume * 100);
    if (this.volume.valueAsNumber !== percent) this.volume.value = String(percent);
    setText(this.volumeValue, `${percent}%`);
    this.mute.checked = view.muted;
    this.scale.value = String(view.uiScale);
    this.motion.value = view.motion;
    const system = this.motion.querySelector<HTMLOptionElement>('option[value="system"]');
    if (system !== null) setText(system, TEXT.motionSystem(view.systemReducesMotion));
    this.objectives.checked = view.objectivesVisible;

    for (const binding of view.bindings) {
      const row = this.rows.get(binding.action);
      if (row === undefined) continue;
      setText(row.keys, binding.keys.length === 0 ? TEXT.unbound : binding.keys.join('  '));
      row.root.classList.toggle('is-unbound', binding.keys.length === 0);
      if (this.capturing !== binding.action) setText(row.change, TEXT.change);
    }
  }

  destroy(): void {
    this.stopCapture();
    this.closeButton.removeEventListener('click', this.handleClose);
    this.volume.removeEventListener('input', this.handleVolume);
    this.mute.removeEventListener('change', this.handleMute);
    this.scale.removeEventListener('change', this.handleScale);
    this.motion.removeEventListener('change', this.handleMotion);
    this.objectives.removeEventListener('change', this.handleObjectives);
    this.resetButton.removeEventListener('click', this.handleReset);
    for (const row of this.rows.values()) row.change.removeEventListener('click', this.handleChange);
    this.rows.clear();
    this.root.remove();
  }

  private createGeneral(view: SettingsView): HTMLElement {
    const column = document.createElement('div');
    column.className = 'if-settings__column';

    column.append(heading(TEXT.sound));
    this.volume.type = 'range';
    this.volume.min = '0';
    this.volume.max = '100';
    this.volume.step = '5';
    this.volume.className = 'if-settings__range';
    this.volume.addEventListener('input', this.handleVolume);
    this.volumeValue.className = 'if-settings__value';
    column.append(field(TEXT.volume, this.volume, this.volumeValue));
    this.mute.type = 'checkbox';
    this.mute.addEventListener('change', this.handleMute);
    column.append(field(TEXT.mute, this.mute));

    column.append(heading(TEXT.display));
    for (const scale of view.scales) {
      const option = document.createElement('option');
      option.value = String(scale);
      option.textContent = `${Math.round(scale * 100)}%`;
      this.scale.append(option);
    }
    this.scale.addEventListener('change', this.handleScale);
    column.append(field(TEXT.scale, this.scale));
    for (const [value, label] of [
      ['system', TEXT.motionSystem(view.systemReducesMotion)],
      ['reduce', TEXT.motionReduce],
      ['full', TEXT.motionFull],
    ] as const) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      this.motion.append(option);
    }
    this.motion.addEventListener('change', this.handleMotion);
    column.append(field(TEXT.motion, this.motion));

    column.append(heading(TEXT.help));
    this.objectives.type = 'checkbox';
    this.objectives.addEventListener('change', this.handleObjectives);
    column.append(field(TEXT.objectives, this.objectives));
    return column;
  }

  private createKeys(view: SettingsView): HTMLElement {
    const column = document.createElement('div');
    column.className = 'if-settings__column if-settings__keys';
    column.append(heading(TEXT.keys));

    const list = document.createElement('div');
    list.className = 'if-settings__bindings';
    for (const binding of view.bindings) {
      const root = document.createElement('div');
      root.className = 'if-binding';
      const label = document.createElement('span');
      label.className = 'if-binding__label';
      label.textContent = binding.label;
      const keys = document.createElement('span');
      keys.className = 'if-binding__keys';
      const change = document.createElement('button');
      change.type = 'button';
      change.className = 'if-binding__change';
      change.dataset['action'] = binding.action;
      change.setAttribute('aria-label', `Change the key for ${binding.label}`);
      change.addEventListener('click', this.handleChange);
      root.append(label, keys, change);
      list.append(root);
      this.rows.set(binding.action, { root, keys, change });
    }

    const note = document.createElement('p');
    note.className = 'if-settings__note';
    note.textContent = TEXT.keysNote;
    this.resetButton.type = 'button';
    this.resetButton.className = 'if-saves__action';
    this.resetButton.textContent = TEXT.reset;
    this.resetButton.addEventListener('click', this.handleReset);
    column.append(list, note, this.resetButton);
    return column;
  }

  private readonly handleClose = (): void => this.options.onClose();

  private readonly handleVolume = (): void => {
    const value = this.volume.valueAsNumber;
    if (Number.isFinite(value)) this.options.onVolume(value / 100);
  };

  private readonly handleMute = (): void => this.options.onMuted(this.mute.checked);

  private readonly handleScale = (): void => {
    const value = Number(this.scale.value);
    if (Number.isFinite(value)) this.options.onScale(value);
  };

  private readonly handleMotion = (): void => {
    const value = this.motion.value;
    if (value === 'system' || value === 'reduce' || value === 'full') this.options.onMotion(value);
  };

  private readonly handleObjectives = (): void => this.options.onObjectives(this.objectives.checked);

  private readonly handleReset = (): void => {
    this.stopCapture();
    this.options.onResetBindings();
  };

  private readonly handleChange = (event: Event): void => {
    const target = event.currentTarget;
    const action = target instanceof HTMLElement ? target.dataset['action'] : undefined;
    if (action === undefined) return;
    const wasListening = this.capturing === action;
    this.stopCapture();
    if (wasListening) return;
    this.capturing = action;
    const row = this.rows.get(action);
    if (row !== undefined) setText(row.change, TEXT.listening);
    window.addEventListener('keydown', this.handleCapture, true);
  };

  /** The key CHANGE was waiting for. Nothing else hears it. */
  private readonly handleCapture = (event: KeyboardEvent): void => {
    const action = this.capturing;
    if (action === null || event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    this.stopCapture();
    if (event.code === 'Escape' || event.code === 'Tab' || event.code === '') return;
    this.options.onBind(action, event.code);
  };

  private stopCapture(): void {
    const action = this.capturing;
    if (action === null) return;
    this.capturing = null;
    window.removeEventListener('keydown', this.handleCapture, true);
    const row = this.rows.get(action);
    if (row !== undefined) setText(row.change, TEXT.change);
  }
}

function heading(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'if-inspector__label';
  element.textContent = text;
  return element;
}

/** A labelled control: the label is a real `<label>`, so clicking the words works too. */
function field(text: string, control: HTMLElement, after?: HTMLElement): HTMLElement {
  const label = document.createElement('label');
  label.className = 'if-settings__field';
  const words = document.createElement('span');
  words.textContent = text;
  label.append(words, control);
  if (after !== undefined) label.append(after);
  return label;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
