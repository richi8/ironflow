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
 */

import { FIRST_ITEM_ID, type ItemId } from '../registries/item-registry.js';

/** Plain, sorted by numeric item id, and therefore byte-stable (§6 R4). */
export type SerializedInventory = readonly (readonly [ItemId, number])[];

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
  protected readonly counts = new Map<ItemId, number>();

  /**
   * The class name, for failure messages. Written down rather than read from
   * `constructor.name`, which a minifier is free to rename.
   */
  protected abstract readonly kind: string;

  abstract spaceFor(itemId: ItemId): number;

  /** What the subclass must do when a count changes. Slots, mostly. */
  protected abstract onCountChanged(itemId: ItemId, before: number, after: number): void;

  count(itemId: ItemId): number {
    return this.counts.get(itemId) ?? 0;
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

    const before = this.count(itemId);
    this.counts.set(itemId, before + added);
    this.onCountChanged(itemId, before, before + added);
    return added;
  }

  remove(itemId: ItemId, amount: number): number {
    const label = `${this.kind}.remove`;
    assertItemId(itemId, label);
    assertAmount(amount, label);

    const held = this.count(itemId);
    const taken = Math.min(held, amount);
    if (taken === 0) return 0;

    if (taken === held) {
      this.counts.delete(itemId);
    } else {
      this.counts.set(itemId, held - taken);
    }
    this.onCountChanged(itemId, held, held - taken);
    return taken;
  }

  isEmpty(): boolean {
    return this.counts.size === 0;
  }

  toJSON(): SerializedInventory {
    const entries: [ItemId, number][] = [];
    for (const [itemId, count] of this.counts) entries.push([itemId, count]);
    entries.sort((a, b) => a[0] - b[0]);
    return entries;
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
}

/**
 * A chest, or the player's bag: `slots` slots, each holding one stack.
 *
 * Slot usage is tracked as a running total rather than recomputed, because
 * `spaceFor` is asked on every inserter's every tick and the alternative walks
 * the contents each time.
 */
export class SlotInventory extends ContentsInventory {
  protected override readonly kind = 'SlotInventory';

  readonly slots: number;

  private readonly stackSizeOf: StackSizeLookup;

  private slotsUsed = 0;

  constructor(options: SlotInventoryOptions) {
    super();
    if (!Number.isInteger(options.slots) || options.slots < 1) {
      throw new RangeError(`SlotInventory: slots must be a whole number above 0, got ${options.slots}.`);
    }
    this.slots = options.slots;
    this.stackSizeOf = options.stackSizeOf;
  }

  /** Slots currently occupied, with items packed as tightly as stacks allow. */
  get usedSlots(): number {
    return this.slotsUsed;
  }

  get freeSlots(): number {
    return this.slots - this.slotsUsed;
  }

  /** Room in this item's part-filled stack, plus a full stack per free slot. */
  override spaceFor(itemId: ItemId): number {
    const stackSize = this.stackSizeOf(itemId);
    const held = this.count(itemId);
    const roomInPartStack = slotsFor(held, stackSize) * stackSize - held;
    return roomInPartStack + this.freeSlots * stackSize;
  }

  protected override onCountChanged(itemId: ItemId, before: number, after: number): void {
    const stackSize = this.stackSizeOf(itemId);
    this.slotsUsed += slotsFor(after, stackSize) - slotsFor(before, stackSize);
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
    super();
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

  /** Nothing to keep in step: capacity is per item, and the map holds it. */
  protected override onCountChanged(): void {}

  static fromJSON(serialized: SerializedInventory, options: BufferInventoryOptions): BufferInventory {
    const inventory = new BufferInventory(options);
    restore(inventory, serialized, 'BufferInventory.fromJSON');
    return inventory;
  }
}
