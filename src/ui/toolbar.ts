/**
 * The hotbar. See ironflow.md C07 task 3 and §13.
 *
 * Nine slots along the bottom, bound to the number row, plus the button that
 * opens the full build menu. Slot *n* is the *n*th entry of
 * `data/buildings.ts` — the same resolution the keyboard uses, because both go
 * through `GameController.selectSlot` and neither knows what a building is.
 *
 * The nine slots are built once in `mount()` and never recreated: a slot past
 * the end of the content table is an empty tile today and fills itself in the
 * moment a building is added, which is C06's last acceptance criterion still
 * holding one chunk later. Updating is assignment and class toggles only (§13).
 */

import type { BuildMenuEntry, BuildMenuView } from '../game/views/build-menu-view.js';
import { HOTBAR_SLOTS } from '../game/game-controller.js';

interface Slot {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
}

export interface ToolbarOptions {
  /** Slot number, 1-based. The controller decides what that means. */
  readonly onSelectSlot: (slot: number) => void;
  readonly onToggleBuildMenu: () => void;
  /** Open or close the inventory panel (C21A). */
  readonly onToggleInventory: () => void;
}

/** Rotation as the player reads it, in tile space (§5 — no isometric words). */
const ROTATION_LABELS = ['N', 'E', 'S', 'W'] as const;

export class Toolbar {
  private readonly root = document.createElement('div');
  private readonly slots: Slot[] = [];
  private readonly menuButton = document.createElement('button');
  private readonly bagButton = document.createElement('button');
  private readonly rotationLabel = document.createElement('span');
  private readonly options: ToolbarOptions;

  constructor(options: ToolbarOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-toolbar';

    this.menuButton.type = 'button';
    this.menuButton.className = 'if-toolbar__menu';
    this.menuButton.textContent = 'BUILD';
    this.menuButton.title = 'Open the build menu (B)';
    this.menuButton.addEventListener('click', this.handleMenu);
    this.root.append(this.menuButton);

    // Beside BUILD rather than in the HUD's row of read-outs, because it is
    // the same kind of thing: a panel the player opens with their left hand
    // while the right one is on the map.
    this.bagButton.type = 'button';
    this.bagButton.className = 'if-toolbar__menu';
    this.bagButton.textContent = 'BAG';
    this.bagButton.title = 'Open your inventory and craft by hand (I)';
    this.bagButton.addEventListener('click', this.handleBag);
    this.root.append(this.bagButton);

    for (let slot = 1; slot <= HOTBAR_SLOTS; slot++) {
      this.root.append(this.createSlot(slot));
    }

    this.rotationLabel.className = 'if-toolbar__rotation';
    this.rotationLabel.title = 'Facing — R rotates';
    this.rotationLabel.textContent = '';
    this.root.append(this.rotationLabel);

    parent.append(this.root);
  }

  /** Repaint from a snapshot. Called on `buildMenuChanged`, not on a timer (§13). */
  update(view: BuildMenuView): void {
    this.slots.forEach((slot, index) => {
      const entry: BuildMenuEntry | undefined = view.entries[index];
      this.paintSlot(slot, entry);
    });

    const held = view.selectedBuildingId !== null;
    const label = held ? (ROTATION_LABELS[view.rotation] ?? '') : '';
    if (this.rotationLabel.textContent !== label) this.rotationLabel.textContent = label;
    this.rotationLabel.classList.toggle('is-active', held);
  }

  setBuildMenuOpen(open: boolean): void {
    this.menuButton.classList.toggle('is-active', open);
    this.menuButton.setAttribute('aria-pressed', String(open));
  }

  setInventoryOpen(open: boolean): void {
    this.bagButton.classList.toggle('is-active', open);
    this.bagButton.setAttribute('aria-pressed', String(open));
  }

  destroy(): void {
    this.menuButton.removeEventListener('click', this.handleMenu);
    this.bagButton.removeEventListener('click', this.handleBag);
    for (const slot of this.slots) slot.button.removeEventListener('click', this.handleSlot);
    this.root.remove();
    this.slots.length = 0;
  }

  private readonly handleMenu = (): void => {
    this.options.onToggleBuildMenu();
  };

  private readonly handleBag = (): void => {
    this.options.onToggleInventory();
  };

  /**
   * One listener for all nine slots, reading the slot number off the element.
   *
   * The alternative — a closure per slot — allocates nine functions that can
   * never be removed by the same reference they were added with, which is how
   * a `destroy()` quietly stops working.
   */
  private readonly handleSlot = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const slot = Number(target.dataset['slot']);
    if (Number.isInteger(slot)) this.options.onSelectSlot(slot);
  };

  private createSlot(slot: number): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'if-slot';
    button.dataset['slot'] = String(slot);
    button.addEventListener('click', this.handleSlot);

    const key = document.createElement('span');
    key.className = 'if-slot__key';
    key.textContent = String(slot);

    const name = document.createElement('span');
    name.className = 'if-slot__name';
    name.textContent = '';

    const count = document.createElement('span');
    count.className = 'if-slot__count';
    count.textContent = '';

    button.append(key, name, count);
    this.slots.push({ button, name, count });
    return button;
  }

  private paintSlot(slot: Slot, entry: BuildMenuEntry | undefined): void {
    const { button, name, count } = slot;

    if (entry === undefined) {
      setText(name, '');
      setText(count, '');
      button.classList.add('is-empty');
      button.classList.remove('is-selected', 'is-unaffordable', 'is-locked');
      button.disabled = true;
      button.title = '';
      return;
    }

    setText(name, entry.name);
    setText(count, String(stockOf(entry)));
    button.classList.remove('is-empty');
    button.classList.toggle('is-selected', entry.selected);
    button.classList.toggle('is-unaffordable', !entry.affordable);
    button.classList.toggle('is-locked', !entry.unlocked);
    button.disabled = false;
    button.title = `${entry.name} — ${describeCost(entry)}`;
  }
}

/**
 * How many more of this building the player could place.
 *
 * The smallest ratio across the cost lines. §15 makes every build cost a single
 * stack of the building's own item, so today this is just "how many you have" —
 * but writing it as the limiting line means a two-item cost in a later chunk
 * shows the right number without anyone revisiting this file.
 */
function stockOf(entry: BuildMenuEntry): number {
  let limit = Infinity;
  for (const line of entry.cost) {
    if (line.count <= 0) continue;
    limit = Math.min(limit, Math.floor(line.held / line.count));
  }
  return Number.isFinite(limit) ? limit : 0;
}

function describeCost(entry: BuildMenuEntry): string {
  if (entry.cost.length === 0) return 'free';
  return entry.cost.map((line) => `${line.count}x ${line.itemId} (${line.held})`).join(', ');
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
