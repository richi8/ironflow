/**
 * The hotbar. See ironflow.md C07 task 3 and §13.
 *
 * Nine slots along the bottom, bound to the number row, beside the buttons
 * that open the other panels. What each slot holds is the player's: a
 * building is dragged onto a slot from the inventory, dragged from one slot
 * to another to swap the two, and taken off with a right-click. The toolbar only reports those gestures — the controller keeps
 * the arrangement, and slot *n* means the same thing to a click here and to
 * the number key, because both go through `GameController.selectSlot`.
 *
 * The nine slots are built once in `mount()` and never recreated. Updating is
 * assignment and class toggles only (§13).
 */

import type { BuildMenuEntry, BuildMenuView } from '../game/views/build-menu-view.js';
import { HOTBAR_SLOTS } from '../game/game-controller.js';

/**
 * The drag payload for a building on its way to the hotbar. A type of its
 * own, so the slots ignore a drag of anything else — a file, a link, text.
 */
export const BUILDING_DRAG_TYPE = 'application/x-ironflow-building';

/** The drag payload for a slot's building on its way to another slot: the source slot, 1-based. */
export const SLOT_DRAG_TYPE = 'application/x-ironflow-slot';

interface Slot {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
}

export interface ToolbarOptions {
  /** Slot number, 1-based. The controller decides what that means. */
  readonly onSelectSlot: (slot: number) => void;
  /** A building was dropped on slot `slot` (1-based). */
  readonly onAssignSlot: (slot: number, buildingId: string) => void;
  /** Slot `slot` (1-based) was right-clicked: empty it. */
  readonly onClearSlot: (slot: number) => void;
  /** Slot `from`'s building was dropped on slot `to` (both 1-based): swap them. */
  readonly onMoveSlot: (from: number, to: number) => void;
  /** Open or close the inventory panel (C21A). */
  readonly onToggleInventory: () => void;
  /** Open or close the technology tree (C22). */
  readonly onToggleResearch: () => void;
  /** Open or close the map (C23). */
  readonly onToggleMap: () => void;
  /** Open or close the save menu (C25). */
  readonly onToggleSaveMenu: () => void;
}

/** Rotation as the player reads it, in tile space (§5 — no isometric words). */
const ROTATION_LABELS = ['N', 'E', 'S', 'W'] as const;

export class Toolbar {
  private readonly root = document.createElement('div');
  private readonly slots: Slot[] = [];
  private readonly bagButton = document.createElement('button');
  private readonly techButton = document.createElement('button');
  private readonly mapButton = document.createElement('button');
  private readonly saveButton = document.createElement('button');
  private readonly rotationLabel = document.createElement('span');
  private readonly options: ToolbarOptions;

  constructor(options: ToolbarOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-toolbar';

    // Here rather than in the HUD's row of read-outs: a panel the player opens
    // with their left hand while the right one is on the map — and the bag is
    // where the hotbar is filled from.
    this.bagButton.type = 'button';
    this.bagButton.className = 'if-toolbar__menu';
    this.bagButton.textContent = 'BAG';
    this.bagButton.title = 'Open your inventory and craft by hand (I)';
    this.bagButton.addEventListener('click', this.handleBag);
    this.root.append(this.bagButton);

    // The third panel that opens from here, for the bag's reason (C22).
    this.techButton.type = 'button';
    this.techButton.className = 'if-toolbar__menu';
    this.techButton.textContent = 'TECH';
    this.techButton.title = 'Open the technology tree (T)';
    this.techButton.addEventListener('click', this.handleTech);
    this.root.append(this.techButton);

    // The fourth, and the one a player reaches for most once the factory has
    // outgrown the starting patch (C23).
    this.mapButton.type = 'button';
    this.mapButton.className = 'if-toolbar__menu';
    this.mapButton.textContent = 'MAP';
    this.mapButton.title = 'Open the map (M)';
    this.mapButton.addEventListener('click', this.handleMap);
    this.root.append(this.mapButton);

    // The fifth, and the one a player needs to be able to find without having
    // read a keybinding list — which is the whole argument for the four above
    // it, and it applies hardest to the panel that keeps their factory.
    this.saveButton.type = 'button';
    this.saveButton.className = 'if-toolbar__menu';
    this.saveButton.textContent = 'SAVE';
    this.saveButton.title = 'Open the save menu (F2)';
    this.saveButton.addEventListener('click', this.handleSave);
    this.root.append(this.saveButton);

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
      this.paintSlot(slot, view.hotbar[index] ?? undefined);
    });

    const held = view.selectedBuildingId !== null;
    const label = held ? (ROTATION_LABELS[view.rotation] ?? '') : '';
    if (this.rotationLabel.textContent !== label) this.rotationLabel.textContent = label;
    this.rotationLabel.classList.toggle('is-active', held);
  }

  setInventoryOpen(open: boolean): void {
    this.bagButton.classList.toggle('is-active', open);
    this.bagButton.setAttribute('aria-pressed', String(open));
  }

  setResearchOpen(open: boolean): void {
    this.techButton.classList.toggle('is-active', open);
    this.techButton.setAttribute('aria-pressed', String(open));
  }

  setMapOpen(open: boolean): void {
    this.mapButton.classList.toggle('is-active', open);
    this.mapButton.setAttribute('aria-pressed', String(open));
  }

  setSaveMenuOpen(open: boolean): void {
    this.saveButton.classList.toggle('is-active', open);
    this.saveButton.setAttribute('aria-pressed', String(open));
  }

  destroy(): void {
    this.bagButton.removeEventListener('click', this.handleBag);
    this.techButton.removeEventListener('click', this.handleTech);
    this.mapButton.removeEventListener('click', this.handleMap);
    this.saveButton.removeEventListener('click', this.handleSave);
    for (const slot of this.slots) {
      slot.button.removeEventListener('click', this.handleSlot);
      slot.button.removeEventListener('contextmenu', this.handleClear);
      slot.button.removeEventListener('dragstart', this.handleDragStart);
      slot.button.removeEventListener('dragover', this.handleDragOver);
      slot.button.removeEventListener('dragleave', this.handleDragLeave);
      slot.button.removeEventListener('drop', this.handleDrop);
    }
    this.root.remove();
    this.slots.length = 0;
  }

  private readonly handleTech = (): void => {
    this.options.onToggleResearch();
  };

  private readonly handleMap = (): void => {
    this.options.onToggleMap();
  };

  private readonly handleBag = (): void => {
    this.options.onToggleInventory();
  };

  private readonly handleSave = (): void => {
    this.options.onToggleSaveMenu();
  };

  /**
   * One listener for all nine slots, reading the slot number off the element.
   *
   * The alternative — a closure per slot — allocates nine functions that can
   * never be removed by the same reference they were added with, which is how
   * a `destroy()` quietly stops working.
   */
  private readonly handleSlot = (event: Event): void => {
    const slot = slotOf(event);
    if (slot !== null) this.options.onSelectSlot(slot);
  };

  /** Right-click takes a building off the bar. The browser's menu never opens over a slot. */
  private readonly handleClear = (event: Event): void => {
    event.preventDefault();
    const slot = slotOf(event);
    if (slot !== null) this.options.onClearSlot(slot);
  };

  /** Accept a building being dragged over, and nothing else. */
  private readonly handleDragOver = (event: DragEvent): void => {
    if (!carriesBuilding(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) {
      event.dataTransfer.dropEffect = Array.from(event.dataTransfer.types).includes(SLOT_DRAG_TYPE) ? 'move' : 'copy';
    }
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.add('is-drop-target');
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove('is-drop-target');
  };

  private readonly handleDrop = (event: DragEvent): void => {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove('is-drop-target');
    const slot = slotOf(event);
    if (slot === null) return;

    // From another slot: a swap, which keeps both buildings on the bar.
    const from = Number(event.dataTransfer?.getData(SLOT_DRAG_TYPE) ?? '');
    if (Number.isInteger(from) && from > 0) {
      event.preventDefault();
      this.options.onMoveSlot(from, slot);
      return;
    }

    const buildingId = event.dataTransfer?.getData(BUILDING_DRAG_TYPE) ?? '';
    if (buildingId === '') return;
    event.preventDefault();
    this.options.onAssignSlot(slot, buildingId);
  };

  /** Pick a slot's building up to move it. An empty slot has nothing to drag. */
  private readonly handleDragStart = (event: DragEvent): void => {
    const slot = slotOf(event);
    const target = event.currentTarget;
    if (slot === null || event.dataTransfer === null || !(target instanceof HTMLElement) || !target.draggable) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(SLOT_DRAG_TYPE, String(slot));
    event.dataTransfer.effectAllowed = 'move';
  };

  private createSlot(slot: number): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'if-slot';
    button.dataset['slot'] = String(slot);
    button.addEventListener('click', this.handleSlot);
    button.addEventListener('contextmenu', this.handleClear);
    button.addEventListener('dragstart', this.handleDragStart);
    button.addEventListener('dragover', this.handleDragOver);
    button.addEventListener('dragleave', this.handleDragLeave);
    button.addEventListener('drop', this.handleDrop);

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
      button.draggable = false;
      // Not disabled: a disabled button receives no drag events, and an empty
      // slot is exactly where a building gets dropped.
      button.title = 'Empty — drag a building here from your inventory';
      return;
    }

    setText(name, entry.name);
    setText(count, String(stockOf(entry)));
    button.classList.remove('is-empty');
    button.draggable = true;
    button.classList.toggle('is-selected', entry.selected);
    button.classList.toggle('is-unaffordable', !entry.affordable);
    button.classList.toggle('is-locked', !entry.unlocked);
    // C22's lock, said where the building is: the build menu that used to say
    // it is gone.
    const lock = entry.unlocked ? '' : ` — locked, research ${entry.unlockedBy ?? 'required'}`;
    button.title = `${entry.name} — ${describeCost(entry)}${lock}. Drag to move, right-click to remove.`;
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

/** The 1-based slot an event happened on, read off the element it was bound to. */
function slotOf(event: Event): number | null {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return null;
  const slot = Number(target.dataset['slot']);
  return Number.isInteger(slot) ? slot : null;
}

/** Is this drag carrying a building, from the bag or another slot? The type list is readable during a drag; the data is not. */
function carriesBuilding(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (types === undefined) return false;
  const list = Array.from(types);
  return list.includes(BUILDING_DRAG_TYPE) || list.includes(SLOT_DRAG_TYPE);
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
