/**
 * The technology table, built once from `data/technologies.ts`. See
 * ironflow.md C22 task 1 and §15.
 *
 * Two shapes, for the reason `RecipeRegistry` has two: a
 * `TechnologyDefinition` is what a human authors — string ids, a duration in
 * seconds — and a `Technology` is what the simulation runs on: dense runtime
 * ids, resolved prerequisites and an integer tick count, all computed once
 * here rather than per tick (§6 R3).
 *
 * ## What is validated, and why each check exists
 *
 * C22's test line asks for "prerequisite graph validation (no cycles, no
 * dangling ids — assert at registry build)". The list is longer than that,
 * because every one of these is a content mistake that would otherwise show up
 * as a game that is quietly unwinnable:
 *
 * ```text
 *   dangling prerequisite   a technology nothing can ever satisfy
 *   a cycle                 a branch of the tree nobody can enter
 *   a dangling unlock       a technology that grants a building that does not
 *                           exist — the reward vanishes and nothing says so
 *   two claims on one       "unlocked by" stops being a question with one
 *   unlock                  answer, and the build menu cannot name a
 *                           technology beside a locked row
 *   a redundant recipe      a building unlock carries its own recipe (see
 *   claim                   `unlocks.ts`); naming it again is a second answer
 *                           to the same question
 *   unequal cost counts     a unit consumes one of each item in the bill, so a
 *                           bill of 10 of one and 20 of another would run out
 *                           of the first halfway through with no name for the
 *                           stall (§13, pillar 3)
 *   a cost that is not      research is paid for in science items. Anything
 *   science                 else would make a technology something a player
 *                           could buy with ore
 * ```
 *
 * ## Tiers
 *
 * `tier` is the longest path from a root, computed here because it is a fact
 * about the graph and because the research panel lays the tree out in rows of
 * it. It is derived content, not state: nothing is serialized and re-deriving
 * it after a content change is the point.
 */

import type { ItemStack } from '../items/item-stack.js';
import { TPS } from '../simulation-clock.js';
import type { ItemId, ItemRegistry } from './item-registry.js';

/** A technology's runtime id: a dense index into content order. */
export type TechnologyId = number;

/** "No technology." Never a real one; `queue[0]` of an empty queue reads as this. */
export const NO_TECHNOLOGY: TechnologyId = -1;

/**
 * What a technology grants. See ironflow.md C22 task 1, which writes it
 * "building | recipe | modifier".
 *
 * **There is no `modifier` in v1**, and that is a decision rather than an
 * omission: no technology in `data/technologies.ts` changes a number, so a
 * third member would be a shape with no producer, no consumer and no test —
 * which is exactly what §19 rule 10 forbids. The machinery a modifier needs
 * is real (every derived content table, `CraftDurations` among them, would
 * have to be rebuilt when one landed), and it belongs to the chunk that has a
 * modifier to apply.
 */
export type Unlock =
  | { readonly kind: 'building'; readonly id: string }
  | { readonly kind: 'recipe'; readonly id: string };

/** A technology as authored in `data/technologies.ts`. */
export interface TechnologyDefinition {
  readonly id: string;
  /** The player-facing name. Content (C06), and one day translated. */
  readonly name: string;
  /** One line saying what it is *for*, for the research panel. */
  readonly summary: string;
  readonly prerequisites: readonly string[];
  /** Science items. Every count is the same, and that count is the unit total. */
  readonly cost: readonly ItemStack[];
  /** Seconds of one lab's time per unit. Converted to ticks once (§6 R3). */
  readonly seconds: number;
  readonly unlocks: readonly Unlock[];
}

/** One line of a cost, in the ids the simulation counts in. */
export interface TechnologyCost {
  readonly itemId: ItemId;
  /** How many in total, which is also the number of units. See the header. */
  readonly count: number;
}

/** A technology as the simulation runs it. Frozen, built once. */
export interface Technology {
  readonly technologyId: TechnologyId;
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly prerequisites: readonly TechnologyId[];
  readonly cost: readonly TechnologyCost[];
  /** How many units it takes. One of each `cost` item apiece. */
  readonly units: number;
  /** Integer ticks one unit takes in one lab (§6 R3). */
  readonly durationTicks: number;
  readonly unlocks: readonly Unlock[];
  /** Longest path from a root, so the panel can draw the tree in rows. */
  readonly tier: number;
}

function durationTicks(definition: TechnologyDefinition): number {
  return Math.round(definition.seconds * TPS);
}

function validate(definition: TechnologyDefinition, items: ItemRegistry): void {
  const where = `technology "${definition.id}"`;
  if (typeof definition.id !== 'string' || definition.id.length === 0 || definition.id.trim() !== definition.id) {
    throw new Error(`TechnologyRegistry: ${JSON.stringify(definition.id)} is not a usable technology id.`);
  }
  if (definition.name.length === 0) {
    throw new Error(`TechnologyRegistry: ${where} has no name.`);
  }
  if (definition.summary.length === 0) {
    throw new Error(`TechnologyRegistry: ${where} has no summary; the research panel shows one.`);
  }
  if (!Number.isFinite(definition.seconds) || definition.seconds <= 0) {
    throw new Error(`TechnologyRegistry: ${where} takes ${definition.seconds} seconds a unit, which is not a duration.`);
  }
  if (durationTicks(definition) < 1) {
    throw new Error(`TechnologyRegistry: ${where} takes ${definition.seconds} seconds a unit, which rounds to under one tick.`);
  }
  if (definition.cost.length === 0) {
    throw new Error(`TechnologyRegistry: ${where} costs nothing; a technology is paid for in science.`);
  }
  if (definition.unlocks.length === 0) {
    throw new Error(`TechnologyRegistry: ${where} unlocks nothing, so researching it would change nothing.`);
  }

  const seen = new Set<string>();
  let units = 0;
  for (const stack of definition.cost) {
    if (!items.has(stack.itemId)) {
      throw new Error(`TechnologyRegistry: ${where} costs "${stack.itemId}", which is not an item.`);
    }
    if (items.get(stack.itemId).category !== 'science') {
      throw new Error(`TechnologyRegistry: ${where} costs "${stack.itemId}", which is not a science item.`);
    }
    if (!Number.isInteger(stack.count) || stack.count < 1) {
      throw new Error(`TechnologyRegistry: ${where} costs ${stack.count} of "${stack.itemId}"; it must be whole and above 0.`);
    }
    if (seen.has(stack.itemId)) {
      throw new Error(`TechnologyRegistry: ${where} lists "${stack.itemId}" twice; fold it into one entry.`);
    }
    seen.add(stack.itemId);
    if (units === 0) units = stack.count;
    else if (units !== stack.count) {
      // See the header: one unit takes one of each, so the counts *are* the
      // unit total and two different ones would name two different totals.
      throw new Error(
        `TechnologyRegistry: ${where} costs ${units} of one item and ${stack.count} of another; one unit takes one of each, so every count must match.`,
      );
    }
  }

  const prerequisites = new Set<string>();
  for (const id of definition.prerequisites) {
    if (id === definition.id) {
      throw new Error(`TechnologyRegistry: ${where} is its own prerequisite.`);
    }
    if (prerequisites.has(id)) {
      throw new Error(`TechnologyRegistry: ${where} lists "${id}" as a prerequisite twice.`);
    }
    prerequisites.add(id);
  }
}

export interface TechnologyRegistryOptions {
  /** Does a building with this id exist? `BuildingRegistry.has`. */
  readonly hasBuilding: (id: string) => boolean;
  /** Does a recipe with this id exist? `RecipeRegistry.has`. */
  readonly hasRecipe: (id: string) => boolean;
  /**
   * The recipe that produces this building's item, if any.
   *
   * Asked so that a **building** unlock and the recipe that makes its item
   * cannot be claimed by two different technologies — see `unlocks.ts`, which
   * grants them together.
   */
  readonly recipeForBuilding: (id: string) => string | null;
}

export class TechnologyRegistry {
  /** Content order, which is the order the panel and the view models follow. */
  private readonly technologies: readonly Technology[];

  private readonly byStringId = new Map<string, Technology>();

  /**
   * `"<kind>:<id>"` -> the technology that grants it, including the recipes a
   * building unlock carries with it (`unlocks.ts`).
   *
   * Built by the same walk that refuses two claims on one thing, because they
   * are the same fact: "which technology unlocks this" has exactly one answer,
   * and the build menu prints it beside a locked row. Read by key only, never
   * iterated, so its insertion order reaches no decision (§6 R4).
   */
  private readonly claimedBy = new Map<string, Technology>();

  constructor(
    definitions: readonly TechnologyDefinition[],
    items: ItemRegistry,
    options: TechnologyRegistryOptions,
  ) {
    const built: Technology[] = [];
    // Two passes over prerequisites: names are resolved in the first, because
    // a technology may name one declared after it, and the tiers and the cycle
    // check need the whole graph before either can be answered.
    const indexById = new Map<string, number>();
    for (const definition of definitions) {
      validate(definition, items);
      if (indexById.has(definition.id)) {
        throw new Error(`TechnologyRegistry: two technologies share the id "${definition.id}".`);
      }
      indexById.set(definition.id, indexById.size);
    }

    const claimed = new Map<string, string>();
    const prerequisiteIds: TechnologyId[][] = [];
    for (const definition of definitions) {
      const prerequisites: TechnologyId[] = [];
      for (const id of definition.prerequisites) {
        const index = indexById.get(id);
        if (index === undefined) {
          throw new Error(`TechnologyRegistry: technology "${definition.id}" requires "${id}", which does not exist.`);
        }
        prerequisites.push(index);
      }
      prerequisiteIds.push(prerequisites);
      checkUnlocks(definition, options, claimed);
    }


    const tiers = computeTiers(definitions, prerequisiteIds);

    definitions.forEach((definition, index) => {
      const first = definition.cost[0];
      const technology: Technology = Object.freeze({
        technologyId: index,
        id: definition.id,
        name: definition.name,
        summary: definition.summary,
        prerequisites: Object.freeze(prerequisiteIds[index] ?? []),
        cost: Object.freeze(
          definition.cost.map((stack) => Object.freeze({ itemId: items.idOf(stack.itemId), count: stack.count })),
        ),
        units: first?.count ?? 0,
        durationTicks: durationTicks(definition),
        unlocks: Object.freeze(definition.unlocks.map((unlock) => Object.freeze({ ...unlock }))),
        tier: tiers[index] ?? 0,
      });
      built.push(technology);
      this.byStringId.set(technology.id, technology);
      // The claim walk above recorded *which id* owns each grant; this turns
      // that into the technology object the menu wants, now that it exists.
      for (const [key, owner] of claimed) {
        if (owner === technology.id) this.claimedBy.set(key, technology);
      }
    });

    this.technologies = Object.freeze(built);
  }

  /** Every technology, in content order. What the panel and the views follow. */
  all(): readonly Technology[] {
    return this.technologies;
  }

  get size(): number {
    return this.technologies.length;
  }

  has(stringId: string): boolean {
    return this.byStringId.has(stringId);
  }

  /** A technology by string id. Throws on an unknown one, like every registry. */
  get(stringId: string): Technology {
    const technology = this.byStringId.get(stringId);
    if (technology === undefined) {
      throw new Error(`TechnologyRegistry: no technology with id "${stringId}".`);
    }
    return technology;
  }

  byId(technologyId: TechnologyId): Technology {
    const technology = this.technologies[technologyId];
    if (technology === undefined) {
      throw new Error(`TechnologyRegistry: no technology has runtime id ${technologyId}.`);
    }
    return technology;
  }

  /**
   * The technology that unlocks a building or a recipe, or null for something
   * available from the start.
   *
   * The build menu's "with their unlocking technology named" (C22 task 5). A
   * building's own recipe answers with the technology that grants the
   * building, because that is what the player has to research to get it.
   */
  unlockedBy(kind: Unlock['kind'], id: string): Technology | null {
    return this.claimedBy.get(`${kind}:${id}`) ?? null;
  }

  /** True for a real technology's id. False for `NO_TECHNOLOGY` and stale values. */
  isTechnologyId(value: number): value is TechnologyId {
    return Number.isInteger(value) && value >= 0 && value < this.technologies.length;
  }
}

/**
 * Every unlock names something that exists, and nothing is claimed twice.
 *
 * `claimed` is threaded through the whole table rather than being per
 * technology, because the mistake worth catching is two *different*
 * technologies granting the same building — which would leave the build menu
 * with two answers to "what unlocks this" and the player with a technology
 * whose reward they already had.
 */
function checkUnlocks(
  definition: TechnologyDefinition,
  options: TechnologyRegistryOptions,
  claimed: Map<string, string>,
): void {
  const where = `technology "${definition.id}"`;
  for (const unlock of definition.unlocks) {
    const exists = unlock.kind === 'building' ? options.hasBuilding(unlock.id) : options.hasRecipe(unlock.id);
    if (!exists) {
      throw new Error(`TechnologyRegistry: ${where} unlocks the ${unlock.kind} "${unlock.id}", which does not exist.`);
    }
    const key = `${unlock.kind}:${unlock.id}`;
    const owner = claimed.get(key);
    if (owner !== undefined) {
      throw new Error(`TechnologyRegistry: ${where} and "${owner}" both unlock the ${unlock.kind} "${unlock.id}".`);
    }
    claimed.set(key, definition.id);

    if (unlock.kind !== 'building') continue;
    // A building unlock carries the recipe that makes its item with it
    // (`unlocks.ts`), so that recipe is claimed here too — which is what makes
    // a technology that *also* named it a content error rather than a
    // harmless duplicate.
    const recipe = options.recipeForBuilding(unlock.id);
    if (recipe === null) continue;
    const recipeKey = `recipe:${recipe}`;
    const recipeOwner = claimed.get(recipeKey);
    if (recipeOwner !== undefined) {
      throw new Error(
        `TechnologyRegistry: ${where} unlocks "${unlock.id}", whose recipe "${recipe}" is already unlocked by "${recipeOwner}".`,
      );
    }
    claimed.set(recipeKey, definition.id);
  }
}

/**
 * The longest path from a root, per technology, and the cycle check.
 *
 * One walk answers both: a depth-first search that meets a node already on its
 * own stack has found a cycle, and the depth it returns with is the tier. The
 * memo makes it linear in the graph rather than in its paths.
 */
function computeTiers(
  definitions: readonly TechnologyDefinition[],
  prerequisites: readonly (readonly TechnologyId[])[],
): number[] {
  const tiers: number[] = new Array<number>(definitions.length).fill(-1);
  const onStack = new Array<boolean>(definitions.length).fill(false);

  const visit = (index: number, trail: readonly string[]): number => {
    const known = tiers[index];
    if (known !== undefined && known >= 0) return known;
    if (onStack[index] === true) {
      const id = definitions[index]?.id ?? String(index);
      throw new Error(`TechnologyRegistry: the prerequisites of "${id}" form a cycle: ${[...trail, id].join(' -> ')}.`);
    }
    onStack[index] = true;

    let tier = 0;
    const id = definitions[index]?.id ?? String(index);
    for (const prerequisite of prerequisites[index] ?? []) {
      tier = Math.max(tier, visit(prerequisite, [...trail, id]) + 1);
    }

    onStack[index] = false;
    tiers[index] = tier;
    return tier;
  };

  for (let index = 0; index < definitions.length; index++) visit(index, []);
  return tiers;
}
