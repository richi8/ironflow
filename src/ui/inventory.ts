/**
 * The bag, and the bench. See ironflow.md C21A and §13.
 *
 * §13 has listed an `InventoryPanel` since revision 1 and no chunk scheduled
 * one, so for twelve chunks the answer to "what did I just mine?" was a single
 * total in the corner of the HUD. This is that panel, and it does two jobs
 * that belong together because they are the same bag read twice:
 *
 * ```text
 *   CARRYING       the bag: a fixed grid of slots, one stack in each
 *   CRAFT BY HAND  what those items can be turned into, and how many
 *   MAKING         the queue, head first, with the one bar that is moving
 * ```
 *
 * ## It builds its DOM once, from content
 *
 * The bag is a fixed pool of one cell per slot, and the craft grid one button
 * per hand-craftable recipe; both are sized by the first view handed to
 * `mount()`. Nothing is created or destroyed while the game runs: an empty
 * slot is a cell painted empty, and a stack moving is two cells repainted
 * (§13).
 *
 * ## The bag is arranged by dragging (2026-09-23)
 *
 * Each stack has a position, as in the genre's own inventories. Dragging one
 * cell onto another sends `moveStack`: onto an empty slot it moves, onto the
 * same item it merges, onto anything else it swaps. The same drag carries the
 * item's id too, so a cell dropped on the hotbar goes on the hotbar and one
 * dropped on a machine's input slot goes into the machine.
 *
 * The queue is the one varying-length list, and it is a fixed pool too —
 * `QUEUE_ROWS` of them, which is more orders than the simulation will hold.
 *
 * ## It is where building, and feeding, starts
 *
 * Every carried item is a cell that can be picked up: a click puts it in the
 * player's hand and closes the panel, so the next click lands on the world,
 * and a drag carries it onto a hotbar slot. A building in hand is placed; a
 * material in hand — ore, coal, plates — is fed to the machine it is clicked
 * on. That is the whole of what the build menu used to do, and more, from the
 * place the player already looks to see what they have.
 *
 * ## It cannot change anything
 *
 * Every control calls back into `GameUI`, which dispatches a command (§7).
 * The panel holds no inventory and no controller; it is handed a frozen
 * snapshot and hands back an intention. The counts it greys a button out on
 * are a *pre-check* — the simulation refuses the craft again, on its own
 * terms, one tick later.
 */

import type {
  CraftOptionView,
  CraftQueueView,
  InventoryCellView,
  InventoryView,
} from '../game/views/inventory-view.js';

import { createIcon } from './icons.js';
import { createItemIcon, paintItemIcon, type ItemIcon, type ItemIconSource } from './item-icon.js';
import { digitOf, gridKeys } from './keyboard.js';
import { ITEM_DRAG_TYPE } from './toolbar.js';
import type { Tooltip } from './tooltip.js';
import { BATCH_CRAFT, TICKS_PER_SECOND, craftContent, stackContent } from './tooltip-content.js';

export { BATCH_CRAFT };

/**
 * The drag payload for a stack on its way to another slot: which grid and
 * which slot it came from, as `bag:3` or `<chest id>:3`. Read by the bag and
 * by a chest's grid in the inspector, so a stack crosses between them.
 */
export const CELL_DRAG_TYPE = 'application/x-ironflow-cell';

/** Where a dragged stack came from: a grid (`null` for the bag) and a slot. */
export interface CellRef {
  readonly entityId: number | null;
  readonly slot: number;
}

export function encodeCell(ref: CellRef): string {
  return `${ref.entityId ?? 'bag'}:${ref.slot}`;
}

/** The inverse of `encodeCell`, or null for anything it did not write. */
export function decodeCell(raw: string): CellRef | null {
  const match = /^(bag|\d+):(\d+)$/.exec(raw);
  if (match === null) return null;
  const slot = Number(match[2]);
  const entityId = match[1] === 'bag' ? null : Number(match[1]);
  return Number.isSafeInteger(slot) && (entityId === null || Number.isSafeInteger(entityId)) ? { entityId, slot } : null;
}

/**
 * Queue rows drawn. More than `MAX_CRAFT_ORDERS`, which is the simulation's
 * cap — a test asserts the inequality, so shrinking one without the other is
 * a failure rather than an order the player cannot see.
 */
export const QUEUE_ROWS = 16;

/**
 * Cells per row in the bag and in a chest, as `.if-bag` lays them out. The
 * keyboard needs it to know what "down" is (C30); the stylesheet's
 * `repeat(5, 1fr)` is the other copy, and a test holds them together. Five
 * since C30 raised the text to 14px, when six no longer fitted a word.
 */
export const BAG_COLUMNS = 5;

/**
 * One bag slot. Since C32 the item is a picture and the name is for screen
 * readers only (`if-sr-only`); the tooltip carries it for everyone else.
 */
interface Cell {
  readonly root: HTMLElement;
  readonly icon: ItemIcon;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
  /** What the cell was last painted with, for its tooltip. */
  view: InventoryCellView | null;
}

/** A hand-craft: the product's picture, and its bill in the tooltip (C32). */
interface CraftButton {
  readonly root: HTMLButtonElement;
  readonly icon: ItemIcon;
  readonly yield: HTMLElement;
  readonly name: HTMLElement;
  readonly time: HTMLElement;
  readonly parts: HTMLElement;
  option: CraftOptionView | null;
}

interface QueueRow {
  readonly root: HTMLElement;
  readonly icon: ItemIcon;
  readonly name: HTMLElement;
  readonly remaining: HTMLElement;
  readonly bar: HTMLElement;
  readonly cancel: HTMLButtonElement;
}

export interface InventoryPanelOptions {
  /** Queue `count` hand-crafts of `recipeId`. */
  readonly onCraft: (recipeId: string, count: number) => void;
  /** Drop the order at `index`, refunding it. */
  readonly onCancel: (index: number) => void;
  /** A carried item was clicked: hold it, ready to place or to feed a machine. */
  readonly onPickItem: (itemId: string) => void;
  /** The stack at `from` (the bag or a chest) was dropped on bag slot `to`. */
  readonly onMoveStack: (from: CellRef, to: number) => void;
  /** Shift-click on a bag stack: send it across to an open chest, if there is one. */
  readonly onQuickMove: (slot: number) => void;
  /**
   * A number key pressed on a focused cell: put its item on that hotbar slot
   * (C30). The keyboard's drag onto the hotbar. Optional for the tests that
   * predate it.
   */
  readonly onAssignHotbar?: (slot: number, itemId: string) => void;
  readonly onClose: () => void;
  /** The shared tooltip (C32). Without one, cells have none. */
  readonly tooltip?: Tooltip;
  /** Item pictures (C32). Without them, an icon is two letters. */
  readonly icons?: ItemIconSource;
}

export class InventoryPanel {
  private readonly root = document.createElement('section');
  private readonly slotsLabel = document.createElement('span');
  private readonly closeButton = document.createElement('button');
  private readonly bag = document.createElement('div');
  private readonly bagEmpty = document.createElement('div');
  private readonly craftGrid = document.createElement('div');
  private readonly queueList = document.createElement('div');
  private readonly queueEmpty = document.createElement('div');
  private readonly options: InventoryPanelOptions;

  private readonly cells: Cell[] = [];
  private readonly craftButtons = new Map<string, CraftButton>();
  private readonly queueRows: QueueRow[] = [];
  private releaseGridKeys: (() => void) | null = null;

  private open = false;

  constructor(options: InventoryPanelOptions) {
    this.options = options;
  }

  /** @param view the first snapshot, whose item and recipe lists are the shape. */
  mount(parent: HTMLElement, view: InventoryView): void {
    this.root.className = 'if-inventory';
    this.root.hidden = true;

    const head = document.createElement('div');
    head.className = 'if-inventory__head';
    const title = document.createElement('h2');
    title.className = 'if-inventory__title';
    title.textContent = 'INVENTORY';
    this.slotsLabel.className = 'if-inventory__slots';
    this.closeButton.type = 'button';
    this.closeButton.className = 'if-inspector__close';
    this.closeButton.title = 'Close (I)';
    this.closeButton.setAttribute('aria-label', 'Close the inventory');
    this.closeButton.textContent = '×';
    this.closeButton.addEventListener('click', this.handleClose);
    head.append(createIcon('inventory'), title, this.slotsLabel, this.closeButton);

    const body = document.createElement('div');
    body.className = 'if-inventory__body';
    body.append(this.createBagColumn(view), this.createCraftColumn(view));

    this.root.append(head, body);
    parent.append(this.root);
    this.update(view);
  }

  isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.hidden = !open;
  }

  toggle(): boolean {
    this.setOpen(!this.open);
    return this.open;
  }

  /** Repaint from a snapshot. Assignment and class toggles only (§13). */
  update(view: InventoryView): void {
    // The bag is full at the moment the last slot goes, which is also the
    // moment mining starts being refused — so the panel says it in the same
    // place the number is, rather than leaving the toast to explain it alone.
    // In words as well as in amber (C30: never colour alone).
    const full = view.usedSlots >= view.slots;
    setText(this.slotsLabel, `${view.usedSlots} / ${view.slots} SLOTS${full ? ' — FULL' : ''}`);
    this.slotsLabel.classList.toggle('is-warning', full);

    let carried = 0;
    view.cells.forEach((cellView, index) => {
      const cell = this.cells[index];
      if (cell === undefined) return;
      if (cellView.itemId !== null) carried += 1;
      this.paintCell(cell, cellView);
    });
    this.bagEmpty.hidden = carried > 0;

    for (const option of view.crafts) {
      const button = this.craftButtons.get(option.id);
      if (button === undefined) continue;
      this.paintCraft(button, option);
    }

    this.paintQueue(view.queue);
  }

  destroy(): void {
    this.closeButton.removeEventListener('click', this.handleClose);
    this.releaseGridKeys?.();
    this.bag.removeEventListener('keydown', this.handleCellKey);
    for (const button of this.craftButtons.values()) {
      button.root.removeEventListener('click', this.handleCraft);
      this.options.tooltip?.detach(button.root);
    }
    for (const cell of this.cells) {
      this.options.tooltip?.detach(cell.root);
      cell.root.removeEventListener('click', this.handlePick);
      cell.root.removeEventListener('dragstart', this.handleDragStart);
      cell.root.removeEventListener('dragover', this.handleDragOver);
      cell.root.removeEventListener('dragleave', this.handleDragLeave);
      cell.root.removeEventListener('drop', this.handleDrop);
    }
    for (const row of this.queueRows) row.cancel.removeEventListener('click', this.handleCancel);
    this.craftButtons.clear();
    this.cells.length = 0;
    this.queueRows.length = 0;
    this.root.remove();
  }

  private readonly handleClose = (): void => {
    this.options.onClose();
  };

  /**
   * One listener for every craft button, reading the recipe off the element.
   *
   * Shift queues a handful. It is a modifier rather than a second button
   * because the grid is already dense, and because "click for one, shift for
   * five" is the gesture this genre has trained into the player's hand.
   */
  private readonly handleCraft = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const recipeId = target.dataset['recipe'];
    if (recipeId === undefined || target.getAttribute('aria-disabled') === 'true') return;
    const batch = event instanceof MouseEvent && event.shiftKey ? BATCH_CRAFT : 1;
    this.options.onCraft(recipeId, batch);
  };

  /** A click on a carried item picks it up; with shift it goes to an open chest. */
  private readonly handlePick = (event: Event): void => {
    const itemId = itemOf(event);
    const index = indexOf(event);
    if (itemId === null) return;
    if (event instanceof MouseEvent && event.shiftKey && index !== null) {
      this.options.onQuickMove(index);
      return;
    }
    this.options.onPickItem(itemId);
  };

  /**
   * A drag of a stack: to another slot, to the hotbar, or into a machine. It
   * carries both the slot and the item, and whoever it is dropped on reads
   * the one it understands.
   */
  private readonly handleDragStart = (event: DragEvent): void => {
    const itemId = itemOf(event);
    const index = indexOf(event);
    if (itemId === null || index === null || event.dataTransfer === null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(ITEM_DRAG_TYPE, itemId);
    event.dataTransfer.setData(CELL_DRAG_TYPE, encodeCell({ entityId: null, slot: index }));
    event.dataTransfer.effectAllowed = 'copyMove';
  };

  /** Accept another bag stack being dragged over, and nothing else. */
  private readonly handleDragOver = (event: DragEvent): void => {
    const types = event.dataTransfer?.types;
    if (types === undefined || !Array.from(types).includes(CELL_DRAG_TYPE)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.add('is-drop-target');
  };

  private readonly handleDragLeave = (event: DragEvent): void => {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove('is-drop-target');
  };

  private readonly handleDrop = (event: DragEvent): void => {
    if (event.currentTarget instanceof HTMLElement) event.currentTarget.classList.remove('is-drop-target');
    const to = indexOf(event);
    const from = decodeCell(event.dataTransfer?.getData(CELL_DRAG_TYPE) ?? '');
    if (to === null || from === null) return;
    event.preventDefault();
    if (from.entityId !== null || from.slot !== to) this.options.onMoveStack(from, to);
  };

  /**
   * 1-9 on a focused cell puts its item on that hotbar slot, and stops there
   * — without the stop, the same key would also pick up whatever the slot
   * held before, since the number row selects hotbar slots everywhere else.
   */
  private readonly handleCellKey = (event: KeyboardEvent): void => {
    const digit = digitOf(event);
    const target = event.target;
    if (digit === null || !(target instanceof HTMLElement) || target.parentElement !== this.bag) return;
    event.preventDefault();
    event.stopPropagation();
    const itemId = target.dataset['item'];
    if (itemId !== undefined) this.options.onAssignHotbar?.(digit, itemId);
  };

  private readonly handleCancel = (event: Event): void => {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) return;
    const index = Number(target.dataset['index']);
    if (Number.isInteger(index)) this.options.onCancel(index);
  };

  private createBagColumn(view: InventoryView): HTMLElement {
    const column = document.createElement('div');
    column.className = 'if-inventory__column';
    column.append(label('CARRYING'));

    this.bag.className = 'if-bag';
    for (const cell of view.cells) this.bag.append(this.createCell(cell.index));
    // C30: arrows walk the bag, shift+arrow carries a stack a cell over, and
    // a number puts the focused item on that hotbar slot.
    this.releaseGridKeys = gridKeys(this.bag, {
      columns: BAG_COLUMNS,
      onMove: (from, to) => this.options.onMoveStack({ entityId: null, slot: from }, to),
    });
    this.bag.addEventListener('keydown', this.handleCellKey);

    this.bagEmpty.className = 'if-inventory__empty';
    this.bagEmpty.textContent = 'Nothing yet. Hold right-click on ore to mine it, or face it and hold Enter.';

    column.append(this.bag, this.bagEmpty);
    return column;
  }

  private createCraftColumn(view: InventoryView): HTMLElement {
    const column = document.createElement('div');
    column.className = 'if-inventory__column';
    column.append(label('CRAFT BY HAND'));

    this.craftGrid.className = 'if-crafts';
    for (const option of view.crafts) this.craftGrid.append(this.createCraft(option));
    column.append(this.craftGrid);

    column.append(label('MAKING'));
    this.queueList.className = 'if-queue';
    for (let i = 0; i < QUEUE_ROWS; i++) this.queueList.append(this.createQueueRow(i));
    this.queueEmpty.className = 'if-inventory__empty';
    this.queueEmpty.textContent = 'Nothing. Pick something above.';
    column.append(this.queueList, this.queueEmpty);
    return column;
  }

  /** One slot of the bag. What is in it is painted, never built (§13). */
  private createCell(index: number): HTMLElement {
    const root = document.createElement('div');
    root.className = 'if-bag-cell is-empty';
    root.dataset['index'] = String(index);
    root.tabIndex = 0;
    root.setAttribute('role', 'button');
    root.addEventListener('click', this.handlePick);
    root.addEventListener('dragstart', this.handleDragStart);
    root.addEventListener('dragover', this.handleDragOver);
    root.addEventListener('dragleave', this.handleDragLeave);
    root.addEventListener('drop', this.handleDrop);

    const icon = createItemIcon('if-bag-cell__icon');

    const name = document.createElement('span');
    name.className = 'if-bag-cell__name if-sr-only';

    const count = document.createElement('span');
    count.className = 'if-bag-cell__count';

    root.append(icon.root, name, count);
    const cell: Cell = { root, icon, name, count, view: null };
    this.cells.push(cell);
    this.options.tooltip?.attach(root, () => {
      const view = cell.view;
      if (view === null || view.itemId === null) return null;
      const use = view.buildingId === null ? 'Click to hold it and feed a machine.' : 'Click to build it.';
      return stackContent(view.itemId, view.name, view.count, view.stackSize, `${use} Drag to move it, onto the hotbar, or into a machine.`);
    });
    return root;
  }

  private createCraft(option: CraftOptionView): HTMLButtonElement {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'if-craft';
    root.dataset['recipe'] = option.id;
    root.addEventListener('click', this.handleCraft);

    const icon = createItemIcon('if-craft__icon');

    // How many the bag could make, on the picture's corner (2026-09-24).
    const made = document.createElement('span');
    made.className = 'if-craft__yield';

    // The words stay, for screen readers; the tooltip says them to everyone.
    const name = document.createElement('span');
    name.className = 'if-craft__name if-sr-only';

    const time = document.createElement('span');
    time.className = 'if-craft__time if-sr-only';

    const parts = document.createElement('span');
    parts.className = 'if-craft__parts if-sr-only';

    root.append(icon.root, made, name, time, parts);
    const button: CraftButton = { root, icon, yield: made, name, time, parts, option: null };
    this.craftButtons.set(option.id, button);
    this.options.tooltip?.attach(root, () => (button.option === null ? null : craftContent(button.option)));
    return root;
  }

  private createQueueRow(index: number): HTMLElement {
    const root = document.createElement('div');
    root.className = 'if-queue-row';
    root.hidden = true;

    const icon = createItemIcon('if-queue-row__icon');

    const name = document.createElement('span');
    name.className = 'if-queue-row__name';

    const remaining = document.createElement('span');
    remaining.className = 'if-queue-row__remaining';

    const track = document.createElement('span');
    track.className = 'if-queue-row__track';
    const bar = document.createElement('span');
    bar.className = 'if-queue-row__bar';
    track.append(bar);

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'if-queue-row__cancel';
    cancel.dataset['index'] = String(index);
    cancel.title = 'Cancel — the ingredients come back';
    cancel.setAttribute('aria-label', 'Cancel this craft');
    cancel.textContent = '×';
    cancel.addEventListener('click', this.handleCancel);

    root.append(icon.root, name, remaining, track, cancel);
    this.queueRows.push({ root, icon, name, remaining, bar, cancel });
    return root;
  }

  private paintCell(cell: Cell, view: InventoryCellView): void {
    const { root } = cell;
    cell.view = view;
    paintItemIcon(cell.icon, view.itemId, view.name, this.options.icons ?? null);
    if (view.itemId === null) {
      setText(cell.name, '');
      setText(cell.count, '');
      delete root.dataset['item'];
      root.draggable = false;
      root.classList.add('is-empty');
      root.classList.remove('is-placeable');
      root.setAttribute('aria-label', 'Empty slot');
      return;
    }
    setText(cell.name, view.name);
    setText(cell.count, String(view.count));
    if (root.dataset['item'] !== view.itemId) root.dataset['item'] = view.itemId;
    root.draggable = true;
    root.classList.remove('is-empty');
    root.classList.toggle('is-placeable', view.buildingId !== null);
    setLabel(root, `${view.name}, ${view.count}`);
  }

  private paintCraft(button: CraftButton, option: CraftOptionView): void {
    button.option = option;
    // A locked recipe keeps its button, hidden, so research can reveal it (C31).
    if (button.root.hidden === option.unlocked) button.root.hidden = !option.unlocked;
    paintItemIcon(button.icon, option.productId, option.name, this.options.icons ?? null);
    setText(button.yield, option.makeable === 0 ? '' : String(option.makeable));
    setText(button.name, option.yield === 1 ? option.name : `${option.yield} ${option.name}`);
    setText(button.time, `${(option.craftTicks / TICKS_PER_SECOND).toFixed(1)}s`);
    setText(button.parts, option.inputs.map((part) => `${part.held}/${part.count} ${part.name}`).join('  '));

    const affordable = option.craftable > 0;
    // `aria-disabled` rather than `disabled` (C32): a disabled button gets no
    // pointer events, and an unaffordable craft is exactly the one whose
    // tooltip says what is missing.
    const dead = affordable ? 'false' : 'true';
    if (button.root.getAttribute('aria-disabled') !== dead) button.root.setAttribute('aria-disabled', dead);
    button.root.classList.toggle('is-unaffordable', !affordable);
  }

  private paintQueue(queue: readonly CraftQueueView[]): void {
    this.queueEmpty.hidden = queue.length > 0;

    for (let i = 0; i < this.queueRows.length; i++) {
      const row = this.queueRows[i];
      if (row === undefined) continue;

      const order = queue[i];
      row.root.hidden = order === undefined;
      if (order === undefined) continue;

      paintItemIcon(row.icon, order.productId, order.name, this.options.icons ?? null);
      setText(row.name, order.name);
      // A blocked order says so in words, not only in amber (C30).
      setText(row.remaining, order.blocked ? `×${order.remaining} BAG FULL` : `×${order.remaining}`);
      // Only the head is being worked on, so only the head has a bar. A queued
      // order showing 0% would claim it had started.
      row.bar.style.width = order.progress === null ? '0%' : `${clampPercent(order.progress)}%`;
      // `dataset` rather than a class, for the reason the inspector's status
      // tone is one: there is no stale state to remember to clear.
      row.root.dataset['state'] = order.blocked ? 'blocked' : order.progress === null ? 'waiting' : 'active';
      row.root.title = order.blocked
        ? `${order.name} is finished and your bag is full — make room for it.`
        : order.forChain
          ? `${order.name} ×${order.remaining}, for a craft after it. Cancelling it cancels the whole chain.`
          : `${order.name} ×${order.remaining}`;
    }
  }
}

function label(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'if-inspector__label';
  element.textContent = text;
  return element;
}

/** The slot a cell is, read off the element the listener is bound to. */
function indexOf(event: Event): number | null {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return null;
  const index = Number(target.dataset['index']);
  return Number.isInteger(index) ? index : null;
}

/** The item a cell holds, read off the element the listener is bound to. */
function itemOf(event: Event): string | null {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return null;
  return target.dataset['item'] ?? null;
}

/** An accessible name, written only when it changed. */
function setLabel(element: HTMLElement, label: string): void {
  if (element.getAttribute('aria-label') !== label) element.setAttribute('aria-label', label);
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** `progress` is 0..1, but an order parked at its finish line is exactly 1. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : progress * 100;
}
