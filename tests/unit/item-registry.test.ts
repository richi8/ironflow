import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import {
  FIRST_ITEM_ID,
  ItemRegistry,
  MAX_STACK_SIZE,
  NO_ITEM,
  type ItemDefinition,
} from '../../src/game/registries/item-registry.js';

/**
 * The item registry. See ironflow.md C08 tasks 1–2.
 *
 * What is protected here is the numbering, because it is the one thing in this
 * file that a save depends on and that nothing in a running session can reveal
 * as wrong. Three promises:
 *
 * 1. **A runtime id, once given out, is that item's forever.** Reordering or
 *    inserting content renumbers nothing that a save has already seen, and a
 *    deleted item's number is never handed to its replacement — which would
 *    turn every stack of it in every old save into something else.
 * 2. **`0` is never an item.** Belts and inserter hands use it for "empty", and
 *    a valid falsy id is the bug family `NO_ENTITY` exists to prevent (C05).
 * 3. **Content is validated at construction**, loudly, with the id in the
 *    message — a typo in `data/items.ts` must fail on the first frame.
 */

const IRON: ItemDefinition = { id: 'iron', name: 'Iron', stackSize: 50, sprite: 'item:iron', category: 'raw' };
const COPPER: ItemDefinition = {
  id: 'copper',
  name: 'Copper',
  stackSize: 100,
  sprite: 'item:copper',
  category: 'plate',
};
const COAL: ItemDefinition = { id: 'coal', name: 'Coal', stackSize: 50, sprite: 'item:coal', category: 'raw' };

describe('ItemRegistry numbering', () => {
  it('numbers items from 1 in content order, leaving 0 for "no item"', () => {
    const registry = new ItemRegistry([IRON, COPPER, COAL]);

    expect(registry.idOf('iron')).toBe(FIRST_ITEM_ID);
    expect(registry.idOf('copper')).toBe(2);
    expect(registry.idOf('coal')).toBe(3);
    expect(registry.isItemId(NO_ITEM)).toBe(false);
  });

  it('keeps saved ids when the content table is reordered', () => {
    const before = new ItemRegistry([IRON, COPPER, COAL]);
    const mapping = before.idMapping();

    // The same content, shuffled — exactly what editing data/items.ts does.
    const after = new ItemRegistry([COAL, IRON, COPPER], { assignedIds: mapping });

    expect(after.idMapping()).toEqual(mapping);
    expect(after.byId(before.idOf('coal')).id).toBe('coal');
  });

  it('appends new content above every number the save mentions', () => {
    const saved = new ItemRegistry([IRON, COPPER]).idMapping();
    const steel: ItemDefinition = { id: 'steel', name: 'Steel', stackSize: 100, sprite: 'item:steel', category: 'plate' };

    const registry = new ItemRegistry([IRON, steel, COPPER], { assignedIds: saved });

    expect(registry.idOf('iron')).toBe(1);
    expect(registry.idOf('copper')).toBe(2);
    expect(registry.idOf('steel')).toBe(3);
  });

  it('never reuses the number of an item that was deleted', () => {
    // 'copper' had id 2 and is gone from the table; 'steel' must not inherit it,
    // or every old save's copper becomes steel.
    const saved = new ItemRegistry([IRON, COPPER, COAL]).idMapping();
    const steel: ItemDefinition = { id: 'steel', name: 'Steel', stackSize: 100, sprite: 'item:steel', category: 'plate' };

    const registry = new ItemRegistry([IRON, COAL, steel], { assignedIds: saved });

    expect(registry.idOf('coal')).toBe(3);
    expect(registry.idOf('steel')).toBe(4);
    expect(registry.has('copper')).toBe(false);
  });

  it('produces a mapping sorted by string id, whatever order the numbers landed in', () => {
    const a = new ItemRegistry([IRON, COPPER, COAL]);
    const b = new ItemRegistry([COAL, IRON, COPPER], { assignedIds: a.idMapping() });

    expect(Object.keys(a.idMapping())).toEqual(['coal', 'copper', 'iron']);
    expect(JSON.stringify(b.idMapping())).toBe(JSON.stringify(a.idMapping()));
  });

  it('refuses a saved mapping that is not usable', () => {
    expect(() => new ItemRegistry([IRON], { assignedIds: { iron: 0 } })).toThrow(/not a usable item id/);
    expect(() => new ItemRegistry([IRON], { assignedIds: { iron: 1.5 } })).toThrow(/not a usable item id/);
    expect(() => new ItemRegistry([IRON, COPPER], { assignedIds: { iron: 1, copper: 1 } })).toThrow(/both/);
  });
});

describe('ItemRegistry lookups', () => {
  it('answers by string id, by runtime id and by stack size', () => {
    const registry = new ItemRegistry([IRON, COPPER]);

    expect(registry.get('copper').name).toBe('Copper');
    expect(registry.byId(registry.idOf('copper')).name).toBe('Copper');
    expect(registry.stackSizeOf(registry.idOf('copper'))).toBe(100);
    expect(registry.size).toBe(2);
    expect(registry.all().map((item) => item.id)).toEqual(['iron', 'copper']);
  });

  it('throws with the id in the message rather than returning undefined', () => {
    const registry = new ItemRegistry([IRON]);

    expect(() => registry.get('irno')).toThrow(/"irno"/);
    expect(() => registry.idOf('irno')).toThrow(/"irno"/);
    expect(() => registry.byId(99)).toThrow(/99/);
    expect(() => registry.stackSizeOf(NO_ITEM)).toThrow(/runtime id 0/);
  });

  it('freezes definitions, so content cannot be edited after startup', () => {
    const registry = new ItemRegistry([IRON]);
    expect(Object.isFrozen(registry.get('iron'))).toBe(true);
    expect(Object.isFrozen(registry.all())).toBe(true);
  });

  it('hands stackSizeOf over as a value without losing this', () => {
    const registry = new ItemRegistry([IRON]);
    const lookup = registry.stackSizeOf;
    expect(lookup(registry.idOf('iron'))).toBe(50);
  });
});

describe('ItemRegistry validation', () => {
  const cases: readonly (readonly [string, Partial<ItemDefinition>, RegExp])[] = [
    ['an empty id', { id: '' }, /not a usable item id/],
    ['a padded id', { id: ' iron ' }, /not a usable item id/],
    ['no name', { name: '' }, /has no name/],
    ['a fractional stack', { stackSize: 2.5 }, /stackSize/],
    ['a zero stack', { stackSize: 0 }, /stackSize/],
    ['an oversized stack', { stackSize: MAX_STACK_SIZE + 1 }, /stackSize/],
    ['no sprite', { sprite: '' }, /has no sprite/],
    ['a category nothing knows', { category: 'ore' as never }, /category/],
  ];

  for (const [what, patch, message] of cases) {
    it(`refuses ${what}`, () => {
      expect(() => new ItemRegistry([{ ...IRON, ...patch }])).toThrow(message);
    });
  }

  it('refuses two items with the same id', () => {
    expect(() => new ItemRegistry([IRON, { ...IRON, name: 'Iron again' }])).toThrow(/share the id "iron"/);
  });
});

describe('the shipped item table', () => {
  it('registers §15’s first six items with their stack sizes', () => {
    const registry = new ItemRegistry(ITEMS);

    expect(registry.all().map((item) => item.id)).toEqual([
      'iron_ore',
      'copper_ore',
      'coal',
      'stone',
      'iron_plate',
      'copper_plate',
    ]);
    expect(registry.stackSizeOf(registry.idOf('iron_ore'))).toBe(50);
    expect(registry.stackSizeOf(registry.idOf('iron_plate'))).toBe(100);
  });

  it('gives every item its own sprite id', () => {
    const sprites = new Set(ITEMS.map((item) => item.sprite));
    expect(sprites.size).toBe(ITEMS.length);
  });
});
