/**
 * The item content table. See ironflow.md §15 and C08.
 *
 * Pure data, no logic, and the only file that has to change to add an item.
 * Order is content order, and — because the registry numbers items in this
 * order — it is also the order the runtime ids come out in. **Append; do not
 * reorder.** A save written before a reordering keeps its own numbering
 * (`ItemRegistry` takes the mapping back from the save), so a reorder is not
 * fatal, but it makes every save carry a different table for no gain.
 *
 * C08 ships six of §15's thirteen, which is what the plan asks for: the four
 * raw resources C09–C11 will mine, and the two plates C15's furnace turns them
 * into. The intermediates and the science item arrive with the recipes that
 * make them (C16, C22); an item nothing can produce or consume is a row in a
 * table that no test can tell is wrong. C15 adds `steel` and `brick` under
 * that same rule — they are what §15's other two smelting recipes make.
 *
 * C16 adds the three intermediates §15 names first: `gear`, `copper_wire` and
 * `circuit` — C16 task 4's three recipes, and a chain rather than three
 * unrelated rows: plates make gears and wire, and wire and a plate make a
 * circuit. `frame` and `data_core` wait, because the recipes that would make
 * them are the two whose *consumer* is C22's lab, and a recipe no player has
 * a reason to run is content that cannot be balanced.
 *
 * `fuelSeconds` is how long one item burns in a machine that has a fuel
 * buffer. It lives on the *item*, not on the furnace, so C21's generator burns
 * the same coal for the same eight seconds without either building knowing
 * about the other (C15).
 *
 * ## Building items (C20)
 *
 * The seven at the end are the change C16 said it was not making: §15's "a
 * building is placed by consuming its item", with the item being an ordinary
 * registered item rather than a string in a second bag beside the real one.
 * They are not in §15's thirteen-row table — that table is the *materials* —
 * but they are what its building table's "crafted from" column has always
 * implied, and the player's `ItemCounts` existed only because they were
 * missing. It is gone; `items/build-materials.ts` is what replaced it.
 *
 * One row per building in `data/buildings.ts`, in the same order, and a test
 * asserts that correspondence in both directions: a building whose item does
 * not exist cannot be paid for, and an unplaceable building item is a stack a
 * player can never spend. C21 brings the generator and the power pole, which
 * §15 owed, and the electric furnace, which it did not — see C21's deviations.
 * C22 brings the lab, which §15 owed, and the two tier-2 buildings its
 * technology tree unlocks; the radar arrives with C23. **The one-to-one
 * correspondence and the shared order both survive C22's two *materials*
 * landing after the building items**: the test that compares the two tables
 * filters out everything that is not a building, so a material in the middle
 * costs nothing and the append-only rule above is kept.
 *
 * Stack sizes are **balance numbers**. A hundred belts and fifty of everything
 * else: belts are spent a dozen at a time and a stack that ran out mid-drag is
 * the one shortage that reads as a bug (C13), and fifty of anything else is
 * well past what a player carries before they run out of somewhere to put it.
 */

import type { ItemDefinition } from '../registries/item-registry.js';

export const ITEMS: readonly ItemDefinition[] = Object.freeze([
  { id: 'iron_ore', name: 'Iron Ore', stackSize: 50, sprite: 'item:iron_ore', category: 'raw' },
  { id: 'copper_ore', name: 'Copper Ore', stackSize: 50, sprite: 'item:copper_ore', category: 'raw' },
  { id: 'coal', name: 'Coal', stackSize: 50, sprite: 'item:coal', category: 'raw', fuelSeconds: 8 },
  { id: 'stone', name: 'Stone', stackSize: 50, sprite: 'item:stone', category: 'raw' },
  { id: 'iron_plate', name: 'Iron Plate', stackSize: 100, sprite: 'item:iron_plate', category: 'plate' },
  { id: 'copper_plate', name: 'Copper Plate', stackSize: 100, sprite: 'item:copper_plate', category: 'plate' },
  { id: 'steel', name: 'Steel', stackSize: 100, sprite: 'item:steel', category: 'plate' },
  { id: 'brick', name: 'Brick', stackSize: 100, sprite: 'item:brick', category: 'plate' },
  { id: 'gear', name: 'Gear', stackSize: 100, sprite: 'item:gear', category: 'intermediate' },
  { id: 'copper_wire', name: 'Copper Wire', stackSize: 200, sprite: 'item:copper_wire', category: 'intermediate' },
  { id: 'circuit', name: 'Circuit', stackSize: 200, sprite: 'item:circuit', category: 'intermediate' },

  // Building items (C20). Order follows `data/buildings.ts`, which is §15's
  // building table order, which is also build-menu and hotkey order.
  { id: 'miner', name: 'Miner', stackSize: 50, sprite: 'item:miner', category: 'building' },
  { id: 'belt', name: 'Transport Belt', stackSize: 100, sprite: 'item:belt', category: 'building' },
  { id: 'splitter', name: 'Splitter', stackSize: 50, sprite: 'item:splitter', category: 'building' },
  { id: 'inserter', name: 'Inserter', stackSize: 50, sprite: 'item:inserter', category: 'building' },
  { id: 'furnace', name: 'Furnace', stackSize: 50, sprite: 'item:furnace', category: 'building' },
  { id: 'assembler', name: 'Assembler', stackSize: 50, sprite: 'item:assembler', category: 'building' },
  { id: 'chest', name: 'Chest', stackSize: 50, sprite: 'item:chest', category: 'building' },
  // C21's three. Fifty apiece, for the reason every other non-belt building
  // has fifty: it is past what a player carries before they run out of
  // somewhere to put it.
  { id: 'generator', name: 'Generator', stackSize: 50, sprite: 'item:generator', category: 'building' },
  { id: 'power_pole', name: 'Power Pole', stackSize: 50, sprite: 'item:power_pole', category: 'building' },
  {
    id: 'electric_furnace',
    name: 'Electric Furnace',
    stackSize: 50,
    sprite: 'item:electric_furnace',
    category: 'building',
  },

  /* ---------------------------------------------------------------------- *
   * C22. Two materials and three buildings, and they are at the **end** of
   * the table rather than in §15's row order, because the header's rule is
   * append-only: the runtime ids are this file's order, and sliding `frame`
   * and `data_core` up among the plates would renumber every building item
   * below them for no gain.
   * ---------------------------------------------------------------------- */
  { id: 'frame', name: 'Structural Frame', stackSize: 50, sprite: 'item:frame', category: 'intermediate' },
  /**
   * The science item (§15, C22 task 3). Everything research costs is counted
   * in these, and the lab is the only thing that consumes one — which is why
   * it is the one item in the table whose consumer is not a recipe.
   */
  { id: 'data_core', name: 'Data Core', stackSize: 200, sprite: 'item:data_core', category: 'science' },
  { id: 'lab', name: 'Lab', stackSize: 50, sprite: 'item:lab', category: 'building' },
  { id: 'miner_2', name: 'Miner Mk2', stackSize: 50, sprite: 'item:miner_2', category: 'building' },
  { id: 'assembler_2', name: 'Assembler Mk2', stackSize: 50, sprite: 'item:assembler_2', category: 'building' },

  /* ---------------------------------------------------------------------- *
   * C23. The radar §15 has owed since revision 2, and the underground belt
   * §9 named in the belt model's own table. Appended, like everything since
   * C21, because this file's order is the runtime id order and the hotbar's.
   *
   * A hundred underground belts rather than fifty, which is the belt's stack
   * and for the belt's reason (C13): they are spent two at a time and a run
   * of them is laid in one go.
   * ---------------------------------------------------------------------- */
  { id: 'radar', name: 'Radar', stackSize: 50, sprite: 'item:radar', category: 'building' },
  {
    id: 'underground_belt',
    name: 'Underground Belt',
    stackSize: 100,
    sprite: 'item:underground_belt',
    category: 'building',
  },
] satisfies readonly ItemDefinition[]);
