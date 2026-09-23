/**
 * Inventories. See ironflow.md C08 tasks 3–5.
 *
 * Two containers with the same five verbs and deliberately different rules:
 *
 * - **`SlotInventory`** — chests and the player. A fixed number of slots, each
 *   holding up to one stack of one item. It fills up because it ran out of
 *   *slots*, whatever is in them.
 * - **`BufferInventory`** — a machine's input and output. A small item→count
 *   map with a per-item cap and no slots at all. It fills up per item, and one
 *   item's cap can never block another's.
 *
 * C08 says in as many words not to use one for the other, and the reason is
 * worth keeping in front of the reader: a furnace whose output used slot
 * mechanics stops smelting when its one slot of plates is full *and* has no
 * free slot for the next stack — the machine sits there, full but not full,
 * and nothing in the UI explains it. That is the "why is my furnace stuck" bug.
 * Machines get caps; containers get slots.
 *
 * ## Partial and honest
 *
 * `add` and `remove` never throw over capacity and never silently drop the
 * remainder: they do what fits and return how much that was. The caller must
 * look at the number — an inserter that assumes its whole hand landed is how
 * items get duplicated or deleted. They *do* throw on a nonsense argument (a
 * negative or fractional amount, the `NO_ITEM` sentinel), which is a
 * programmer error rather than a game state.
 *
 * ## Contents are the state; slots are not
 *
 * *(True of the two containers above. The player's bag has been a third,
 * `GridInventory` at the end of this file, since 2026-09-23: its stacks have
 * positions the player arranges, and those positions are state.)*
 *
 * Serialization is item→count, sorted by numeric item id, and says nothing
 * about which slot anything sits in. Two inventories holding the same items
 * therefore serialize identically however they got there (C08's third
 * acceptance criterion), and items are always packed as tightly as their stack
 * sizes allow — a slot inventory can never be "full" while holding two
 * half-stacks of the same item. The cost is that the player cannot arrange
 * their slots; §2 puts filters, sorting and trash slots out of scope for v1, so
 * there is nothing yet for an arrangement to be worth.
 *
 * Capacity — the slot count, the per-item cap — is **not** serialized. It is a
 * property of the thing that owns the inventory (a chest definition, a recipe),
 * which is content, and §10 keeps content out of saves. `fromJSON` is therefore
 * given the capacity by its owner.
 *
 * ## The backing store is plain data, and it may belong to somebody else (C13)
 *
 * Both containers keep their contents in an `ItemSlots` — an array of
 * `[itemId, count]` pairs, sorted by item id — rather than in a `Map`. That is
 * what lets a **chest** have a real inventory: an entity is plain data that
 * must survive `JSON.stringify` (C05), so it cannot hold one of these classes,
 * but it can hold the array, and a container constructed over that array by
 * reference gives a system the five verbs without a second copy of the stack
 * arithmetic. `ChestEntity.contents` is the authoritative state; the container
 * is a short-lived view over it, built where it is needed and thrown away.
 *
 * The array also removes the `Map` that C08 had to justify: there is nothing
 * left whose iteration order could reach a decision (§6 R4), and a container
 * holding two or three kinds of item scans a three-element array faster than
 * it hashes a key.
 */

import { FIRST_ITEM_ID, type ItemId } from '../registries/item-registry.js';

/** Plain, sorted by numeric item id, and therefore byte-stable (§6 R4). */
export type SerializedInventory = readonly (readonly [ItemId, number])[];

/**
 * A container's contents as plain data: `[itemId, count]` pairs, ascending by
 * item id, with no zero counts in it.
 *
 * The mutable half of `SerializedInventory`, and the shape an entity stores
 * (C13's `ChestEntity.contents`). Sorted because that is what makes two
 * containers holding the same items serialize identically however they got
 * there, which is C08's third acceptance criterion and, from C24, a save that
 * compares equal after a round trip.
 */
export type ItemSlots = [ItemId, number][];

/** How many of one item an `ItemSlots` holds. Zero for anything not in it. */
export function slotsCount(contents: ItemSlots, itemId: ItemId): number {
  for (const entry of contents) {
    if (entry[0] === itemId) return entry[1];
    if (entry[0] > itemId) return 0;
  }
  return 0;
}

/** Set one item's count, keeping the array sorted and free of zeroes. */
function slotsSet(contents: ItemSlots, itemId: ItemId, count: number): void {
  for (let i = 0; i < contents.length; i++) {
    const entry = contents[i];
    if (entry === undefined) continue;
    if (entry[0] === itemId) {
      if (count === 0) contents.splice(i, 1);
      else entry[1] = count;
      return;
    }
    if (entry[0] > itemId) {
      if (count !== 0) contents.splice(i, 0, [itemId, count]);
      return;
    }
  }
  if (count !== 0) contents.push([itemId, count]);
}

/** How a slot inventory asks how big a stack of something is. */
export type StackSizeLookup = (itemId: ItemId) => number;

/** The five verbs every container answers, plus the two derived conveniences. */
export interface Inventory {
  /** How many of one item are held. Zero for anything not present. */
  count(itemId: ItemId): number;
  /** How many more of `itemId` would fit right now. */
  spaceFor(itemId: ItemId): number;
  canAdd(itemId: ItemId, amount: number): boolean;
  /** Add what fits. Returns the amount actually added. */
  add(itemId: ItemId, amount: number): number;
  /** Remove up to `amount`. Returns the amount actually removed. */
  remove(itemId: ItemId, amount: number): number;
  isEmpty(): boolean;
  toJSON(): SerializedInventory;
}

function assertAmount(amount: number, label: string): void {
  if (!Number.isInteger(amount) || amount < 0) {
    throw new RangeError(`${label}: amount must be a non-negative integer, got ${amount}.`);
  }
}

function assertItemId(itemId: ItemId, label: string): void {
  if (!Number.isInteger(itemId) || itemId < FIRST_ITEM_ID) {
    throw new RangeError(`${label}: ${itemId} is not an item id (0 is NO_ITEM and never goes in an inventory).`);
  }
}

/**
 * Everything both containers share. The difference between them is `spaceFor`
 * and what it has to keep track of, so that is all a subclass implements.
 *
 * Backed by a `Map`, which is safe for the reason `ItemCounts` documents: no
 * simulation system iterates it — every question is asked about one item id —
 * and the single traversal, `toJSON`, sorts (§6 R4). A count that reaches zero
 * is deleted rather than kept at 0, so "held nothing" and "held some once" are
 * the same state.
 */
abstract class ContentsInventory implements Inventory {
  /**
   * The contents. Owned by this object, or borrowed from whatever does own it
   * — an entity's plain-data field (C13). Either way it is the single copy:
   * a container never caches a count beside the array it came from.
   */
  protected readonly contents: ItemSlots;

  /**
   * The class name, for failure messages. Written down rather than read from
   * `constructor.name`, which a minifier is free to rename.
   */
  protected abstract readonly kind: string;

  constructor(contents: ItemSlots) {
    this.contents = contents;
  }

  abstract spaceFor(itemId: ItemId): number;

  count(itemId: ItemId): number {
    return slotsCount(this.contents, itemId);
  }

  canAdd(itemId: ItemId, amount: number): boolean {
    const label = `${this.kind}.canAdd`;
    assertItemId(itemId, label);
    assertAmount(amount, label);
    return amount <= this.spaceFor(itemId);
  }

  add(itemId: ItemId, amount: number): number {
    const label = `${this.kind}.add`;
    assertItemId(itemId, label);
    assertAmount(amount, label);
    if (amount === 0) return 0;

    const added = Math.min(amount, this.spaceFor(itemId));
    if (added === 0) return 0;

    slotsSet(this.contents, itemId, this.count(itemId) + added);
    return added;
  }

  remove(itemId: ItemId, amount: number): number {
    const label = `${this.kind}.remove`;
    assertItemId(itemId, label);
    assertAmount(amount, label);

    const held = this.count(itemId);
    const taken = Math.min(held, amount);
    if (taken === 0) return 0;

    slotsSet(this.contents, itemId, held - taken);
    return taken;
  }

  isEmpty(): boolean {
    return this.contents.length === 0;
  }

  /**
   * Replace the contents with a saved set. C24's load.
   *
   * In place rather than by construction, because the container may not be the
   * thing that owns its array: the player's bag is reached through
   * `BuildMaterials` and through a dozen view models that hold the
   * `SlotInventory` itself, so swapping the object would leave every one of
   * them looking at the world before the load. The static `fromJSON`s are for
   * a container being *made*; this is for one that already exists.
   *
   * Cleared first and refilled through `add`, so a saved stack that no longer
   * fits — a chest whose definition shrank between versions — is a throw here
   * rather than a quietly-halved pile a player has to notice for themselves.
   */
  load(serialized: SerializedInventory): void {
    this.contents.length = 0;
    restore(this, serialized, `${this.kind}.load`);
  }

  /**
   * A copy, so a caller holding one cannot watch the container change under it
   * — and, for a borrowed array, cannot reach the entity's own field.
   */
  toJSON(): SerializedInventory {
    return this.contents.map((entry) => [entry[0], entry[1]] as [ItemId, number]);
  }
}

/**
 * Read a serialized inventory into `target`, refusing anything malformed.
 *
 * Loud rather than lenient: a save that says a chest holds −3 of item 0 is
 * corrupt, and a container that quietly drops the entry hides it until the
 * player notices the missing items. C26 validates imported saves before they
 * ever reach this point; this is the last line, and it is cheap.
 */
function restore(target: Inventory, serialized: SerializedInventory, label: string): void {
  const seen = new Set<ItemId>();

  for (const entry of serialized) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new Error(`${label}: ${JSON.stringify(entry)} is not an [itemId, count] pair.`);
    }
    const [itemId, count] = entry;
    assertItemId(itemId, label);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`${label}: item ${itemId} has a stored count of ${count}; it must be a whole number above 0.`);
    }
    if (seen.has(itemId)) {
      throw new Error(`${label}: item ${itemId} appears twice.`);
    }
    seen.add(itemId);

    if (target.add(itemId, count) !== count) {
      throw new Error(`${label}: ${count} of item ${itemId} does not fit in the container it was saved from.`);
    }
  }
}

export interface SlotInventoryOptions {
  /** How many slots. At least 1. */
  readonly slots: number;
  readonly stackSizeOf: StackSizeLookup;
  /**
   * The array to keep the contents in. Defaults to a fresh, empty one.
   *
   * Passed by whatever *owns* the contents — C13's chest hands over its own
   * `contents` field, so the container writes straight into the entity's plain
   * data and nothing has to be copied back. A container built this way is
   * cheap and disposable: make one where it is needed, use it, drop it.
   */
  readonly contents?: ItemSlots;
}

/**
 * A chest, or the player's bag: `slots` slots, each holding one stack.
 *
 * `usedSlots` is walked rather than tracked. C08 tracked it as a running total
 * because `spaceFor` is asked on every inserter's every tick; C13 made
 * containers disposable views over an entity's own array, at which point a
 * running total would have to be recomputed at every construction anyway — and
 * the walk it would do is the walk below, over the two or three kinds of item
 * a v1 container actually holds.
 */
export class SlotInventory extends ContentsInventory {
  protected override readonly kind = 'SlotInventory';

  readonly slots: number;

  private readonly stackSizeOf: StackSizeLookup;

  constructor(options: SlotInventoryOptions) {
    super(options.contents ?? []);
    if (!Number.isInteger(options.slots) || options.slots < 1) {
      throw new RangeError(`SlotInventory: slots must be a whole number above 0, got ${options.slots}.`);
    }
    this.slots = options.slots;
    this.stackSizeOf = options.stackSizeOf;
  }

  /** Slots currently occupied, with items packed as tightly as stacks allow. */
  get usedSlots(): number {
    let used = 0;
    for (const entry of this.contents) used += slotsFor(entry[1], this.stackSizeOf(entry[0]));
    return used;
  }

  get freeSlots(): number {
    return this.slots - this.usedSlots;
  }

  /** Room in this item's part-filled stack, plus a full stack per free slot. */
  override spaceFor(itemId: ItemId): number {
    const stackSize = this.stackSizeOf(itemId);
    const held = this.count(itemId);
    const roomInPartStack = slotsFor(held, stackSize) * stackSize - held;
    return roomInPartStack + this.freeSlots * stackSize;
  }

  static fromJSON(serialized: SerializedInventory, options: SlotInventoryOptions): SlotInventory {
    const inventory = new SlotInventory(options);
    restore(inventory, serialized, 'SlotInventory.fromJSON');
    return inventory;
  }
}

/** How many slots `count` items take at `stackSize` each. */
function slotsFor(count: number, stackSize: number): number {
  return Math.ceil(count / stackSize);
}

export interface BufferInventoryOptions {
  /** How many of *each* item this buffer holds. At least 1. */
  readonly capacityPerItem: number;
  /** The array to keep the contents in. See `SlotInventoryOptions.contents`. */
  readonly contents?: ItemSlots;
}

/**
 * A machine's input or output buffer: a cap per item and nothing else.
 *
 * No slot count, no stack sizes, and therefore no lookup to inject — which is
 * also why a buffer cannot check that an item id is one the registry knows.
 * Buffers are filled by systems from recipes, never by a player dragging
 * something in, so the id always comes from content that the registry has
 * already validated.
 */
export class BufferInventory extends ContentsInventory {
  protected override readonly kind = 'BufferInventory';

  readonly capacityPerItem: number;

  constructor(options: BufferInventoryOptions) {
    super(options.contents ?? []);
    if (!Number.isInteger(options.capacityPerItem) || options.capacityPerItem < 1) {
      throw new RangeError(
        `BufferInventory: capacityPerItem must be a whole number above 0, got ${options.capacityPerItem}.`,
      );
    }
    this.capacityPerItem = options.capacityPerItem;
  }

  override spaceFor(itemId: ItemId): number {
    return this.capacityPerItem - this.count(itemId);
  }

  static fromJSON(serialized: SerializedInventory, options: BufferInventoryOptions): BufferInventory {
    const inventory = new BufferInventory(options);
    restore(inventory, serialized, 'BufferInventory.fromJSON');
    return inventory;
  }
}
/* -------------------------------------------------------------------------- *
 * Grids: stacks with positions (2026-09-23)
 * -------------------------------------------------------------------------- */

/**
 * One occupied slot of a grid: `[slot, itemId, count]`. A grid's contents are
 * these, ascending by slot, with no empty slot written and no zero count.
 *
 * The mutable form, and the one an entity stores (a chest's `contents`); the
 * same shape is what a save writes, so there is nothing to translate.
 */
export type GridEntry = [number, ItemId, number];

/** A grid as plain, read-only data. See `GridEntry`. */
export type SerializedGrid = readonly (readonly [number, ItemId, number])[];

export interface GridInventoryOptions {
  /** How many slots. At least 1. */
  readonly slots: number;
  readonly stackSizeOf: StackSizeLookup;
  /**
   * The array to keep the entries in. Defaults to a fresh, empty one. A chest
   * hands over its own `contents` field, as it did to `SlotInventory` (C13):
   * the grid writes straight into the entity's plain data.
   */
  readonly entries?: GridEntry[];
}

/**
 * A container the way the genre has one: a fixed number of positions, each
 * holding one stack, which the player can rearrange. The player's bag, and
 * since 2026-09-23 every chest.
 *
 * `SlotInventory` packs its contents and has no positions at all. Here **the
 * arrangement is state**: which slot a stack sits in is authoritative (§10),
 * serialized, and changed by the `moveStack` command (§7) or by these rules,
 * which are positional and therefore deterministic whatever order anything
 * happened in (§6 R4):
 *
 * ```text
 * add     tops up stacks of that item in slot order, then fills empty slots
 *         in slot order
 * remove  takes from the last stack of that item first, so the full stacks
 *         at the front are the last to go
 * peek    the item in the lowest occupied slot — what an inserter takes next
 * move    to an empty slot moves; onto the same item merges what fits and
 *         leaves the rest; onto anything else swaps
 * ```
 *
 * A stack never exceeds its item's stack size, and `load` refuses a save
 * that says otherwise.
 */
export class GridInventory implements Inventory {
  readonly slots: number;

  private readonly entries: GridEntry[];
  private readonly stackSizeOf: StackSizeLookup;

  constructor(options: GridInventoryOptions) {
    if (!Number.isInteger(options.slots) || options.slots < 1) {
      throw new RangeError(`GridInventory: slots must be a whole number above 0, got ${options.slots}.`);
    }
    this.slots = options.slots;
    this.stackSizeOf = options.stackSizeOf;
    this.entries = options.entries ?? [];
  }

  /** The stack in slot `index`, as a copy, or null for an empty or unknown slot. */
  cellAt(index: number): readonly [ItemId, number] | null {
    const entry = this.entryAt(index);
    return entry === null ? null : [entry[1], entry[2]];
  }

  /** The item in the lowest occupied slot, or null when empty. */
  peek(): ItemId | null {
    return this.entries[0]?.[1] ?? null;
  }

  get usedSlots(): number {
    return this.entries.length;
  }

  get freeSlots(): number {
    return this.slots - this.entries.length;
  }

  count(itemId: ItemId): number {
    let total = 0;
    for (const entry of this.entries) if (entry[1] === itemId) total += entry[2];
    return total;
  }

  spaceFor(itemId: ItemId): number {
    const stackSize = this.stackSizeOf(itemId);
    let space = this.freeSlots * stackSize;
    for (const entry of this.entries) {
      if (entry[1] === itemId) space += Math.max(0, stackSize - entry[2]);
    }
    return space;
  }

  canAdd(itemId: ItemId, amount: number): boolean {
    assertItemId(itemId, 'GridInventory.canAdd');
    assertAmount(amount, 'GridInventory.canAdd');
    return amount <= this.spaceFor(itemId);
  }

  add(itemId: ItemId, amount: number): number {
    assertItemId(itemId, 'GridInventory.add');
    assertAmount(amount, 'GridInventory.add');
    const stackSize = this.stackSizeOf(itemId);
    let left = amount;

    for (const entry of this.entries) {
      if (left === 0) break;
      if (entry[1] !== itemId) continue;
      const moved = Math.min(left, stackSize - entry[2]);
      if (moved <= 0) continue;
      entry[2] += moved;
      left -= moved;
    }
    for (let slot = 0; slot < this.slots && left > 0; slot++) {
      if (this.entryAt(slot) !== null) continue;
      const moved = Math.min(left, stackSize);
      this.put(slot, itemId, moved);
      left -= moved;
    }
    return amount - left;
  }

  remove(itemId: ItemId, amount: number): number {
    assertItemId(itemId, 'GridInventory.remove');
    assertAmount(amount, 'GridInventory.remove');
    let left = amount;
    for (let i = this.entries.length - 1; i >= 0 && left > 0; i--) {
      const entry = this.entries[i];
      if (entry === undefined || entry[1] !== itemId) continue;
      const taken = Math.min(left, entry[2]);
      entry[2] -= taken;
      left -= taken;
      if (entry[2] === 0) this.entries.splice(i, 1);
    }
    return amount - left;
  }

  /** Take up to `amount` out of one slot. Answers how many came out. */
  takeFromSlot(slot: number, amount: number): number {
    const index = this.indexOf(slot);
    const entry = index < 0 ? undefined : this.entries[index];
    if (entry === undefined) return 0;
    const taken = Math.min(amount, entry[2]);
    entry[2] -= taken;
    if (entry[2] === 0) this.entries.splice(index, 1);
    return taken;
  }

  /**
   * Put `count` of `itemId` into slot `slot`, which must be empty or hold the
   * same item. Answers how many fit. The other half of a move between grids.
   */
  putIntoSlot(slot: number, itemId: ItemId, count: number): number {
    if (!this.isSlot(slot) || count < 1) return 0;
    const entry = this.entryAt(slot);
    const stackSize = this.stackSizeOf(itemId);
    if (entry === null) {
      const moved = Math.min(count, stackSize);
      this.put(slot, itemId, moved);
      return moved;
    }
    if (entry[1] !== itemId) return 0;
    const moved = Math.min(count, stackSize - entry[2]);
    entry[2] += moved;
    return moved;
  }

  /** Replace whatever is in slot `slot` with a stack, or empty it with `null`. */
  setSlot(slot: number, stack: readonly [ItemId, number] | null): void {
    if (!this.isSlot(slot)) return;
    const index = this.indexOf(slot);
    if (index >= 0) this.entries.splice(index, 1);
    if (stack !== null && stack[1] > 0) this.put(slot, stack[0], stack[1]);
  }

  isEmpty(): boolean {
    return this.entries.length === 0;
  }

  /**
   * Move the stack in slot `from` to slot `to` within this grid. Answers
   * false when there is nothing to move or either slot is not one of these.
   */
  move(from: number, to: number): boolean {
    if (!this.isSlot(from) || !this.isSlot(to)) return false;
    const moving = this.cellAt(from);
    if (moving === null) return false;
    if (from === to) return true;

    const target = this.cellAt(to);
    if (target !== null && target[0] === moving[0]) {
      const moved = this.putIntoSlot(to, moving[0], moving[1]);
      this.takeFromSlot(from, moved);
      return true;
    }
    this.setSlot(to, moving);
    this.setSlot(from, target);
    return true;
  }

  isSlot(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.slots;
  }

  /**
   * Totals, item→count ascending: the shape every other container answers,
   * for the HUD and for build costs. Positions are in `toCells`.
   */
  toJSON(): SerializedInventory {
    const totals: [ItemId, number][] = [];
    for (const entry of this.entries) slotsSet(totals, entry[1], slotsCount(totals, entry[1]) + entry[2]);
    return totals;
  }

  /** The arrangement, for the save: a copy of the entries. */
  toCells(): SerializedGrid {
    return this.entries.map((entry) => [entry[0], entry[1], entry[2]] as GridEntry);
  }

  /** Replace the contents with a saved arrangement, in place. Loud about anything malformed. */
  load(serialized: SerializedGrid): void {
    const next: GridEntry[] = [];
    let previous = -1;
    for (const entry of serialized) {
      if (!Array.isArray(entry) || entry.length !== 3) {
        throw new Error(`GridInventory.load: ${JSON.stringify(entry)} is not a [slot, itemId, count] triple.`);
      }
      const [slot, itemId, count] = entry;
      if (!this.isSlot(slot) || slot <= previous) {
        throw new Error(`GridInventory.load: slot ${slot} is out of range or out of order.`);
      }
      previous = slot;
      assertItemId(itemId, 'GridInventory.load');
      if (!Number.isInteger(count) || count < 1 || count > this.stackSizeOf(itemId)) {
        throw new Error(`GridInventory.load: slot ${slot} holds ${count} of item ${itemId}, which is not one stack.`);
      }
      next.push([slot, itemId, count]);
    }
    this.entries.length = 0;
    this.entries.push(...next);
  }

  private indexOf(slot: number): number {
    for (let i = 0; i < this.entries.length; i++) {
      const at = this.entries[i]?.[0] ?? -1;
      if (at === slot) return i;
      if (at > slot) return -1;
    }
    return -1;
  }

  private entryAt(slot: number): GridEntry | null {
    const index = this.indexOf(slot);
    return index < 0 ? null : (this.entries[index] ?? null);
  }

  /** Insert a stack into an empty slot, keeping the entries sorted. */
  private put(slot: number, itemId: ItemId, count: number): void {
    let at = this.entries.length;
    for (let i = 0; i < this.entries.length; i++) {
      if ((this.entries[i]?.[0] ?? -1) > slot) {
        at = i;
        break;
      }
    }
    this.entries.splice(at, 0, [slot, itemId, count]);
  }
}
