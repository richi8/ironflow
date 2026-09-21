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
 *
 * ## Building recipes (C20)
 *
 * The seven at the end are §15's "every building in the table has one, taking
 * exactly the ingredients in its crafted-from column", and they are the pillar
 * 1 moment the plan names: with them the factory builds itself, and gears and
 * circuits stop banking up in a chest with nowhere to go (C16's last note).
 * They are `crafting` because the assembler is the machine that runs them.
 *
 * The ingredients are §15's, transcribed and not invented. Four of the **times**
 * are: §15 gives one only to `make_belt`, `make_inserter` and `make_miner`, so
 * the splitter, the chest, the furnace and the assembler take C20's, chosen so
 * that a building's craft time tracks the size of its bill rather than being
 * flat — half a second for the two that are a handful of plates, one for the
 * splitter, two for the furnace, four for the assembler, which at speed 0.5 is
 * eight seconds and the longest single craft in the game. They are **balance
 * numbers**, and §15's table now carries them.
 *
 * C21 adds three more — the generator, the power pole and the electric
 * furnace — under that same rule: each is a building that can now be placed
 * and does something. The lab and the radar, and with them `make_frame` and
 * `make_data_core`, still wait for C22 and C23.
 *
 * ## `handCraftable` (C21A)
 *
 * §15: "Hand-craftable without a machine (so a new game is never soft-locked):
 * `belt`, `chest`, `inserter`, `miner`, `furnace`, and the plates/gears they
 * need. Everything else requires an assembler."
 *
 * Eight rows carry the flag: §15's five, plus `make_gear` — which is the
 * "gears they need" said out loud — plus `make_wire` and `make_circuit`,
 * because the inserter and the miner each want a circuit and a list that
 * stops one ingredient short of its own entries is not a list. **The plates
 * are not among them**, and cannot be: a plate is smelted, smelting is what a
 * furnace is for, and `RecipeRegistry` refuses a hand-craftable smelting
 * recipe outright.
 *
 * The consequence, written down because it is the one thing §15's sentence
 * does not survive contact with: **hand-crafting alone does not bootstrap a
 * factory from nothing.** `make_furnace` takes brick, brick is baked in a
 * furnace, and the loop closes only because the player is *given* two. The
 * soft-lock guarantee therefore rests on the starting kit and on demolition
 * refunding in full, exactly as C20 said it already did — hand-crafting makes
 * the opening playable without the kit's *assembler*, which is the gate §15
 * actually cares about, and not without its furnace.
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
    handCraftable: true,
  },
  {
    id: 'make_wire',
    inputs: [{ itemId: 'copper_plate', count: 1 }],
    outputs: [{ itemId: 'copper_wire', count: 2 }],
    seconds: 0.5,
    category: 'crafting',
    handCraftable: true,
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
    handCraftable: true,
  },

  /* ---------------------------------------------------------------------- *
   * Building recipes (C20). §15's building table, one row each, in its order.
   * ---------------------------------------------------------------------- */
  {
    id: 'make_miner',
    inputs: [
      { itemId: 'gear', count: 4 },
      { itemId: 'circuit', count: 2 },
      { itemId: 'iron_plate', count: 4 },
    ],
    outputs: [{ itemId: 'miner', count: 1 }],
    seconds: 2.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // Two belts per craft, the one recipe in the game that makes more of its
    // product than the bill suggests. §15 is explicit about it, and it is what
    // keeps a belt cheap enough to lay by the dozen.
    id: 'make_belt',
    inputs: [
      { itemId: 'gear', count: 1 },
      { itemId: 'iron_plate', count: 1 },
    ],
    outputs: [{ itemId: 'belt', count: 2 }],
    seconds: 0.5,
    category: 'crafting',
    handCraftable: true,
  },
  {
    id: 'make_splitter',
    inputs: [
      { itemId: 'gear', count: 2 },
      { itemId: 'circuit', count: 1 },
      { itemId: 'iron_plate', count: 2 },
    ],
    outputs: [{ itemId: 'splitter', count: 1 }],
    seconds: 1.0,
    category: 'crafting',
  },
  {
    id: 'make_inserter',
    inputs: [
      { itemId: 'gear', count: 1 },
      { itemId: 'circuit', count: 1 },
      { itemId: 'iron_plate', count: 1 },
    ],
    outputs: [{ itemId: 'inserter', count: 1 }],
    seconds: 0.5,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // The only building made of brick, and therefore the only consumer stone
    // has: `bake_brick` made bricks in C15 and nothing has wanted one since.
    id: 'make_furnace',
    inputs: [{ itemId: 'brick', count: 12 }],
    outputs: [{ itemId: 'furnace', count: 1 }],
    seconds: 2.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    id: 'make_assembler',
    inputs: [
      { itemId: 'gear', count: 8 },
      { itemId: 'circuit', count: 4 },
      { itemId: 'iron_plate', count: 6 },
    ],
    outputs: [{ itemId: 'assembler', count: 1 }],
    seconds: 4.0,
    category: 'crafting',
  },
  {
    id: 'make_chest',
    inputs: [{ itemId: 'iron_plate', count: 4 }],
    outputs: [{ itemId: 'chest', count: 1 }],
    seconds: 0.5,
    category: 'crafting',
    handCraftable: true,
  },

  /* ---------------------------------------------------------------------- *
   * Power (C21). Two bills are §15's, transcribed; the third and all three
   * times are C21's, chosen on the same rule C20 used — a building's craft
   * time tracks the size of its bill rather than being flat.
   * ---------------------------------------------------------------------- */
  {
    id: 'make_generator',
    inputs: [
      { itemId: 'gear', count: 8 },
      { itemId: 'iron_plate', count: 10 },
      { itemId: 'brick', count: 6 },
    ],
    outputs: [{ itemId: 'generator', count: 1 }],
    // Three seconds: a bill the size of the assembler's without its circuits.
    seconds: 3.0,
    category: 'crafting',
  },
  {
    id: 'make_power_pole',
    inputs: [
      { itemId: 'copper_wire', count: 1 },
      { itemId: 'iron_plate', count: 2 },
    ],
    outputs: [{ itemId: 'power_pole', count: 1 }],
    // The chest's half-second, and for the chest's reason: it is three items,
    // and poles are laid by the dozen.
    seconds: 0.5,
    category: 'crafting',
  },
  {
    // §15 gives this no row, because §15 has no electric furnace. The bill is
    // "a furnace, wired": the same twelve brick, plus the circuits that make
    // it electric and the steel that makes it worth the detour.
    //
    // **It is the first consumer `steel` has ever had.** C20 listed steel as a
    // known dead end — smeltable, and wanted by nothing until C22's lab wants
    // a frame — and this closes it a chunk early, which is why
    // `tests/balance/content.test.ts` no longer carries the exception.
    id: 'make_electric_furnace',
    inputs: [
      { itemId: 'brick', count: 12 },
      { itemId: 'circuit', count: 5 },
      { itemId: 'steel', count: 3 },
    ],
    outputs: [{ itemId: 'electric_furnace', count: 1 }],
    seconds: 3.0,
    category: 'crafting',
  },
] satisfies readonly RecipeDefinition[]);
