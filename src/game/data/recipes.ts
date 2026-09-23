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
 * and does something. C22 adds five: `make_frame` and `make_data_core`, which
 * §15 held back until the lab existed to consume them, the lab, and the two
 * tier-2 buildings the tech tree unlocks. The radar waits for C23.
 *
 * ## Locked recipes (C22)
 *
 * From C22 a recipe can be **unavailable** — `data/technologies.ts` decides
 * which, and nothing in this file says so, for the same reason a build cost
 * does not say which building menu it appears in. A technology that unlocks a
 * building unlocks the recipe that makes its item along with it, so only a
 * recipe whose product is *not* a building is ever named in the tree: in v1
 * that is `smelt_steel` and `make_frame`. Everything this table declares and
 * no technology claims is available from the first frame.
 *
 * ## `handCraftable` (C21A, widened in C31)
 *
 * C21A flagged eight rows: §15's five hand-craftable buildings plus the
 * gear, wire and circuit they are made of. **C31 flags every crafting row**,
 * because a new game now starts with an empty bag (see the plan's C31): the
 * player's hands are the only machine there is until they have built one, and
 * an assembler, a lab or a generator the player had to be given would be the
 * starting kit coming back by the side door.
 *
 * The flag stays a column, and absent still means **no** — so the first
 * machine-only recipe a later chunk adds says so by leaving it off, rather
 * than every existing row having to opt in. **The plates are still not among
 * them**, and cannot be: a plate is smelted, smelting is what a furnace is
 * for, and `RecipeRegistry` refuses a hand-craftable smelting recipe outright.
 *
 * What makes an empty bag playable, then, is `make_furnace` taking **stone**
 * rather than brick: stone and coal are mined by hand, a furnace is crafted
 * from the first, burns the second, and everything else follows from plates.
 * C19 guarantees a stone and a coal patch within thirty tiles of spawn on
 * every seed. The soft-lock guarantee therefore rests on hand mining and on
 * demolition refunding in full, and no longer on a kit.
 *
 * Research still gates by hand what it gates in a machine: a locked recipe is
 * refused with `locked` whichever does the making (C22).
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
    handCraftable: true,
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
    // Raw stone, not brick (C31). A new game starts with an empty bag, and
    // brick is baked in a furnace, so a furnace made of brick is a furnace
    // nobody can make first. Ten stone is twenty seconds of hand mining — the
    // first thing a player crafts, and cheap enough that the second furnace
    // is not a decision. A **balance number**, timed by
    // `tests/balance/first-factory.test.ts`. Brick keeps five consumers.
    id: 'make_furnace',
    inputs: [{ itemId: 'stone', count: 10 }],
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
    handCraftable: true,
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
    handCraftable: true,
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
    handCraftable: true,
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
    handCraftable: true,
  },

  /* ---------------------------------------------------------------------- *
   * Research (C22). The two rows §15 held back — "`make_frame` and
   * `make_data_core` wait for C22's lab, which is what consumes what they
   * make" — plus the lab itself and the two tier-2 buildings its tree
   * unlocks.
   * ---------------------------------------------------------------------- */
  {
    // §15's row, transcribed. Its only consumer is `make_assembler_2`, which
    // is the other half of what `construction_1` unlocks: a technology that
    // hands the player a material and the one thing that eats it, so the
    // frame is never a stack with nowhere to go.
    id: 'make_frame',
    inputs: [
      { itemId: 'steel', count: 2 },
      { itemId: 'brick', count: 4 },
    ],
    outputs: [{ itemId: 'frame', count: 1 }],
    seconds: 4.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // §15's row, transcribed, and the most load-bearing 2.5 in the game: at a
    // tier-1 assembler's speed 0.5 one core takes five seconds, which is
    // exactly one lab's five seconds per research unit. **One assembler feeds
    // one lab.** See §15's derived ratios.
    id: 'make_data_core',
    inputs: [
      { itemId: 'gear', count: 1 },
      { itemId: 'copper_plate', count: 1 },
    ],
    outputs: [{ itemId: 'data_core', count: 1 }],
    seconds: 2.5,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // §15's building table says 10 gear, 10 circuit, **4 frame**, and the
    // frames are gone. A frame is two steel, steel is what `smelting_2`
    // unlocks, and `smelting_2` is a technology — so a lab made of frames
    // would be a lab you needed research to build and research you needed a
    // lab to do. Nothing on the path to the *first* technology may be behind
    // one (C22's entry-path rule); the twelve brick cost a detour through
    // stone and a furnace, which is where the game starts anyway.
    id: 'make_lab',
    inputs: [
      { itemId: 'gear', count: 10 },
      { itemId: 'circuit', count: 10 },
      { itemId: 'brick', count: 12 },
    ],
    outputs: [{ itemId: 'lab', count: 1 }],
    // Five seconds, which at a tier-1 assembler's speed is ten and takes the
    // title of longest single craft from `make_assembler`. C20's rule — a
    // building's craft time tracks the size of its bill — and this bill is
    // the biggest in the game.
    seconds: 5.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // The tier-1 miner's bill with its plates turned to steel and two more
    // gears on top. **Balance numbers**, on C20's rule: a building that mines
    // twice as fast costs about twice as much and costs it in the material
    // the technology two tiers above it unlocked.
    id: 'make_miner_2',
    inputs: [
      { itemId: 'gear', count: 6 },
      { itemId: 'circuit', count: 4 },
      { itemId: 'steel', count: 4 },
    ],
    outputs: [{ itemId: 'miner_2', count: 1 }],
    seconds: 3.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // The tier-1 assembler's bill, grown, with the frames that are the other
    // half of `construction_1`. **Balance numbers.**
    id: 'make_assembler_2',
    inputs: [
      { itemId: 'gear', count: 10 },
      { itemId: 'circuit', count: 6 },
      { itemId: 'frame', count: 4 },
    ],
    outputs: [{ itemId: 'assembler_2', count: 1 }],
    seconds: 5.0,
    category: 'crafting',
    handCraftable: true,
  },

  /* ---------------------------------------------------------------------- *
   * C23. The radar's recipe is §15's building-table row, transcribed; the
   * underground belt's is a **balance number**, because §15 never gave it one.
   * ---------------------------------------------------------------------- */
  {
    // §15's row: 5 gear, 5 circuit, 10 iron_plate. Three seconds, which is
    // `make_generator`'s, on C20's rule that a craft time tracks the size of
    // a bill — twenty items apiece.
    id: 'make_radar',
    inputs: [
      { itemId: 'gear', count: 5 },
      { itemId: 'circuit', count: 5 },
      { itemId: 'iron_plate', count: 10 },
    ],
    outputs: [{ itemId: 'radar', count: 1 }],
    seconds: 3.0,
    category: 'crafting',
    handCraftable: true,
  },
  {
    // **Two at a time**, like `make_belt`, and for a reason stronger than
    // symmetry: an underground belt is *useless alone*. A run is a pair, so a
    // recipe that made one would leave the player with an odd number of
    // mouths and a stub they could not finish. Twice a belt pair's gears for
    // the two mouths, four plates for the casing they are sunk in, and twice
    // `make_belt`'s half-second — all **balance numbers**.
    //
    // Hand-craftable since C31, like every crafting row; it was not from C23
    // until then. A locked recipe is still refused by hand until
    // `logistics_1` is researched (C22's `locked`).
    id: 'make_underground_belt',
    inputs: [
      { itemId: 'gear', count: 2 },
      { itemId: 'iron_plate', count: 4 },
    ],
    outputs: [{ itemId: 'underground_belt', count: 2 }],
    seconds: 1.0,
    category: 'crafting',
    handCraftable: true,
  },
] satisfies readonly RecipeDefinition[]);
