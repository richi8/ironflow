/**
 * The recipe content table. See ironflow.md §15 and C15.
 *
 * Pure data, no logic, and the only file that has to change to add a recipe —
 * that is the whole claim `production-system.ts` makes, and this file is where
 * it is tested. Durations are in seconds because §15's table is; the registry
 * converts them to ticks once (§6 R3).
 *
 * C15 ships §15's four **smelting** recipes and nothing else. The crafting
 * rows arrive with C16's assembler, which is the machine that can run them —
 * a recipe no building in the game can execute is a row no test can tell is
 * wrong, which is the same rule `data/items.ts` follows.
 *
 * Every smelting recipe takes exactly one kind of item, which is what lets a
 * furnace pick its own recipe from whatever an inserter drops in it. That is a
 * property of this table, not a rule in the code: `RecipeRegistry.forInput`
 * refuses to guess when two recipes in a category want the same ingredient.
 *
 * ## Crafting (C16)
 *
 * The three C16 task 4 names, and the reason an assembler is *told* what to
 * make rather than guessing: `iron_plate` is an ingredient of both `make_gear`
 * and `make_circuit`, so the index above answers "ambiguous" and there is
 * nothing to guess from. That is not a smelting/crafting distinction the code
 * knows — it is what these rows happen to look like — which is why the
 * *choosing* is `recipeSelection` in `data/buildings.ts` and not a category
 * test anywhere.
 *
 * Their durations are the recipe's own, before the machine's speed: §15
 * authors `make_gear` at 1.0 s and the tier-1 assembler runs at speed 0.5, so
 * one gear takes 60 ticks. That division happens once, in
 * `registries/craft-durations.ts`, and never here.
 */

import type { RecipeDefinition } from '../registries/recipe-registry.js';

export const RECIPES: readonly RecipeDefinition[] = Object.freeze([
  {
    id: 'smelt_iron',
    inputs: [{ itemId: 'iron_ore', count: 1 }],
    outputs: [{ itemId: 'iron_plate', count: 1 }],
    seconds: 3.2,
    category: 'smelting',
  },
  {
    id: 'smelt_copper',
    inputs: [{ itemId: 'copper_ore', count: 1 }],
    outputs: [{ itemId: 'copper_plate', count: 1 }],
    seconds: 3.2,
    category: 'smelting',
  },
  {
    id: 'smelt_steel',
    inputs: [{ itemId: 'iron_plate', count: 5 }],
    outputs: [{ itemId: 'steel', count: 1 }],
    seconds: 16.0,
    category: 'smelting',
  },
  {
    id: 'bake_brick',
    inputs: [{ itemId: 'stone', count: 2 }],
    outputs: [{ itemId: 'brick', count: 1 }],
    seconds: 3.2,
    category: 'smelting',
  },
  {
    id: 'make_gear',
    inputs: [{ itemId: 'iron_plate', count: 2 }],
    outputs: [{ itemId: 'gear', count: 1 }],
    seconds: 1.0,
    category: 'crafting',
  },
  {
    id: 'make_wire',
    inputs: [{ itemId: 'copper_plate', count: 1 }],
    outputs: [{ itemId: 'copper_wire', count: 2 }],
    seconds: 0.5,
    category: 'crafting',
  },
  {
    id: 'make_circuit',
    inputs: [
      { itemId: 'copper_wire', count: 3 },
      { itemId: 'iron_plate', count: 1 },
    ],
    outputs: [{ itemId: 'circuit', count: 1 }],
    seconds: 1.0,
    category: 'crafting',
  },
] satisfies readonly RecipeDefinition[]);
