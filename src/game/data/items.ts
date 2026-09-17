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
 * `fuelSeconds` is how long one item burns in a machine that has a fuel
 * buffer. It lives on the *item*, not on the furnace, so C21's generator burns
 * the same coal for the same eight seconds without either building knowing
 * about the other (C15).
 *
 * Building items — the `miner` and `chest` a build cost is paid in today — are
 * deliberately *not* here. They become items when C16 gives them recipes; until
 * then the player's bag holds them under their string ids (see `item-stack.ts`).
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
] satisfies readonly ItemDefinition[]);
