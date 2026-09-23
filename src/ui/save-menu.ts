/**
 * The save menu. See ironflow.md C25 task 7 and §13.
 *
 * > Save menu UI: list with timestamps and playtime, save, load, delete with
 * > confirmation, and rename.
 *
 * ```text
 *   SAVES                                       [×]
 *   [ name .................................. ]  SAVE
 *   ─────────────────────────────────────────────
 *   ● Copper outpost      manual  4 min ago  1h 12m  148 kB
 *     Autosave 1          auto    9 min ago  1h 03m  141 kB
 *   ─────────────────────────────────────────────
 *   LOAD   OVERWRITE   RENAME   DELETE   EXPORT   IMPORT
 *   status line
 * ```
 *
 * ## One selected row, one set of verbs
 *
 * The obvious layout puts four buttons on every row, and the obvious layout is
 * how a player deletes the save they meant to load. A selected row plus one
 * set of buttons means the destructive verb is always two deliberate clicks
 * away from the thing it destroys — and `DELETE` is itself two clicks, which
 * is task 7's "with confirmation" without a modal the game would have to pause
 * behind.
 *
 * `EXPORT` and `IMPORT` (C26) are the two verbs that do not need a stored
 * slot: export writes the selected save — or, with nothing selected, the
 * running game — to a file, and import reads one back. They stay enabled
 * while `canWrite` is false, because a browser that cannot store a factory is
 * exactly the browser a player most needs to get one out of.
 *
 * `OVERWRITE` is offered for a manual slot and refused for an autosave one.
 * §14 says the rotation never overwrites a manual save; letting a manual save
 * land *in* the rotation would be the same mistake facing the other way — the
 * slot would be gone three minutes later and the player would have been told
 * it was saved.
 *
 * ## It builds its DOM once (§13)
 *
 * A fixed pool of rows, made in `mount()` and never created or destroyed — the
 * same rule `InventoryPanel` and `ResearchPanel` follow. A save
 * list is the first panel in the game whose length is not decided by a content
 * table, so the pool is a *cap*: `SAVE_ROWS` rows are drawn and a line says
 * how many more exist. The cap is generous against the three autosaves plus
 * what a player will actually keep, and a save browser that pages is C26's
 * problem at the earliest.
 *
 * ## It cannot touch storage
 *
 * §4 forbids `ui/**` from importing `persistence/**`, so the panel names an id
 * and a string and the composition root does the rest — the same arrangement
 * `MapPanel` uses for the camera. Everything it knows arrives in
 * `SaveMenuView`.
 */

import { createIcon } from './icons.js';

/** Rows drawn. Beyond this the panel says how many more there are. */
export const SAVE_ROWS = 16;

/** How long a `DELETE` stays armed before it forgets it was asked. */
export const DELETE_ARM_MS = 5000;

/** One slot, as the player reads it. */
export interface SaveSlotRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'manual' | 'auto';
  /** Wall-clock milliseconds it was written. */
  readonly savedAt: number;
  /** Simulated seconds of play the save is at. */
  readonly playtimeSeconds: number;
  /** Stored size, compressed where the browser could. */
  readonly bytes: number;
  /** Is this the slot this session is playing? */
  readonly current: boolean;
}

export interface SaveMenuView {
  readonly slots: readonly SaveSlotRow[];
  /** Slots that exist beyond the pool. Zero in every ordinary session. */
  readonly hidden: number;
  /** The last thing that happened, or the reason nothing can. Task 5. */
  readonly status: string | null;
  readonly tone: 'info' | 'warn' | 'error';
  /** False when storage is unavailable or another tab holds the lock. */
  readonly canWrite: boolean;
  /** A write or a read is in flight; every button is held. */
  readonly busy: boolean;
  /** Offer to take the write lock from the other tab (C25 task 6). */
  readonly offerTakeOver: boolean;
}

export interface SaveMenuOptions {
  /** Write a new manual slot under this name. */
  readonly onSave: (name: string) => void;
  /** Write over an existing manual slot. */
  readonly onOverwrite: (id: string, name: string) => void;
  readonly onLoad: (id: string) => void;
  readonly onDelete: (id: string) => void;
  readonly onRename: (id: string, name: string) => void;
  /** Write a file: the selected slot, or the running game when `id` is null. */
  readonly onExport: (id: string | null, name: string) => void;
  /** Read a file the player chose. The panel never opens it itself. */
  readonly onImport: (file: File) => void;
  readonly onTakeOver: () => void;
  readonly onClose: () => void;
}

interface Row {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly kind: HTMLElement;
  readonly when: HTMLElement;
  readonly playtime: HTMLElement;
  readonly size: HTMLElement;
}

export class SaveMenu {
  private readonly root = document.createElement('section');
  private readonly closeButton = document.createElement('button');
  private readonly nameInput = document.createElement('input');
  private readonly saveButton = document.createElement('button');
  private readonly list = document.createElement('div');
  private readonly empty = document.createElement('div');
  private readonly more = document.createElement('div');
  private readonly loadButton = document.createElement('button');
  private readonly overwriteButton = document.createElement('button');
  private readonly renameButton = document.createElement('button');
  private readonly deleteButton = document.createElement('button');
  private readonly exportButton = document.createElement('button');
  private readonly importButton = document.createElement('button');
  private readonly fileInput = document.createElement('input');
  private readonly takeOverButton = document.createElement('button');
  private readonly status = document.createElement('div');
  private readonly rows: Row[] = [];
  private readonly options: SaveMenuOptions;

  private open = false;
  private selected: string | null = null;
  /** The id `DELETE` is armed for, and when it was armed. Task 7's confirm. */
  private armed: { id: string; at: number } | null = null;
  private view: SaveMenuView = EMPTY_VIEW;

  constructor(options: SaveMenuOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-saves';
    this.root.hidden = true;

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = 'SAVES';
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (F2)';
    this.closeButton.setAttribute('aria-label', 'Close the save menu');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('save'), title, this.closeButton);

    const newRow = document.createElement('div');
    newRow.className = 'if-saves__new';
    this.nameInput.type = 'text';
    this.nameInput.className = 'if-saves__name';
    this.nameInput.maxLength = 48;
    this.nameInput.placeholder = 'Name this save';
    this.nameInput.setAttribute('aria-label', 'Save name');
    this.saveButton.type = 'button';
    this.saveButton.className = 'if-saves__action is-primary';
    this.saveButton.textContent = 'SAVE';
    this.saveButton.title = 'Write a new save under this name';
    this.saveButton.addEventListener('click', this.handleSave);
    newRow.append(this.nameInput, this.saveButton);

    this.list.className = 'if-saves__list';
    for (let index = 0; index < SAVE_ROWS; index++) this.list.append(this.createRow());

    this.empty.className = 'if-inventory__empty';
    this.empty.textContent = 'No saves yet. The game autosaves every three minutes once you start playing.';

    this.more.className = 'if-saves__more';
    this.more.hidden = true;

    const actions = document.createElement('div');
    actions.className = 'if-saves__actions';
    actions.append(
      this.createAction(this.loadButton, 'LOAD', 'Replace the running game with this save', this.handleLoad),
      this.createAction(this.overwriteButton, 'OVERWRITE', 'Write over this save', this.handleOverwrite),
      this.createAction(this.renameButton, 'RENAME', 'Rename this save to the text above', this.handleRename),
      this.createAction(this.deleteButton, 'DELETE', 'Delete this save — click twice', this.handleDelete),
      this.createAction(this.exportButton, 'EXPORT', 'Write this save to a file you can keep', this.handleExport),
      this.createAction(this.importButton, 'IMPORT', 'Open a save file — you can also drop one on the window', this.handleImport),
      this.createAction(this.takeOverButton, 'TAKE OVER', 'Make this tab the one that saves', this.handleTakeOver),
    );

    // The real picker, kept out of the layout: a styled button that opens a
    // hidden input is the only way to have a file dialog and a panel that
    // looks like the rest of the game.
    this.fileInput.type = 'file';
    this.fileInput.accept = '.ifsave,application/octet-stream';
    this.fileInput.hidden = true;
    this.fileInput.setAttribute('aria-hidden', 'true');
    this.fileInput.addEventListener('change', this.handleFileChosen);
    actions.append(this.fileInput);
    this.deleteButton.classList.add('is-danger');
    this.takeOverButton.hidden = true;

    this.status.className = 'if-saves__status';

    this.root.append(head, newRow, this.empty, this.list, this.more, actions, this.status);
    parent.append(this.root);
    this.paint();
  }

  /** Repaint from a snapshot. §13: assignment and classes, never a rebuild. */
  update(view: SaveMenuView): void {
    this.view = view;
    // A selection whose slot has been deleted — by this tab or another — is
    // not a selection, and an armed DELETE pointing at nothing is worse.
    if (this.selected !== null && !view.slots.some((slot) => slot.id === this.selected)) {
      this.selected = null;
      this.armed = null;
    }
    this.paint();
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    if (this.open === open) return;
    this.open = open;
    this.root.hidden = !open;
    // Arming is a gesture, not a state: it must not survive the panel closing
    // and being opened again ten minutes later.
    this.armed = null;
    if (open) this.paint();
  }

  /** The id the player has picked, for the composition root's status line. */
  getSelection(): string | null {
    return this.selected;
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    this.saveButton.removeEventListener('click', this.handleSave);
    this.loadButton.removeEventListener('click', this.handleLoad);
    this.overwriteButton.removeEventListener('click', this.handleOverwrite);
    this.renameButton.removeEventListener('click', this.handleRename);
    this.deleteButton.removeEventListener('click', this.handleDelete);
    this.exportButton.removeEventListener('click', this.handleExport);
    this.importButton.removeEventListener('click', this.handleImport);
    this.fileInput.removeEventListener('change', this.handleFileChosen);
    this.takeOverButton.removeEventListener('click', this.handleTakeOver);
    for (const row of this.rows) row.button.removeEventListener('click', this.handleRow);
    this.root.remove();
    this.rows.length = 0;
  }

  /* ---------------------------------------------------------------- *
   * Events
   * ---------------------------------------------------------------- */

  private readonly handleClose = (): void => {
    this.options.onClose();
  };

  private readonly handleSave = (): void => {
    this.options.onSave(this.saveName());
  };

  private readonly handleLoad = (): void => {
    const slot = this.selectedSlot();
    if (slot !== null) this.options.onLoad(slot.id);
  };

  private readonly handleOverwrite = (): void => {
    const slot = this.selectedSlot();
    if (slot !== null && slot.kind === 'manual') this.options.onOverwrite(slot.id, this.saveName());
  };

  private readonly handleRename = (): void => {
    const slot = this.selectedSlot();
    if (slot !== null) this.options.onRename(slot.id, this.saveName());
  };

  /**
   * First click arms, second deletes. Task 7's confirmation.
   *
   * A two-step button rather than a `confirm()` or a modal: the dialog would
   * block the frame loop the game is drawing from, and §8 already has one
   * thing it wants a pause for. The arming expires, so a player who walks away
   * does not come back to a live delete under the cursor.
   */
  private readonly handleDelete = (): void => {
    const slot = this.selectedSlot();
    if (slot === null) return;
    const now = Date.now();
    if (this.armed !== null && this.armed.id === slot.id && now - this.armed.at <= DELETE_ARM_MS) {
      this.armed = null;
      // Disarm on screen before the delete is asked for: the new list arrives
      // a round trip later, and a button still reading DELETE? in the meantime
      // is a button the player clicks again.
      this.paint();
      this.options.onDelete(slot.id);
      return;
    }
    this.armed = { id: slot.id, at: now };
    this.paint();
  };

  /** Export the selected slot, or the running game when nothing is selected. */
  private readonly handleExport = (): void => {
    const slot = this.selectedSlot();
    this.options.onExport(slot?.id ?? null, slot?.name ?? this.saveName());
  };

  private readonly handleImport = (): void => {
    this.fileInput.click();
  };

  private readonly handleFileChosen = (): void => {
    const file = this.fileInput.files?.[0];
    // Cleared whatever happens, so choosing the same file twice in a row
    // fires a second `change` — which it otherwise would not.
    this.fileInput.value = '';
    if (file !== undefined) this.options.onImport(file);
  };

  private readonly handleTakeOver = (): void => {
    this.options.onTakeOver();
  };

  private readonly handleRow = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const id = target.dataset['saveId'] ?? '';
    if (id === '') return;
    this.selected = id;
    this.armed = null;
    const slot = this.view.slots.find((candidate) => candidate.id === id);
    // Picking a row fills the name box with its name, so RENAME and OVERWRITE
    // have something sensible in them without the player retyping it.
    if (slot !== undefined) this.nameInput.value = slot.name;
    this.paint();
  };

  /* ---------------------------------------------------------------- *
   * Painting
   * ---------------------------------------------------------------- */

  private paint(): void {
    const view = this.view;
    const now = Date.now();

    this.rows.forEach((row, index) => {
      const slot = view.slots[index];
      if (slot === undefined) {
        row.button.hidden = true;
        row.button.dataset['saveId'] = '';
        return;
      }
      row.button.hidden = false;
      row.button.dataset['saveId'] = slot.id;
      setText(row.name, slot.name);
      setText(row.kind, slot.kind === 'auto' ? 'auto' : 'manual');
      setText(row.when, formatAge(now - slot.savedAt));
      setText(row.playtime, formatPlaytime(slot.playtimeSeconds));
      setText(row.size, formatSize(slot.bytes));
      row.button.classList.toggle('is-selected', slot.id === this.selected);
      row.button.classList.toggle('is-current', slot.current);
      row.button.classList.toggle('is-auto', slot.kind === 'auto');
      row.button.title = `${slot.name} — saved ${formatAge(now - slot.savedAt)}`;
    });

    this.empty.hidden = view.slots.length > 0;
    this.more.hidden = view.hidden <= 0;
    if (view.hidden > 0) setText(this.more, `…and ${view.hidden} more not shown.`);

    const slot = this.selectedSlot();
    const busy = view.busy;
    this.saveButton.disabled = busy || !view.canWrite;
    this.loadButton.disabled = busy || slot === null;
    this.overwriteButton.disabled = busy || slot === null || slot.kind === 'auto' || !view.canWrite;
    this.renameButton.disabled = busy || slot === null || !view.canWrite;
    this.deleteButton.disabled = busy || slot === null || !view.canWrite;
    // Neither export nor import needs storage; see the file header.
    this.exportButton.disabled = busy;
    this.importButton.disabled = busy;
    setText(this.exportButton, slot === null ? 'EXPORT GAME' : 'EXPORT');

    const armed = this.armed !== null && slot !== null && this.armed.id === slot.id;
    setText(this.deleteButton, armed ? 'DELETE?' : 'DELETE');
    this.deleteButton.classList.toggle('is-armed', armed);

    this.takeOverButton.hidden = !view.offerTakeOver;
    this.takeOverButton.disabled = busy;

    setText(this.status, view.status ?? '');
    this.status.classList.toggle('is-warn', view.tone === 'warn');
    this.status.classList.toggle('is-error', view.tone === 'error');
  }

  /** The typed name, or a readable default rather than an empty string. */
  private saveName(): string {
    const typed = this.nameInput.value.trim();
    return typed === '' ? 'Factory' : typed;
  }

  private selectedSlot(): SaveSlotRow | null {
    if (this.selected === null) return null;
    return this.view.slots.find((slot) => slot.id === this.selected) ?? null;
  }

  private createAction(button: HTMLButtonElement, label: string, title: string, handler: () => void): HTMLButtonElement {
    button.type = 'button';
    button.className = 'if-saves__action';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', handler);
    return button;
  }

  private createRow(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'if-save-row';
    button.hidden = true;
    button.addEventListener('click', this.handleRow);

    const name = document.createElement('span');
    name.className = 'if-save-row__name';
    const kind = document.createElement('span');
    kind.className = 'if-save-row__kind';
    const when = document.createElement('span');
    when.className = 'if-save-row__when';
    const playtime = document.createElement('span');
    playtime.className = 'if-save-row__playtime';
    const size = document.createElement('span');
    size.className = 'if-save-row__size';

    button.append(name, kind, when, playtime, size);
    this.rows.push({ button, name, kind, when, playtime, size });
    return button;
  }
}

const EMPTY_VIEW: SaveMenuView = Object.freeze({
  slots: Object.freeze([]),
  hidden: 0,
  status: null,
  tone: 'info' as const,
  canWrite: true,
  busy: false,
  offerTakeOver: false,
});

/**
 * How long ago, in words.
 *
 * Relative rather than a timestamp, and deliberately not `toLocaleString`:
 * what a player wants from a save list is "is this the one I was just
 * playing?", which is a duration. A date only starts being the better answer
 * a day out, which is where this switches to one.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Simulated time, as hours and minutes rather than as a tick count. */
export function formatPlaytime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0m';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes > 0) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`;
  return `${total}s`;
}

/** Stored size. kB and MB in their decimal senses, which is what disks report. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} kB`;
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
