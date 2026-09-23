import { describe, expect, it } from 'vitest';

import { ITEMS } from '../../src/game/data/items.js';
import { RECIPES } from '../../src/game/data/recipes.js';
import { HAND_CRAFTING_SPEED } from '../../src/game/registries/craft-durations.js';
import { ItemRegistry } from '../../src/game/registries/item-registry.js';
import { RecipeRegistry } from '../../src/game/registries/recipe-registry.js';
import { MAX_CRAFT_ORDERS } from '../../src/game/player/player-state.js';
import { Simulation } from '../../src/game/simulation.js';
import { World } from '../../src/game/world/world.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * Hand-crafting. See ironflow.md C21A and §15.
 *
 * This is the system C20 named as the fix for its one weak acceptance answer,
 * so what these tests hold is the bargain it makes with the player's bag:
 *
 * ```text
 * queue    the ingredients leave now, and the order will finish
 * tick     exactly `handTicksFor` ticks, then the product appears
 * cancel   everything comes back, including the one in progress
 * full     a finished craft waits rather than evaporating, and says so once
 * ```
 *
 * Every timing assertion is an exact tick count, not a tolerance: the duration
 * is rounded once at startup (§6 R3) and the simulation counts integers, so
 * "four seconds" is 120 ticks and a test that allowed 119 would be hiding the
 * off-by-one it exists to find.
 */

function newGame(): Simulation {
  return new Simulation({ world: new World(createPlaygroundGenerator()) });
}

/** Give the player `count` of `itemId`, by the string id content names it with. */
function give(simulation: Simulation, itemId: string, count: number): void {
  simulation.player.inventory.add(simulation.items.idOf(itemId), count);
}

function held(simulation: Simulation, itemId: string): number {
  return simulation.player.inventory.count(simulation.items.idOf(itemId));
}

/**
 * Queue a craft and run the tick that applies it.
 *
 * That tick is worth **one tick of progress**, and every count below allows
 * for it: the command is applied in phase 1 and the crafting system runs in
 * phase 8 of the same tick, which is the arrangement that lets a miner placed
 * this frame mine on the tick it was built (§8).
 */
function craft(simulation: Simulation, recipeId: string, count = 1): void {
  simulation.commands.enqueue({ type: 'craftItem', recipeId, count });
  simulation.tick();
}

/** Why the last command was refused, or null if it was not. */
function lastRejection(simulation: Simulation): string | null {
  const rejections = simulation.commands.takeRejections();
  return rejections[rejections.length - 1]?.reason ?? null;
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

describe('queueing a craft', () => {
  it('takes the whole order’s ingredients at once', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 10);

    craft(simulation, 'make_gear', 3);

    // 3 gears at 2 plates each. The plates are gone the moment the order is
    // queued, not as each gear comes up — see the system's file header.
    expect(held(simulation, 'iron_plate')).toBe(4);
    expect(simulation.player.crafts).toHaveLength(1);
    expect(simulation.player.crafts[0]?.remaining).toBe(3);
  });

  it('refuses an order the bag cannot pay for, and takes nothing', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 3);

    craft(simulation, 'make_gear', 2);

    expect(lastRejection(simulation)).toBe('unaffordable');
    expect(held(simulation, 'iron_plate')).toBe(3);
    expect(simulation.player.crafts).toHaveLength(0);
  });

  it('refuses a recipe the content table says needs a machine', () => {
    // Every shipped crafting recipe is hand-craftable since C31, so the
    // machine-only row this guards is a later chunk's; one is made up here,
    // on the same items, with the flag left off.
    const items = new ItemRegistry(ITEMS);
    const recipes = new RecipeRegistry(
      [
        ...RECIPES,
        {
          id: 'make_machine_only',
          inputs: [{ itemId: 'gear', count: 1 }],
          outputs: [{ itemId: 'circuit', count: 1 }],
          seconds: 1,
          category: 'crafting',
        },
      ],
      items,
    );
    const simulation = new Simulation({ world: new World(createPlaygroundGenerator()), items, recipes });
    give(simulation, 'gear', 20);

    craft(simulation, 'make_machine_only', 1);

    expect(lastRejection(simulation)).toBe('not_craftable');
    expect(simulation.player.crafts).toHaveLength(0);
  });

  it('refuses smelting outright — that is what a furnace is for', () => {
    const simulation = newGame();
    give(simulation, 'iron_ore', 10);

    craft(simulation, 'smelt_iron', 1);

    expect(lastRejection(simulation)).toBe('not_craftable');
  });

  it('refuses a recipe id nothing answers to', () => {
    const simulation = newGame();
    craft(simulation, 'make_spaceship', 1);
    expect(lastRejection(simulation)).toBe('unknown_recipe');
  });

  it('merges repeated clicks into one order rather than a queue of ones', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 10);

    craft(simulation, 'make_gear', 1);
    craft(simulation, 'make_gear', 1);
    craft(simulation, 'make_gear', 1);

    expect(simulation.player.crafts).toHaveLength(1);
    // Two ticks of the head order's progress have been spent by the two ticks
    // that followed the first command; what matters is that it is one order.
    expect(simulation.player.crafts[0]?.remaining).toBe(3);
  });

  it('caps the queue at MAX_CRAFT_ORDERS distinct orders', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 500);
    give(simulation, 'copper_plate', 500);

    // Two recipes, alternated, so nothing merges into the tail.
    for (let i = 0; i < MAX_CRAFT_ORDERS; i++) {
      craft(simulation, i % 2 === 0 ? 'make_gear' : 'make_wire', 1);
    }
    expect(simulation.player.crafts.length).toBe(MAX_CRAFT_ORDERS);

    craft(simulation, 'make_gear', 1);
    expect(lastRejection(simulation)).toBe('craft_queue_full');
    expect(simulation.player.crafts.length).toBe(MAX_CRAFT_ORDERS);
  });
});

describe('crafting takes exactly the time the table says', () => {
  it('delivers one gear after its whole duration and not a tick before', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 2);

    const duration = simulation.crafts.handTicksFor(simulation.recipes.get('make_gear').recipeId);
    // §15 authors `make_gear` at 1.0 s = 30 ticks; by hand at speed 0.5 that
    // is 60. Derived from the content table rather than written down, so a
    // retune moves this test's expectation with it.
    expect(duration).toBe(Math.round(simulation.recipes.get('make_gear').durationTicks / HAND_CRAFTING_SPEED));

    // One tick of progress came with the command's own tick, so this leaves
    // the order one tick short of done.
    craft(simulation, 'make_gear', 1);
    run(simulation, duration - 2);
    expect(simulation.player.crafts[0]?.progressTicks).toBe(duration - 1);
    expect(held(simulation, 'gear')).toBe(0);

    simulation.tick();
    expect(held(simulation, 'gear')).toBe(1);
    expect(simulation.player.crafts).toHaveLength(0);
  });

  it('runs a batch back to back, one item per duration', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 6);

    const duration = simulation.crafts.handTicksFor(simulation.recipes.get('make_gear').recipeId);
    craft(simulation, 'make_gear', 3);

    run(simulation, duration);
    expect(held(simulation, 'gear')).toBe(1);
    run(simulation, duration);
    expect(held(simulation, 'gear')).toBe(2);
    run(simulation, duration);
    expect(held(simulation, 'gear')).toBe(3);
    expect(simulation.player.crafts).toHaveLength(0);
  });

  it('delivers both belts of the one recipe that makes two', () => {
    const simulation = newGame();
    give(simulation, 'gear', 1);
    give(simulation, 'iron_plate', 1);

    const duration = simulation.crafts.handTicksFor(simulation.recipes.get('make_belt').recipeId);
    craft(simulation, 'make_belt', 1);
    run(simulation, duration);

    expect(held(simulation, 'belt')).toBe(2);
  });

  it('works on one order at a time, in queue order', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 4);
    give(simulation, 'copper_plate', 4);

    const gear = simulation.crafts.handTicksFor(simulation.recipes.get('make_gear').recipeId);
    craft(simulation, 'make_gear', 1);
    craft(simulation, 'make_wire', 1);

    run(simulation, gear);
    expect(held(simulation, 'gear')).toBe(1);
    // The wire is only now at the head, with a couple of ticks on it — it was
    // not being made alongside the gear. A second pair of hands is what an
    // assembler is.
    expect(held(simulation, 'copper_wire')).toBe(0);
    expect(simulation.player.crafts).toHaveLength(1);
    expect(simulation.player.crafts[0]?.recipe).toBe(simulation.recipes.get('make_wire').recipeId);
  });
});

describe('cancelling', () => {
  it('gives back everything, including the craft in progress', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 6);

    craft(simulation, 'make_gear', 3);
    run(simulation, 10);
    expect(held(simulation, 'iron_plate')).toBe(0);

    simulation.commands.enqueue({ type: 'cancelCraft', index: 0 });
    simulation.tick();

    expect(held(simulation, 'iron_plate')).toBe(6);
    expect(simulation.player.crafts).toHaveLength(0);
  });

  it('refuses rather than voiding items when the refund will not fit', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 2);
    craft(simulation, 'make_gear', 1);

    // Fill every slot with something else, so the two plates have nowhere to
    // land. `coal` stacks in 50s and the bag is 30 slots.
    const coal = simulation.items.idOf('coal');
    simulation.player.inventory.add(coal, simulation.player.inventory.spaceFor(coal));
    expect(simulation.player.inventory.freeSlots).toBe(0);

    simulation.commands.enqueue({ type: 'cancelCraft', index: 0 });
    simulation.tick();

    expect(lastRejection(simulation)).toBe('inventory_full');
    expect(simulation.player.crafts).toHaveLength(1);
  });

  it('says so when there is nothing at that index', () => {
    const simulation = newGame();
    simulation.commands.enqueue({ type: 'cancelCraft', index: 2 });
    simulation.tick();
    expect(lastRejection(simulation)).toBe('nothing_queued');
  });
});

describe('a finished craft with nowhere to go', () => {
  it('waits at its finish line, warns once, and lands when room appears', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 2);
    craft(simulation, 'make_gear', 1);

    const coal = simulation.items.idOf('coal');
    simulation.player.inventory.add(coal, simulation.player.inventory.spaceFor(coal));
    expect(simulation.player.inventory.freeSlots).toBe(0);

    const duration = simulation.crafts.handTicksFor(simulation.recipes.get('make_gear').recipeId);
    run(simulation, duration + 30);

    // Parked, not lost: the order is still there and its progress is full.
    const order = simulation.player.crafts[0];
    expect(order?.remaining).toBe(1);
    expect(order?.progressTicks).toBe(duration);
    expect(held(simulation, 'gear')).toBe(0);

    // One alert for the whole stall, not one a tick (C11's rule).
    const alerts = simulation.alerts.take().filter((alert) => alert.type === 'craft_blocked');
    expect(alerts).toHaveLength(1);

    // Make room, and the gear appears on the next tick.
    simulation.player.inventory.remove(coal, 50);
    simulation.tick();
    expect(held(simulation, 'gear')).toBe(1);
    expect(simulation.player.crafts).toHaveLength(0);
  });
});

describe('the queue is authoritative state', () => {
  it('serializes with the player, head first', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 4);
    give(simulation, 'copper_plate', 4);
    craft(simulation, 'make_gear', 2);
    craft(simulation, 'make_wire', 1);
    run(simulation, 5);

    const serialized = simulation.player.toJSON();
    expect(serialized.crafts).toHaveLength(2);
    expect(serialized.crafts[0]?.recipe).toBe(simulation.recipes.get('make_gear').recipeId);
    expect(serialized.crafts[0]?.progressTicks).toBeGreaterThan(0);
    expect(serialized.crafts[1]?.recipe).toBe(simulation.recipes.get('make_wire').recipeId);
    expect(serialized.crafts[1]?.progressTicks).toBe(0);
  });

  it('hands out a copy, so nothing can edit the queue through a snapshot', () => {
    const simulation = newGame();
    give(simulation, 'iron_plate', 2);
    craft(simulation, 'make_gear', 1);

    const order = simulation.player.toJSON().crafts[0];
    expect(order).toBeDefined();
    if (order !== undefined) order.remaining = 99;
    expect(simulation.player.crafts[0]?.remaining).toBe(1);
  });
});

describe('what §15 says can be made by hand', () => {
  it('is every crafting recipe (C31), and no smelting one', () => {
    // C21A shipped eight rows. C31 took away the starting kit, and with it
    // the only other source of an assembler, a lab or a generator, so every
    // crafting row is flagged now. See the plan's C31.
    const simulation = newGame();
    expect(simulation.recipes.handCraftable().map((recipe) => recipe.id)).toEqual(
      simulation.recipes.byCategory('crafting').map((recipe) => recipe.id),
    );
  });

  it('starts with a furnace made of stone, which the hands can mine', () => {
    const simulation = newGame();
    const furnace = simulation.recipes.get('make_furnace');
    expect(furnace.handCraftable).toBe(true);
    expect(furnace.inputs).toEqual([{ itemId: simulation.items.idOf('stone'), count: 10 }]);
  });

  it('never includes a smelting recipe, whatever the content table says', () => {
    const simulation = newGame();
    for (const recipe of simulation.recipes.handCraftable()) {
      expect(recipe.category, recipe.id).toBe('crafting');
    }
  });

  it('is exactly the set with a hand duration', () => {
    const simulation = newGame();
    for (const recipe of simulation.recipes.all()) {
      const ticks = simulation.crafts.handTicksFor(recipe.recipeId);
      expect(ticks > 0, recipe.id).toBe(recipe.handCraftable);
    }
  });
});
