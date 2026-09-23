/**
 * The bag, and the bench. See ironflow.md C21A and §13.
 *
 * §13 has listed an `InventoryPanel` since revision 1 and no chunk scheduled
 * one, so for twelve chunks the answer to "what did I just mine?" was a single
 * total in the corner of the HUD. This is that panel, and it does two jobs
 * that belong together because they are the same bag read twice:
 *
 * ```text
 *   CARRYING       every kind of item, its count, and the slots it costs
 *   CRAFT BY HAND  what those items can be turned into, and how many
 *   MAKING         the queue, head first, with the one bar that is moving
 * ```
 *
 * ## It builds its DOM once, from content
 *
 * Both grids are fixed pools sized by the *content table* rather than by the
 * contents — a cell per registered item, a button per hand-craftable recipe —
 * and both are handed to `mount()` in the first view. Nothing is created or destroyed while the game runs: a cell
 * whose count is zero is hidden, and the ore that arrives a second later
 * un-hides it (§13).
 *
 * The queue is the one varying-length list, and it is a fixed pool too —
 * `QUEUE_ROWS` of them, which is more orders than the simulation will hold.
 *
 * ## It is where building starts
 *
 * A carried building — a miner, a belt, a chest — is a cell that can be
 * picked up: a click puts it in the player's hand and closes the panel, so
 * the next click lands on the world, and a drag carries it onto a hotbar slot.
 * That is the whole of what the build menu used to do, from the place the
 * player already looks to see what they have.
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
  InventorySlotView,
  InventoryView,
} from '../game/views/inventory-view.js';

import { createIcon } from './icons.js';
import { BUILDING_DRAG_TYPE } from './toolbar.js';

/**
 * Queue rows drawn. More than `MAX_CRAFT_ORDERS`, which is the simulation's
 * cap — a test asserts the inequality, so shrinking one without the other is
 * a failure rather than an order the player cannot see.
 */
export const QUEUE_ROWS = 16;

/** How many a shift-click queues. The genre's "a handful", written down once. */
export const BATCH_CRAFT = 5;

interface Cell {
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly count: HTMLElement;
  readonly slots: HTMLElement;
}

interface CraftButton {
  readonly root: HTMLButtonElement;
  readonly name: HTMLElement;
  readonly time: HTMLElement;
  readonly parts: HTMLElement;
}

interface QueueRow {
  readonly root: HTMLElement;
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
  /** A carried building was clicked: hold it, ready to place. */
  readonly onPickBuilding: (buildingId: string) => void;
  readonly onClose: () => void;
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

  private readonly cells = new Map<string, Cell>();
  private readonly craftButtons = new Map<string, CraftButton>();
  private readonly queueRows: QueueRow[] = [];

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
    setText(this.slotsLabel, `${view.usedSlots} / ${view.slots} SLOTS`);
    // The bag is full at the moment the last slot goes, which is also the
    // moment mining starts being refused — so the panel says it in the same
    // place the number is, rather than leaving the toast to explain it alone.
    this.slotsLabel.classList.toggle('is-warning', view.usedSlots >= view.slots);

    let carried = 0;
    for (const item of view.items) {
      const cell = this.cells.get(item.itemId);
      if (cell === undefined) continue;
      cell.root.hidden = item.count === 0;
      if (item.count === 0) continue;
      carried += 1;
      this.paintCell(cell, item);
    }
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
    for (const button of this.craftButtons.values()) button.root.removeEventListener('click', this.handleCraft);
    for (const cell of this.cells.values()) {
      cell.root.removeEventListener('click', this.handlePick);
      cell.root.removeEventListener('dragstart', this.handleDragStart);
    }
    for (const row of this.queueRows) row.cancel.removeEventListener('click', this.handleCancel);
    this.craftButtons.clear();
    this.cells.clear();
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
    if (recipeId === undefined) return;
    const batch = event instanceof MouseEvent && event.shiftKey ? BATCH_CRAFT : 1;
    this.options.onCraft(recipeId, batch);
  };

  /** A click on a carried building picks it up. Other cells ignore it. */
  private readonly handlePick = (event: Event): void => {
    const buildingId = buildingOf(event);
    if (buildingId !== null) this.options.onPickBuilding(buildingId);
  };

  /** A drag of a carried building, on its way to a hotbar slot. */
  private readonly handleDragStart = (event: DragEvent): void => {
    const buildingId = buildingOf(event);
    if (buildingId === null || event.dataTransfer === null) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.setData(BUILDING_DRAG_TYPE, buildingId);
    event.dataTransfer.effectAllowed = 'copy';
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
    for (const item of view.items) this.bag.append(this.createCell(item));

    this.bagEmpty.className = 'if-inventory__empty';
    this.bagEmpty.textContent = 'Nothing yet. Hold left-click on ore to mine it.';

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

  private createCell(item: InventorySlotView): HTMLElement {
    const root = document.createElement('div');
    root.className = 'if-bag-cell';
    root.hidden = true;

    const name = document.createElement('span');
    name.className = 'if-bag-cell__name';
    name.textContent = item.name;

    const count = document.createElement('span');
    count.className = 'if-bag-cell__count';

    const slots = document.createElement('span');
    slots.className = 'if-bag-cell__slots';

    // Whether an item places a building is content and never changes, so it
    // is decided once, here, rather than repainted.
    if (item.buildingId !== null) {
      root.classList.add('is-placeable');
      root.dataset['building'] = item.buildingId;
      root.draggable = true;
      root.tabIndex = 0;
      root.setAttribute('role', 'button');
      root.addEventListener('click', this.handlePick);
      root.addEventListener('dragstart', this.handleDragStart);
    }

    root.append(name, count, slots);
    this.cells.set(item.itemId, { root, name, count, slots });
    return root;
  }

  private createCraft(option: CraftOptionView): HTMLButtonElement {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'if-craft';
    root.dataset['recipe'] = option.id;
    root.addEventListener('click', this.handleCraft);

    const name = document.createElement('span');
    name.className = 'if-craft__name';

    const time = document.createElement('span');
    time.className = 'if-craft__time';

    const parts = document.createElement('span');
    parts.className = 'if-craft__parts';

    root.append(name, time, parts);
    this.craftButtons.set(option.id, { root, name, time, parts });
    return root;
  }

  private createQueueRow(index: number): HTMLElement {
    const root = document.createElement('div');
    root.className = 'if-queue-row';
    root.hidden = true;

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

    root.append(name, remaining, track, cancel);
    this.queueRows.push({ root, name, remaining, bar, cancel });
    return root;
  }

  private paintCell(cell: Cell, item: InventorySlotView): void {
    setText(cell.count, String(item.count));
    // The slot cost, which is what the "27 / 30" at the top is made of — and
    // the answer to a bag that is full while reading as half empty.
    setText(cell.slots, item.slots === 1 ? '1 slot' : `${item.slots} slots`);
    const use = item.buildingId === null ? '' : ' — click to build, or drag onto the hotbar';
    cell.root.title = `${item.name} — ${item.count}, ${item.stackSize} per slot${use}`;
  }

  private paintCraft(button: CraftButton, option: CraftOptionView): void {
    setText(button.name, option.yield === 1 ? option.name : `${option.yield} ${option.name}`);
    setText(button.time, `${(option.craftTicks / TICKS_PER_SECOND).toFixed(1)}s`);
    setText(button.parts, option.inputs.map((part) => `${part.held}/${part.count} ${part.name}`).join('  '));

    const affordable = option.craftable > 0;
    button.root.disabled = !affordable;
    button.root.classList.toggle('is-unaffordable', !affordable);
    button.root.title = affordable
      ? `${option.name} — click for one, shift-click for ${BATCH_CRAFT}. You could make ${option.craftable}.`
      : `${option.name} — you are missing ingredients.`;
  }

  private paintQueue(queue: readonly CraftQueueView[]): void {
    this.queueEmpty.hidden = queue.length > 0;

    for (let i = 0; i < this.queueRows.length; i++) {
      const row = this.queueRows[i];
      if (row === undefined) continue;

      const order = queue[i];
      row.root.hidden = order === undefined;
      if (order === undefined) continue;

      setText(row.name, order.name);
      setText(row.remaining, `×${order.remaining}`);
      // Only the head is being worked on, so only the head has a bar. A queued
      // order showing 0% would claim it had started.
      row.bar.style.width = order.progress === null ? '0%' : `${clampPercent(order.progress)}%`;
      // `dataset` rather than a class, for the reason the inspector's status
      // tone is one: there is no stale state to remember to clear.
      row.root.dataset['state'] = order.blocked ? 'blocked' : order.progress === null ? 'waiting' : 'active';
      row.root.title = order.blocked
        ? `${order.name} is finished and your bag is full — make room for it.`
        : `${order.name} ×${order.remaining}`;
    }
  }
}

/**
 * Ticks per simulated second.
 *
 * Written here rather than imported: §4 lets the UI reach the controller and
 * the view models, and `simulation-clock.ts` is neither. The view carries a
 * tick count because ticks are what the simulation is exact in (§6 R3); this
 * is the one division that turns it into the seconds a player reads, and it
 * happens on the presentation side where a division is allowed to be a
 * division. `tests/unit/ui-panels.dom.test.ts` asserts the two agree.
 */
const TICKS_PER_SECOND = 30;

function label(text: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'if-inspector__label';
  element.textContent = text;
  return element;
}

/** The building a cell places, read off the element the listener is bound to. */
function buildingOf(event: Event): string | null {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return null;
  return target.dataset['building'] ?? null;
}

function setText(element: HTMLElement, text: string): void {
  if (element.textContent !== text) element.textContent = text;
}

/** `progress` is 0..1, but an order parked at its finish line is exactly 1. */
function clampPercent(progress: number): number {
  if (!Number.isFinite(progress) || progress <= 0) return 0;
  return progress >= 1 ? 100 : progress * 100;
}
