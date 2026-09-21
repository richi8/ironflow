/**
 * The technology content table. See ironflow.md §15 and C22 task 4.
 *
 * Pure data, no logic, and the only file that has to change to add a
 * technology: the registry validates it, `research-system.ts` advances it, and
 * `research/unlocks.ts` turns "which of these are done" into "what may be
 * built". Costs are in science items and durations in seconds, because that is
 * how §15's table reads; the registry converts the seconds to ticks once
 * (§6 R3).
 *
 * ## What a cost and a duration mean together
 *
 * A technology is researched in **units**. One unit takes `seconds` of one
 * lab's time and consumes **one of each item in `cost`**, so the count in the
 * cost is the number of units — which is why the registry refuses a bill whose
 * counts disagree. §15 writes "automation_1 (10 data_core)", and that is ten
 * units of one data core each.
 *
 * Every v1 technology takes **5 seconds a unit**. That is deliberate and it is
 * a **balance number**: the cost is the lever that makes a technology
 * expensive (10 cores to 100), and a uniform unit time is what makes a lab's
 * rate a thing the player can hold in their head — twelve units a minute,
 * always. It also lands the sharpest ratio in the chunk: `make_data_core` is
 * 2.5 s, a tier-1 assembler runs at speed 0.5, so one assembler makes exactly
 * one core every five seconds and **one assembler feeds exactly one lab**.
 *
 * ## The v1 tree, and why it is not the one §15 drew
 *
 * §15's tree does not survive contact with §15's building table, and C22 is
 * the chunk that had to find out. Four of its nine nodes unlock something the
 * player must already have in order to research *anything*:
 *
 * ```text
 *   §15 node          unlocks                  why it cannot
 *   automation_1      assembler                C20's starting kit contains one;
 *                                              a locked building the player is
 *                                              given is a building they cannot
 *                                              place
 *   electronics_1     circuit, wire            the inserter, the miner and the
 *                                              lab are all made of circuits
 *   smelting_2        steel, brick             a furnace is twelve brick, and a
 *                                              furnace is a starting building
 *   logistics_1       underground belt         C23's building (§19 rule 4)
 *   exploration_1     radar, map               C23's, likewise
 * ```
 *
 * The rule that resolves all of them, and the one worth remembering:
 * **nothing on the path to the first technology may be behind a technology.**
 * A lab, a generator, a pole and every recipe that goes into a data core are
 * therefore available from the first frame, and research begins where that
 * path ends.
 *
 * What is left is five nodes, each of which unlocks a **new decision** rather
 * than a bigger number — C22 task 4's own test:
 *
 * ```text
 *   logistics_1   (10)  splitter          one line, two ways: the routing puzzle
 *        |
 *   smelting_2    (20)  steel             a second smelting chain, 16 s a unit,
 *        |                                and the material everything below
 *        |                                is made of
 *   power_1       (40)  electric furnace  one coal line to one generator, or one
 *        |                                to every furnace (C21's trade)
 *        +-------------------+
 *        |                   |
 *   mining_2 (60)      construction_1 (100)
 *   miner Mk2 1.0/s    frame + assembler Mk2
 *   every ratio        the machine §15's recipe times were
 *   re-derived        actually written for
 * ```
 *
 * `logistics_2`'s fast belt and fast inserter are **not** here, and the reason
 * is the renderer rather than the tree: the procedural atlas draws a belt as a
 * lane of chevrons and an inserter as an arm, and neither id has a way to say
 * which tier it is. Two buildings on the map that the player cannot tell apart
 * is a worse answer than one technology fewer. They belong to the chunk that
 * gives the renderer that vocabulary. C23 brings `exploration_1` with the
 * radar it unlocks, and adds the underground belt to `logistics_1`.
 *
 * The costs are §15's, node for node. See C22's deviations in the plan.
 */

import type { TechnologyDefinition } from '../registries/technology-registry.js';

/**
 * Seconds of lab time per research unit. Uniform across v1 — see the header.
 *
 * Written once here rather than five times below, because a number repeated
 * five times is a number four of which will one day be stale.
 */
const UNIT_SECONDS = 5.0;

export const TECHNOLOGIES: readonly TechnologyDefinition[] = Object.freeze([
  {
    id: 'logistics_1',
    name: 'Logistics 1',
    summary: 'Split one belt line into two.',
    prerequisites: [],
    cost: [{ itemId: 'data_core', count: 10 }],
    seconds: UNIT_SECONDS,
    // §15 calls the splitter "the highest decisions-per-complexity building
    // available", which is exactly what a first technology should hand over:
    // the player has a working factory and no way to divide a line, and after
    // fifty seconds of lab time they have one.
    //
    // C23 appends the **underground belt** here, which is where §15 always
    // put it, and appending to an existing node is deliberate: adding a
    // prerequisite to one would need a save migration, and adding an unlock
    // does not. The cost stays at ten. Two unlocks for the price of one is
    // not generosity — they are the same sentence said twice, because both
    // answer "this line has to go somewhere else": the splitter divides it
    // and the underground belt gets it past whatever is in the way.
    unlocks: [
      { kind: 'building', id: 'splitter' },
      { kind: 'building', id: 'underground_belt' },
    ],
  },
  {
    id: 'smelting_2',
    name: 'Smelting 2',
    summary: 'Smelt iron plates into steel.',
    prerequisites: ['logistics_1'],
    cost: [{ itemId: 'data_core', count: 20 }],
    seconds: UNIT_SECONDS,
    // A **recipe** unlock, and the only kind of node that is not a building:
    // §15's `smelt_steel` is five plates and sixteen seconds, so a steel chain
    // is a second smelting column with a furnace ratio of its own (§15's
    // derived ratios: one plate furnace feeds exactly one steel furnace).
    // Everything below this node is made of it.
    unlocks: [{ kind: 'recipe', id: 'smelt_steel' }],
  },
  {
    id: 'power_1',
    name: 'Power 1',
    summary: 'A furnace that runs on the grid instead of on coal.',
    // Steel, and not only in the tree: `make_electric_furnace` takes three of
    // them, so the prerequisite is a material dependency as well as an
    // ordering. A technology whose unlock you could not build would be a
    // technology that unlocked nothing.
    prerequisites: ['smelting_2'],
    cost: [{ itemId: 'data_core', count: 40 }],
    seconds: UNIT_SECONDS,
    unlocks: [{ kind: 'building', id: 'electric_furnace' }],
  },
  {
    // C23's, and §15's fifth name restored. It is a **leaf** hanging off
    // `power_1` rather than a link in the spine: appending a node needs no
    // save migration, where inserting one into the chain would renumber what
    // depends on what. So the tree is now one chain with a fork at `power_1`
    // and a second at `mining_2`.
    id: 'exploration_1',
    name: 'Exploration 1',
    summary: 'A radar that maps the ground you have not walked.',
    prerequisites: ['power_1'],
    // Fifty, between `power_1`'s forty and `mining_2`'s sixty, and the
    // ordering is the point rather than the number: a player who has just
    // electrified their smelting should find the next patch *before* they
    // double the rate they empty the current one. A **balance number**.
    cost: [{ itemId: 'data_core', count: 50 }],
    seconds: UNIT_SECONDS,
    // §15's tree writes this node's unlocks as "radar, map". Only the radar
    // is here: the **map panel is not gated**, because the explored set fills
    // from the player's own legs from the first tick and a map you cannot
    // open until the fifth technology is an hour of walking with nothing to
    // show for it. What the radar unlocks is ground the player has *not*
    // walked, which is the part that is worth earning. See C23's deviations.
    unlocks: [{ kind: 'building', id: 'radar' }],
  },
  {
    id: 'mining_2',
    name: 'Mining 2',
    summary: 'A miner that pulls twice as fast.',
    prerequisites: ['power_1'],
    cost: [{ itemId: 'data_core', count: 60 }],
    seconds: UNIT_SECONDS,
    unlocks: [{ kind: 'building', id: 'miner_2' }],
  },
  {
    id: 'construction_1',
    name: 'Construction 1',
    summary: 'Structural frames, and the assembler they build.',
    prerequisites: ['mining_2'],
    cost: [{ itemId: 'data_core', count: 100 }],
    seconds: UNIT_SECONDS,
    // Two unlocks, and they are one decision: the frame is the material and
    // the tier-2 assembler is the only thing that consumes it, so neither is
    // a stack with nowhere to go on the tick the technology lands.
    unlocks: [
      { kind: 'recipe', id: 'make_frame' },
      { kind: 'building', id: 'assembler_2' },
    ],
  },
] satisfies readonly TechnologyDefinition[]);
