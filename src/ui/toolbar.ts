/**
 * The hotbar. See ironflow.md C07 task 3 and §13.
 *
 * Nine slots along the bottom, bound to the number row, and nothing else: the
 * BAG, TECH, MAP, SAVE and settings buttons that sat beside them came off on
 * 2026-09-23. The bag and the tech tree open from their HUD tiles (and I, T),
 * the map from M, and saving from the MENU button or Escape.
 *
 * What each slot holds is the player's: any item — a building or a material — is dragged onto a slot from the
 * inventory, dragged from one slot to another to swap the two, and taken off
 * with a right-click. A slot is **one stack**, so the same item may fill
 * several. The toolbar only reports those gestures — the controller keeps
 * the arrangement, and slot *n* means the same thing to a click here and to
 * the number key, because both go through `GameController.selectSlot`.
 *
 * The nine slots are built once in `mount()` and never recreated. Updating is
 * assignment and class toggles only (§13).
 */

import type { BuildMenuEntry, BuildMenuView, HotbarSlotView } from '../game/views/build-menu-view.js';
import { HOTBAR_SLOTS } from '../game/game-controller.js';

/**
 * The drag payload for an item on its way to the hotbar: its id. A type of
 * its own, so the slots ignore a drag of anything else — a file, a link, text.
 */
export const ITEM_DRAG_TYPE = 'application/x-ironflow-item';

/** The drag payload for a slot's item on its way to another slot: the source slot, 1-based. */
export const SLOT_DRAG_TYPE = 'application/x-ironflow-slot';

interface Slot {
  readonly button: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
}

export interface ToolbarOptions {
  /** Slot number, 1-based. The controller decides what that means. */
  readonly onSelectSlot: (slot: number) => void;
  /** An item was dropped on slot `slot` (1-based). */
  readonly onAssignSlot: (slot: number, itemId: string) => void;
  /** Slot `slot` (1-based) was right-clicked: empty it. */
  readonly onClearSlot: (slot: number) => void;
  /** Slot `from`'s item was dropped on slot `to` (both 1-based): swap them. */
  readonly onMoveSlot: (from: number, to: number) => void;
}

/** Rotation as the player reads it, in tile space (§5 — no isometric words). */
const ROTATION_LABELS = ['N', 'E', 'S', 'W'] as const;

export class Toolbar {
  private readonly root = document.createElement('div');
  private readonly slots: Slot[] = [];
  private readonly rotationLabel = document.createElement('span');
  private readonly options: ToolbarOptions;

  constructor(options: ToolbarOptions) {
    this.options = options;
  }

  mount(parent: HTMLElement): void {
    this.root.className = 'if-toolbar';

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

    // Rotation is a building's; a material in hand has none.
    const held = view.selectedBuildingId !== null;
    const label = held ? (ROTATION_LABELS[view.rotation] ?? '') : '';
    if (this.rotationLabel.textContent !== label) this.rotationLabel.textContent = label;
    this.rotationLabel.classList.toggle('is-active', held);
  }

  destroy(): void {
    for (const slot of this.slots) {
      slot.button.removeEventListener('keydown', this.handleSlotKey);
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

  /**
   * One listener for all nine slots, reading the slot number off the element.
   *
   * The alternative — a closure per slot — allocates nine functions that can
   * never be removed by the same reference they were added with, which is how
   * a `destroy()` quietly stops working.
   *
   * The slot gives focus back after it is pressed (C30). What a player does
   * next with a building in hand is put it down, and a slot still holding
   * focus would take their Enter for itself instead of the world.
   */
  private readonly handleSlot = (event: Event): void => {
    const slot = slotOf(event);
    if (slot !== null) this.options.onSelectSlot(slot);
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.blur();
  };

  /**
   * The keyboard's two slot gestures (C30): Delete or Backspace empties a
   * slot, the right-click's other half; shift+left or right swaps it with its
   * neighbour, the drag's.
   */
  private readonly handleSlotKey = (event: KeyboardEvent): void => {
    const slot = slotOf(event);
    if (slot === null) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      this.options.onClearSlot(slot);
      return;
    }
    if (!event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
    event.preventDefault();
    event.stopPropagation();
    const to = slot + (event.key === 'ArrowLeft' ? -1 : 1);
    if (to < 1 || to > HOTBAR_SLOTS) return;
    this.options.onMoveSlot(slot, to);
    this.slots[to - 1]?.button.focus();
  };

  /** Right-click takes an item off the bar. The browser's menu never opens over a slot. */
  private readonly handleClear = (event: Event): void => {
    event.preventDefault();
    const slot = slotOf(event);
    if (slot !== null) this.options.onClearSlot(slot);
  };

  /** Accept an item being dragged over, and nothing else. */
  private readonly handleDragOver = (event: DragEvent): void => {
    if (!carriesItem(event)) return;
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

    // From another slot: a swap, which keeps both items on the bar.
    const from = Number(event.dataTransfer?.getData(SLOT_DRAG_TYPE) ?? '');
    if (Number.isInteger(from) && from > 0) {
      event.preventDefault();
      this.options.onMoveSlot(from, slot);
      return;
    }

    const itemId = event.dataTransfer?.getData(ITEM_DRAG_TYPE) ?? '';
    if (itemId === '') return;
    event.preventDefault();
    this.options.onAssignSlot(slot, itemId);
  };

  /** Pick a slot's item up to move it. An empty slot has nothing to drag. */
  private readonly handleDragStart = (event: DragEvent): void => {
    const slot = slotOf(event);
    const target = event.currentTarget;
    if (slot === null || event.dataTransfer === null || !(target instanceof HTMLElement) || !target.draggable) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(SLOT_DRAG_TYPE, String(slot));
    // The item too, so a slot dropped on a machine's input slot feeds it.
    const itemId = target.dataset['item'];
    if (itemId !== undefined) event.dataTransfer.setData(ITEM_DRAG_TYPE, itemId);
    event.dataTransfer.effectAllowed = 'copyMove';
  };

  private createSlot(slot: number): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'if-slot';
    button.dataset['slot'] = String(slot);
    button.addEventListener('click', this.handleSlot);
    button.addEventListener('keydown', this.handleSlotKey);
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

  private paintSlot(slot: Slot, view: HotbarSlotView | undefined): void {
    const { button, name, count } = slot;

    if (view === undefined) {
      setText(name, '');
      setText(count, '');
      button.classList.add('is-empty');
      button.classList.remove('is-selected', 'is-unaffordable', 'is-locked', 'is-spent');
      button.draggable = false;
      delete button.dataset['item'];
      // Not disabled: a disabled button receives no drag events, and an empty
      // slot is exactly where an item gets dropped.
      button.title = 'Empty — drag an item here from your inventory, or focus one there and press this number';
      return;
    }

    setText(name, view.name);
    if (button.dataset['item'] !== view.itemId) button.dataset['item'] = view.itemId;
    // One stack: what this slot stands for, not the whole bag.
    setText(count, String(view.count));
    button.classList.remove('is-empty');
    button.draggable = true;
    button.classList.toggle('is-selected', view.selected);

    const entry = view.building;
    const edit = 'Drag to move, right-click to remove (shift+arrows and Delete from the keyboard).';
    if (entry === null) {
      button.classList.remove('is-unaffordable', 'is-locked');
      button.classList.toggle('is-spent', view.count === 0);
      button.title = `${view.name} — ${view.count} / ${view.stackSize}. Click to hold, then click a machine to feed it. ${edit}`;
      return;
    }

    button.classList.remove('is-spent');
    button.classList.toggle('is-unaffordable', !entry.affordable);
    button.classList.toggle('is-locked', !entry.unlocked);
    // C22's lock, said where the building is: the build menu that used to say
    // it is gone.
    const lock = entry.unlocked ? '' : ` — locked, research ${entry.unlockedBy ?? 'required'}`;
    button.title = `${entry.name} — ${describeCost(entry)}${lock}. ${edit}`;
  }
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

/** Is this drag carrying an item, from the bag or another slot? The type list is readable during a drag; the data is not. */
function carriesItem(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;
  if (types === undefined) return false;
  const list = Array.from(types);
  return list.includes(ITEM_DRAG_TYPE) || list.includes(SLOT_DRAG_TYPE);
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}
