import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { BufferInventory, SlotInventory, type SerializedInventory } from '../../src/game/items/inventory.js';
import { ItemRegistry, NO_ITEM, type ItemId } from '../../src/game/registries/item-registry.js';

/**
 * Inventories. See ironflow.md C08 tasks 3–5.
 *
 * Four things are being protected, all of them invisible until they are broken
 * and expensive by then:
 *
 * 1. **Nothing is invented and nothing is lost.** Every `add` and `remove`
 *    reports what actually happened, and what happened matches what the
 *    container then holds. An inserter that trusts a wrong return value either
 *    duplicates items or deletes them, and the factory that results looks like
 *    a throughput bug for weeks.
 * 2. **Full means exactly full.** A partial add leaves no room behind — the
 *    acceptance criterion, and the difference between a chest that is full and
 *    one that merely refuses.
 * 3. **Contents serialize identically however they were reached** (§6). Two
 *    chests holding the same things must produce the same bytes, or the save
 *    round-trip determinism test (§6 R8) starts failing for reasons that have
 *    nothing to do with the system under test.
 * 4. **A buffer is not a slot inventory.** One item's cap never blocks another
 *    item, which is what keeps a furnace from stalling with room to spare.
 */

const registry = new ItemRegistry(ITEMS);

const IRON: ItemId = registry.idOf('iron_ore'); // stack 50
const COPPER: ItemId = registry.idOf('copper_ore'); // stack 50
const PLATE: ItemId = registry.idOf('iron_plate'); // stack 100

function chest(slots: number): SlotInventory {
  return new SlotInventory({ slots, stackSizeOf: registry.stackSizeOf });
}

describe('SlotInventory capacity', () => {
  it('fills a slot exactly, then refuses the item after it', () => {
    const box = chest(1);

    expect(box.add(IRON, 50)).toBe(50);
    expect(box.count(IRON)).toBe(50);
    expect(box.spaceFor(IRON)).toBe(0);
    expect(box.canAdd(IRON, 1)).toBe(false);
    expect(box.add(IRON, 1)).toBe(0);
    expect(box.count(IRON)).toBe(50);
  });

  it('adds what fits and leaves the inventory exactly full', () => {
    const box = chest(2);

    expect(box.add(IRON, 120)).toBe(100); // two slots of 50
    expect(box.count(IRON)).toBe(100);
    expect(box.usedSlots).toBe(2);
    expect(box.freeSlots).toBe(0);
    expect(box.spaceFor(IRON)).toBe(0);
  });

  it('counts a part-filled stack as a whole slot', () => {
    const box = chest(2);

    box.add(IRON, 60); // 50 + 10: two slots, one of them nearly empty
    expect(box.usedSlots).toBe(2);
    expect(box.spaceFor(IRON)).toBe(40);
    // No free slot left, so a second kind of item does not fit at all.
    expect(box.spaceFor(COPPER)).toBe(0);
    expect(box.add(COPPER, 1)).toBe(0);
  });

  it('measures space per item, using that item’s stack size', () => {
    const box = chest(2);

    expect(box.spaceFor(IRON)).toBe(100); // 2 x 50
    expect(box.spaceFor(PLATE)).toBe(200); // 2 x 100
  });

  it('frees slots again as items leave', () => {
    const box = chest(3);
    box.add(IRON, 110);
    expect(box.usedSlots).toBe(3);

    expect(box.remove(IRON, 70)).toBe(70);
    expect(box.count(IRON)).toBe(40);
    expect(box.usedSlots).toBe(1);
    expect(box.spaceFor(COPPER)).toBe(100);
  });

  it('packs items rather than remembering which slot they were in', () => {
    const packed = chest(2);
    packed.add(IRON, 100);
    packed.remove(IRON, 60);

    const direct = chest(2);
    direct.add(IRON, 40);

    expect(packed.usedSlots).toBe(direct.usedSlots);
    expect(packed.spaceFor(COPPER)).toBe(direct.spaceFor(COPPER));
  });

  it('refuses a slot count that is not a whole number above zero', () => {
    expect(() => chest(0)).toThrow(/slots/);
    expect(() => chest(1.5)).toThrow(/slots/);
  });
});

describe('inventory add and remove are partial and honest', () => {
  it('removes what is there and reports it', () => {
    const box = chest(4);
    box.add(IRON, 30);

    expect(box.remove(IRON, 100)).toBe(30);
    expect(box.count(IRON)).toBe(0);
    expect(box.isEmpty()).toBe(true);
    expect(box.remove(IRON, 1)).toBe(0);
  });

  it('treats an item never seen as zero without recording it', () => {
    const box = chest(4);

    expect(box.count(COPPER)).toBe(0);
    expect(box.remove(COPPER, 5)).toBe(0);
    expect(box.isEmpty()).toBe(true);
    expect(box.toJSON()).toEqual([]);
  });

  it('does nothing, loudly, for a zero amount', () => {
    const box = chest(1);
    expect(box.add(IRON, 0)).toBe(0);
    expect(box.remove(IRON, 0)).toBe(0);
    expect(box.isEmpty()).toBe(true);
  });

  it('throws on an argument no caller could have meant', () => {
    const box = chest(1);
    const buffer = new BufferInventory({ capacityPerItem: 10 });

    expect(() => box.add(IRON, -1)).toThrow(/non-negative integer/);
    expect(() => box.add(IRON, 1.5)).toThrow(/non-negative integer/);
    expect(() => box.remove(IRON, -1)).toThrow(/non-negative integer/);
    expect(() => box.canAdd(IRON, -1)).toThrow(/non-negative integer/);
    expect(() => box.add(NO_ITEM, 1)).toThrow(/NO_ITEM/);
    expect(() => buffer.add(NO_ITEM, 1)).toThrow(/NO_ITEM/);
  });

  it('throws rather than guessing a stack size for an unregistered item', () => {
    const box = chest(1);
    expect(() => box.add(9999, 1)).toThrow(/runtime id 9999/);
  });
});

describe('BufferInventory is not a SlotInventory', () => {
  it('caps each item separately, so one never blocks another', () => {
    const buffer = new BufferInventory({ capacityPerItem: 4 });

    expect(buffer.add(IRON, 10)).toBe(4);
    expect(buffer.spaceFor(IRON)).toBe(0);
    // The furnace-stuck case: iron is full, copper still goes in.
    expect(buffer.add(COPPER, 4)).toBe(4);
    expect(buffer.count(COPPER)).toBe(4);

    // The same contents in a one-slot container: copper has nowhere to go.
    const box = chest(1);
    box.add(IRON, 10);
    expect(box.add(COPPER, 4)).toBe(0);
  });

  it('ignores stack sizes entirely', () => {
    const buffer = new BufferInventory({ capacityPerItem: 500 });

    expect(buffer.add(IRON, 500)).toBe(500); // ten stacks' worth, one buffer
    expect(buffer.count(IRON)).toBe(500);
  });

  it('refuses a capacity that is not a whole number above zero', () => {
    expect(() => new BufferInventory({ capacityPerItem: 0 })).toThrow(/capacityPerItem/);
    expect(() => new BufferInventory({ capacityPerItem: 2.5 })).toThrow(/capacityPerItem/);
  });
});

describe('serialization', () => {
  it('is identical for two inventories that reached the same contents differently', () => {
    const a = chest(4);
    a.add(COPPER, 10);
    a.add(IRON, 100);
    a.remove(IRON, 60);

    const b = chest(4);
    b.add(IRON, 20);
    b.add(COPPER, 30);
    b.remove(COPPER, 20);
    b.add(IRON, 20);

    expect(JSON.stringify(a.toJSON())).toBe(JSON.stringify(b.toJSON()));
  });

  it('sorts by numeric item id, whatever order items arrived in', () => {
    const box = chest(4);
    box.add(PLATE, 1);
    box.add(IRON, 2);
    box.add(COPPER, 3);

    expect(box.toJSON()).toEqual(
      [
        [IRON, 2],
        [COPPER, 3],
        [PLATE, 1],
      ].sort((x, y) => (x[0] as number) - (y[0] as number)),
    );
    expect(box.toJSON().map(([itemId]) => itemId)).toEqual([IRON, COPPER, PLATE]);
  });

  it('survives a JSON round trip unchanged, in both containers', () => {
    const box = chest(4);
    box.add(IRON, 60);
    box.add(PLATE, 5);
    const boxAgain = SlotInventory.fromJSON(JSON.parse(JSON.stringify(box)) as SerializedInventory, {
      slots: 4,
      stackSizeOf: registry.stackSizeOf,
    });

    expect(boxAgain.toJSON()).toEqual(box.toJSON());
    expect(boxAgain.usedSlots).toBe(box.usedSlots);

    const buffer = new BufferInventory({ capacityPerItem: 8 });
    buffer.add(IRON, 8);
    const bufferAgain = BufferInventory.fromJSON(JSON.parse(JSON.stringify(buffer)) as SerializedInventory, {
      capacityPerItem: 8,
    });
    expect(bufferAgain.toJSON()).toEqual(buffer.toJSON());
  });

  it('refuses stored contents that are corrupt or do not fit', () => {
    const options = { slots: 1, stackSizeOf: registry.stackSizeOf };

    expect(() => SlotInventory.fromJSON([[IRON, 0]], options)).toThrow(/whole number above 0/);
    expect(() => SlotInventory.fromJSON([[IRON, -5]], options)).toThrow(/whole number above 0/);
    expect(() => SlotInventory.fromJSON([[NO_ITEM, 5]], options)).toThrow(/NO_ITEM/);
    expect(() => SlotInventory.fromJSON([[IRON, 5], [IRON, 5]], options)).toThrow(/twice/);
    expect(() => SlotInventory.fromJSON([[IRON, 5, 5] as never], options)).toThrow(/\[itemId, count\] pair/);
    expect(() => SlotInventory.fromJSON([[IRON, 200]], options)).toThrow(/does not fit/);
  });
});
