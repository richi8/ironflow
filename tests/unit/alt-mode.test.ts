import { describe, expect, it } from 'vitest';

import { newChest, type ChestEntity } from '../../src/game/entities/chest-entity.js';
import { newBelt } from '../../src/game/entities/belt-entity.js';
import { EntityType } from '../../src/game/entities/entity-types.js';
import { newMachine } from '../../src/game/entities/machine-entity.js';
import { newMiner } from '../../src/game/entities/miner-entity.js';
import { newSplitter } from '../../src/game/entities/splitter-entity.js';
import { Simulation } from '../../src/game/simulation.js';
import { EAST, NORTH } from '../../src/game/world/coordinates.js';
import { CHUNK_AREA, createChunk } from '../../src/game/world/chunk.js';
import { ResourceType } from '../../src/game/world/resource.js';
import { World } from '../../src/game/world/world.js';
import { buildingSprite, describeAnnotations } from '../../src/renderer/entity-view.js';
import { spriteLift } from '../../src/renderer/sprite-atlas.js';

/**
 * The alt-mode overlay. See ironflow.md C20 task 5.
 *
 * > an "alt mode" overlay showing what each machine makes
 *
 * What is worth testing is the *selection*: which buildings get a badge, what
 * item the badge names, and — the one that a later chunk could break without
 * noticing — that belts do not, because a badge over every belt tile would
 * bury the machines the mode exists to label.
 *
 * The drawing is `OverlayLayer`'s and is not tested here for the reason no
 * sprite is drawn in any test: the procedural atlas has no canvas under it in
 * a Node run (C17's standing note).
 */

function world(): World {
  return new World((cx, cy) => {
    const chunk = createChunk(cx, cy);
    for (let i = 0; i < CHUNK_AREA; i++) {
      chunk.resource[i] = ResourceType.Iron;
      chunk.resourceAmount[i] = 1000;
    }
    return chunk;
  });
}

function annotate(simulation: Simulation): ReturnType<typeof describeAnnotations> {
  return describeAnnotations(simulation.entities, simulation.buildings, simulation.recipes, simulation.items);
}

describe('describeAnnotations', () => {
  it('names what a furnace is smelting and what an assembler was told to make', () => {
    const simulation = new Simulation({ world: world() });
    const furnace = newMachine(EntityType.Furnace, 0, 0, NORTH);
    furnace.recipe = simulation.recipes.get('smelt_copper').recipeId;
    simulation.entities.create(furnace);

    const assembler = newMachine(EntityType.Assembler, 4, 0, NORTH);
    assembler.recipe = simulation.recipes.get('make_belt').recipeId;
    simulation.entities.create(assembler);

    expect(annotate(simulation).map((a) => a.sprites)).toEqual([['item:copper_plate'], ['item:belt']]);
  });

  it('says nothing about a machine that has not been told what to make', () => {
    const simulation = new Simulation({ world: world() });
    simulation.entities.create(newMachine(EntityType.Assembler, 0, 0, NORTH));
    // The badge answers "what does this make", and the honest answer is that
    // there is not one yet. The *status* is what says so, in the panel and in
    // a toast — see `views/alert.ts`.
    expect(annotate(simulation)).toEqual([]);
  });

  it('names the ore under a miner', () => {
    const simulation = new Simulation({ world: world() });
    simulation.entities.create(newMiner(0, 0, NORTH));
    simulation.tick();

    expect(annotate(simulation)[0]?.sprites).toEqual(['item:iron_ore']);
  });

  it('names what a chest holds, most first', () => {
    const simulation = new Simulation({ world: world() });
    const chest = simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    // Gears in two stacks: the badge totals them.
    chest.contents = [
      [0, simulation.items.idOf('iron_plate'), 4],
      [1, simulation.items.idOf('gear'), 10],
      [5, simulation.items.idOf('gear'), 7],
    ];

    expect(annotate(simulation)[0]?.sprites).toEqual(['item:gear', 'item:iron_plate']);
  });

  it('names at most four of what a chest holds', () => {
    const simulation = new Simulation({ world: world() });
    const chest = simulation.entities.create<ChestEntity>(newChest(0, 0, NORTH));
    const names = ['iron_ore', 'copper_ore', 'coal', 'stone', 'iron_plate'];
    chest.contents = names.map((name, slot) => [slot, simulation.items.idOf(name), 10 - slot] as const);

    expect(annotate(simulation)[0]?.sprites).toEqual(['item:iron_ore', 'item:copper_ore', 'item:coal', 'item:stone']);
  });

  it('leaves belts and splitters out, because there are hundreds of them', () => {
    const simulation = new Simulation({ world: world() });
    simulation.entities.create(newBelt(0, 0, EAST));
    simulation.entities.create(newSplitter(4, 0, EAST));
    expect(annotate(simulation)).toEqual([]);
  });

  it('carries the footprint, so a badge sits over the whole machine', () => {
    const simulation = new Simulation({ world: world() });
    const assembler = newMachine(EntityType.Assembler, 2, 3, NORTH);
    assembler.recipe = simulation.recipes.get('make_gear').recipeId;
    simulation.entities.create(assembler);

    expect(annotate(simulation)[0]).toMatchObject({ x: 2, y: 3, width: 3, height: 3 });
  });

  /**
   * C27B gave machines height, and for one commit the badges were drawn at the
   * footprint's top edge — which is *inside* the sprite once it stands up, so
   * every badge landed across the machine's own two-letter code. The overlay
   * clears it by this number, and it has to be the machine's rather than the
   * badge item's: the badge is a picture of a gear, and the thing it must
   * clear is the assembler.
   */
  it('carries how far the machine it labels rises, so the badge clears it', () => {
    const simulation = new Simulation({ world: world() });
    const assembler = newMachine(EntityType.Assembler, 2, 3, NORTH);
    assembler.recipe = simulation.recipes.get('make_gear').recipeId;
    simulation.entities.create(assembler);

    const annotation = annotate(simulation)[0];
    const machine = buildingSprite(simulation.buildings.get('assembler'), NORTH);
    expect(annotation?.lift).toBe(spriteLift(machine));
    expect(annotation?.lift).toBeGreaterThan(0);
    // Not the badge's own sprite, which is a flat item and lifts nothing.
    expect(spriteLift(annotation?.sprites[0] ?? '')).toBe(0);
  });
});
