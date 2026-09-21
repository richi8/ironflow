import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { TECHNOLOGIES } from '../../src/game/data/technologies.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';
import {
  NO_TECHNOLOGY,
  TechnologyRegistry,
  type TechnologyDefinition,
} from '../../src/game/registries/technology-registry.js';
import { recipeForBuilding } from '../../src/game/research/unlocks.js';
import { TPS } from '../../src/game/simulation-clock.js';

/**
 * The technology table. See ironflow.md C22 task 1 and §15.
 *
 * C22's test line asks for "prerequisite graph validation (no cycles, no
 * dangling ids — assert at registry build)", and what is protected here is
 * wider than that: every check below is a content mistake whose symptom, if it
 * reached a running game, would be a *quietly unwinnable* factory — a
 * technology nobody can start, a reward that never arrives, a build menu with
 * two answers to "what unlocks this". None of those throws anywhere near where
 * it was caused, which is exactly why the registry refuses them at build.
 */

const items = new ItemRegistry(ITEMS);
const recipes = new RecipeRegistry(RECIPES, items);
const buildings = new BuildingRegistry(BUILDINGS);

const options = {
  hasBuilding: (id: string) => buildings.has(id),
  hasRecipe: (id: string) => recipes.has(id),
  recipeForBuilding: (id: string) => recipeForBuilding({ buildings, recipes, items }, id)?.id ?? null,
};

function registry(...definitions: TechnologyDefinition[]): TechnologyRegistry {
  return new TechnologyRegistry(definitions, items, options);
}

/** A minimal valid technology, to be spread and broken one field at a time. */
const NODE: TechnologyDefinition = Object.freeze({
  id: 'node',
  name: 'Node',
  summary: 'A technology.',
  prerequisites: [],
  cost: [{ itemId: 'data_core', count: 4 }],
  seconds: 5,
  unlocks: [{ kind: 'recipe', id: 'smelt_steel' }],
} satisfies TechnologyDefinition);

describe('TechnologyRegistry', () => {
  it('resolves ids, costs and durations once, in content order', () => {
    const built = registry(NODE, {
      ...NODE,
      id: 'second',
      prerequisites: ['node'],
      unlocks: [{ kind: 'building', id: 'splitter' }],
    });

    const node = built.get('node');
    expect(node.technologyId).toBe(0);
    expect(built.byId(0)).toBe(node);
    // §6 R3: the seconds are authored and the ticks are what the simulation
    // counts, converted exactly once here.
    expect(node.durationTicks).toBe(5 * TPS);
    // The count in the bill *is* the unit total — one unit takes one of each.
    expect(node.units).toBe(4);
    expect(node.cost[0]?.itemId).toBe(items.idOf('data_core'));

    expect(built.get('second').prerequisites).toEqual([node.technologyId]);
    expect(built.all().map((technology) => technology.id)).toEqual(['node', 'second']);
  });

  it('gives each technology the longest path from a root as its tier', () => {
    // A diamond: `late` can be reached in one hop and in two, and the panel
    // must draw it below the longer of the two so its prerequisites are
    // always in a row above it.
    const built = registry(
      { ...NODE, id: 'root' },
      { ...NODE, id: 'middle', prerequisites: ['root'], unlocks: [{ kind: 'building', id: 'splitter' }] },
      {
        ...NODE,
        id: 'late',
        prerequisites: ['root', 'middle'],
        unlocks: [{ kind: 'building', id: 'lab' }],
      },
    );

    expect(built.get('root').tier).toBe(0);
    expect(built.get('middle').tier).toBe(1);
    expect(built.get('late').tier).toBe(2);
  });

  it('answers what unlocks a thing, including a building’s own recipe', () => {
    const built = registry({ ...NODE, unlocks: [{ kind: 'building', id: 'splitter' }] });

    expect(built.unlockedBy('building', 'splitter')?.id).toBe('node');
    // The recipe comes with the building (`unlocks.ts`), so the same
    // technology is the answer for both — which is what lets the build menu
    // and the craft picker agree about a locked row.
    expect(built.unlockedBy('recipe', 'make_splitter')?.id).toBe('node');
    // Start content: nothing claims it, so nothing unlocks it.
    expect(built.unlockedBy('building', 'chest')).toBeNull();
  });

  it.each([
    [
      'a dangling prerequisite',
      [{ ...NODE, prerequisites: ['nowhere'] }],
      /requires "nowhere", which does not exist/,
    ],
    ['a self-prerequisite', [{ ...NODE, prerequisites: ['node'] }], /its own prerequisite/],
    [
      'a cycle',
      [
        { ...NODE, id: 'a', prerequisites: ['b'] },
        { ...NODE, id: 'b', prerequisites: ['a'], unlocks: [{ kind: 'building' as const, id: 'splitter' }] },
      ],
      /form a cycle/,
    ],
    ['a duplicate id', [NODE, { ...NODE }], /two technologies share the id/],
    [
      'an unlock that does not exist',
      [{ ...NODE, unlocks: [{ kind: 'building' as const, id: 'teleporter' }] }],
      /unlocks the building "teleporter", which does not exist/,
    ],
    [
      'two claims on one unlock',
      [NODE, { ...NODE, id: 'other' }],
      /both unlock the recipe "smelt_steel"/,
    ],
    [
      'a recipe claimed after the building it belongs to',
      [
        { ...NODE, unlocks: [{ kind: 'building' as const, id: 'splitter' }] },
        { ...NODE, id: 'other', unlocks: [{ kind: 'recipe' as const, id: 'make_splitter' }] },
      ],
      /both unlock the recipe "make_splitter"/,
    ],
    [
      'a recipe claimed before the building it belongs to',
      [
        { ...NODE, unlocks: [{ kind: 'recipe' as const, id: 'make_splitter' }] },
        { ...NODE, id: 'other', unlocks: [{ kind: 'building' as const, id: 'splitter' }] },
      ],
      /whose recipe "make_splitter" is already unlocked by/,
    ],
    ['no unlocks at all', [{ ...NODE, unlocks: [] }], /unlocks nothing/],
    ['no cost', [{ ...NODE, cost: [] }], /costs nothing/],
    [
      'a cost that is not a science item',
      [{ ...NODE, cost: [{ itemId: 'iron_plate', count: 4 }] }],
      /is not a science item/,
    ],
    [
      'a cost of an item that does not exist',
      [{ ...NODE, cost: [{ itemId: 'wisdom', count: 4 }] }],
      /which is not an item/,
    ],
    [
      'the same science item listed twice',
      [
        {
          ...NODE,
          cost: [
            { itemId: 'data_core', count: 4 },
            { itemId: 'data_core', count: 4 },
          ],
        },
      ],
      /lists "data_core" twice/,
    ],
    ['a zero duration', [{ ...NODE, seconds: 0 }], /which is not a duration/],
    ['a duration under one tick', [{ ...NODE, seconds: 0.001 }], /under one tick/],
    ['no summary', [{ ...NODE, summary: '' }], /has no summary/],
  ])('refuses %s', (_label, definitions, message) => {
    expect(() => registry(...(definitions as TechnologyDefinition[]))).toThrow(message);
  });

  /**
   * The rule that makes a cost and a duration one number: a unit takes one of
   * each item in the bill, so every count in it is the same count — the unit
   * total. A bill of 10 of one pack and 20 of another would run out of the
   * first halfway through and stall with nothing to call the stall (§13).
   *
   * v1 has one science item, so this needs a second one to be asked at all —
   * which is the point of asking it now rather than when the second one lands.
   */
  it('refuses a bill whose counts disagree, because a count is a unit total', () => {
    const twoSciences = new ItemRegistry([
      ...ITEMS,
      { id: 'logic_core', name: 'Logic Core', stackSize: 200, sprite: 'item:logic_core', category: 'science' },
    ]);
    const build = (counts: readonly [number, number]): TechnologyRegistry =>
      new TechnologyRegistry(
        [
          {
            ...NODE,
            cost: [
              { itemId: 'data_core', count: counts[0] },
              { itemId: 'logic_core', count: counts[1] },
            ],
          },
        ],
        twoSciences,
        options,
      );

    expect(() => build([4, 6])).toThrow(/every count must match/);
    expect(build([4, 4]).get('node').units).toBe(4);
  });

  it('reserves NO_TECHNOLOGY, so an empty queue is never a real technology', () => {
    const built = registry(NODE);
    expect(built.isTechnologyId(NO_TECHNOLOGY)).toBe(false);
    expect(built.isTechnologyId(0)).toBe(true);
    expect(built.isTechnologyId(built.size)).toBe(false);
    expect(() => built.byId(NO_TECHNOLOGY)).toThrow(/no technology has runtime id/);
  });
});

describe('the shipped technology tree', () => {
  const built = new TechnologyRegistry(TECHNOLOGIES, items, options);

  /**
   * §15's tree as C22 revised it. See `data/technologies.ts` for why four of
   * §15's nine nodes could not survive contact with §15's building table, and
   * C22's deviations in the plan.
   */
  it('is the five nodes C22 ships, with §15’s costs', () => {
    expect(
      built.all().map((technology) => ({
        id: technology.id,
        units: technology.units,
        needs: technology.prerequisites.map((id) => built.byId(id).id),
        unlocks: technology.unlocks.map((unlock) => unlock.id),
      })),
    ).toEqual([
      { id: 'logistics_1', units: 10, needs: [], unlocks: ['splitter'] },
      { id: 'smelting_2', units: 20, needs: ['logistics_1'], unlocks: ['smelt_steel'] },
      { id: 'power_1', units: 40, needs: ['smelting_2'], unlocks: ['electric_furnace'] },
      { id: 'mining_2', units: 60, needs: ['power_1'], unlocks: ['miner_2'] },
      { id: 'construction_1', units: 100, needs: ['mining_2'], unlocks: ['make_frame', 'assembler_2'] },
    ]);
  });

  it('takes five seconds a unit everywhere, which is what makes one assembler feed one lab', () => {
    for (const technology of built.all()) {
      expect(technology.durationTicks, technology.id).toBe(5 * TPS);
    }
    // §15's derived ratio, stated from both ends: `make_data_core` is 2.5 s,
    // a tier-1 assembler runs at speed 0.5, so a core takes 150 ticks — and a
    // research unit takes exactly as long to spend it.
    const core = recipes.get('make_data_core');
    expect((core.durationTicks / 0.5) * 1).toBe(built.get('logistics_1').durationTicks);
  });

  it('is reachable end to end: every node’s prerequisites lead back to a root', () => {
    // The registry's cycle check proves there is no loop; this proves there is
    // a way *in*. A tree of five nodes with no root would be a tech tree the
    // player could look at and never start.
    expect(built.all().filter((technology) => technology.prerequisites.length === 0)).not.toHaveLength(0);
    for (const technology of built.all()) {
      expect(technology.tier, technology.id).toBeLessThan(built.size);
    }
  });

  it('costs data cores and nothing else, so research is paid for in science', () => {
    for (const technology of built.all()) {
      expect(technology.cost.map((line) => items.byId(line.itemId).id), technology.id).toEqual(['data_core']);
    }
  });
});
