import { describe, expect, it } from 'vitest';

import { DetachedCursor, GameController, MAX_QUEST_LOG } from '../../src/game/game-controller.js';
import { Game } from '../../src/game/game.js';
import { v5ToV6 } from '../../src/game/save/migrations/v5-to-v6.js';
import { Simulation } from '../../src/game/simulation.js';
import type { ObjectiveGoal } from '../../src/game/views/objective-view.js';
import { EAST, NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { OBJECTIVES, isLineShown, objectivesView } from '../../src/ui/objectives.js';
import { FakeScheduler } from '../fixtures/fake-scheduler.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * C31: the quest chain, and the two goal kinds it added.
 *
 * The chain is content — words in `ui/objectives.ts` — so most of what can go
 * wrong with it is a step that names something the game does not have, a
 * building or technology no step reaches, or a step that asks for something
 * research has not revealed yet. Each of those is a check here rather than a
 * playtest finding.
 */

function makeController(quests: readonly string[] | null = null): {
  controller: GameController;
  simulation: Simulation;
} {
  const simulation = new Simulation({ world: new World(createPlaygroundGenerator()) });
  const game = new Game({ simulation, scheduler: new FakeScheduler(), render: () => {} });
  const controller = new GameController({ game, cursor: new DetachedCursor(), quests });
  return { controller, simulation };
}

function face(simulation: Simulation, x: number, y: number, facing: Rotation): void {
  simulation.player.setTilePosition(x, y);
  simulation.player.facing = facing;
}

/** The building a goal is about, if it is about one. */
function buildingOf(goal: ObjectiveGoal): string | null {
  return goal.kind === 'built' || goal.kind === 'running' ? goal.buildingId : null;
}

describe('the quest chain (C31)', () => {
  it('names only content that exists, so every step can be finished', () => {
    const { simulation } = makeController();
    for (const step of OBJECTIVES) {
      const goal = step.goal;
      let known: boolean;
      switch (goal.kind) {
        case 'carried':
        case 'stored':
          known = simulation.items.has(goal.itemId);
          break;
        case 'built':
          known = simulation.buildings.has(goal.buildingId);
          break;
        case 'running':
          known =
            simulation.buildings.has(goal.buildingId) &&
            (goal.recipeId === undefined || simulation.recipes.has(goal.recipeId));
          break;
        case 'researched':
          known = simulation.technologies.has(goal.technologyId);
          break;
      }
      expect(known, step.id).toBe(true);
      expect(step.target, step.id).toBeGreaterThan(0);
      expect(step.hint.length, step.id).toBeGreaterThan(0);
    }
    expect(new Set(OBJECTIVES.map((step) => step.id)).size).toBe(OBJECTIVES.length);
  });

  it('starts at the first ore mined by hand', () => {
    expect(OBJECTIVES[0]?.goal).toEqual({ kind: 'carried', itemId: 'iron_ore' });
  });

  it('reaches every building and every technology the game has', () => {
    const { simulation } = makeController();
    const buildings = new Set(OBJECTIVES.map((step) => buildingOf(step.goal)));
    for (const definition of simulation.buildings.all()) {
      expect(buildings.has(definition.id), `no step uses ${definition.id}`).toBe(true);
    }
    const researched = new Set(
      OBJECTIVES.map((step) => (step.goal.kind === 'researched' ? step.goal.technologyId : null)),
    );
    for (const technology of simulation.technologies.all()) {
      expect(researched.has(technology.id), `no step researches ${technology.id}`).toBe(true);
    }
  });

  it('never asks for a locked thing before the step that researches it', () => {
    const { simulation } = makeController();
    const researchedAt = new Map<string, number>();
    OBJECTIVES.forEach((step, index) => {
      if (step.goal.kind === 'researched') researchedAt.set(step.goal.technologyId, index);
    });
    // Everything a technology unlocks, and the prerequisites before it.
    const lockedBy = new Map<string, string>();
    for (const technology of simulation.technologies.all()) {
      for (const unlock of technology.unlocks) lockedBy.set(unlock.id, technology.id);
      for (const prerequisite of technology.prerequisites) {
        const own = researchedAt.get(technology.id) ?? -1;
        const before = researchedAt.get(simulation.technologies.byId(prerequisite).id) ?? Infinity;
        expect(before, `${technology.id} is asked for before its prerequisite`).toBeLessThan(own);
      }
    }
    OBJECTIVES.forEach((step, index) => {
      const goal = step.goal;
      const names = [buildingOf(goal), goal.kind === 'running' ? (goal.recipeId ?? null) : null];
      if (goal.kind === 'carried' || goal.kind === 'stored') {
        // An item is locked when the recipe that makes it is.
        for (const recipe of simulation.recipes.all()) {
          if (recipe.outputs.some((output) => simulation.items.byId(output.itemId).id === goal.itemId)) {
            names.push(recipe.id);
          }
        }
      }
      for (const name of names) {
        if (name === null) continue;
        const technology = lockedBy.get(name);
        if (technology === undefined) continue;
        expect(researchedAt.get(technology) ?? Infinity, `${step.id} needs ${technology} first`).toBeLessThan(index);
      }
    });
  });
});

describe('the goals C31 added', () => {
  it('counts a machine working, and only on the recipe asked about', () => {
    const { controller, simulation } = makeController();
    face(simulation, 4, 4, EAST);
    simulation.inventory.add('furnace', 1);
    simulation.inventory.add('coal', 5);
    simulation.inventory.add('iron_ore', 5);
    simulation.commands.enqueue({ type: 'build', buildingId: 'furnace', x: 5, y: 4, rotation: NORTH });
    simulation.tick();
    const furnace = simulation.entities.at(5, 4);
    if (furnace === undefined) throw new Error('no furnace');

    expect(controller.countObjective({ kind: 'running', buildingId: 'furnace' })).toBe(0);
    simulation.commands.enqueue({ type: 'insertItems', entityId: furnace.id, itemId: 'coal', amount: 5 });
    simulation.commands.enqueue({ type: 'insertItems', entityId: furnace.id, itemId: 'iron_ore', amount: 5 });
    for (let i = 0; i < 5; i++) simulation.tick();

    expect(controller.countObjective({ kind: 'running', buildingId: 'furnace' })).toBe(1);
    expect(controller.countObjective({ kind: 'running', buildingId: 'furnace', recipeId: 'smelt_iron' })).toBe(1);
    expect(controller.countObjective({ kind: 'running', buildingId: 'furnace', recipeId: 'bake_brick' })).toBe(0);
  });

  it('counts a technology once it is done', () => {
    const { controller, simulation } = makeController();
    const goal: ObjectiveGoal = { kind: 'researched', technologyId: 'logistics_1' };
    expect(controller.countObjective(goal)).toBe(0);
    simulation.research.complete(simulation.technologies.get('logistics_1').technologyId);
    expect(controller.countObjective(goal)).toBe(1);
  });

  it('counts nothing, rather than throwing, for an id content does not have', () => {
    const { controller } = makeController();
    expect(controller.countObjective({ kind: 'running', buildingId: 'castle' })).toBe(0);
    expect(controller.countObjective({ kind: 'running', buildingId: 'furnace', recipeId: 'make_gold' })).toBe(0);
    expect(controller.countObjective({ kind: 'researched', technologyId: 'teleportation' })).toBe(0);
  });
});

describe('the quest log (C31)', () => {
  it('starts from what the save said, and remembers each step once, in order', () => {
    const { controller } = makeController(['mine-iron']);
    controller.noteQuestDone('mine-stone');
    controller.noteQuestDone('mine-iron');
    expect(controller.getQuestLog()).toEqual(['mine-iron', 'mine-stone']);
  });

  it('is replaced whole by a loaded world, and emptied by a new one', () => {
    const { controller } = makeController(['mine-iron']);
    controller.setQuestLog(['mine-coal']);
    expect(controller.getQuestLog()).toEqual(['mine-coal']);
    controller.setQuestLog(null);
    expect(controller.getQuestLog()).toEqual([]);
  });

  it('is bounded, whatever an untrusted save hands it', () => {
    const { controller } = makeController(Array.from({ length: MAX_QUEST_LOG + 50 }, (_, i) => `step-${i}`));
    expect(controller.getQuestLog()).toHaveLength(MAX_QUEST_LOG);
  });

  it('is handed out as a copy', () => {
    const { controller } = makeController(['mine-iron']);
    expect(Object.isFrozen(controller.getQuestLog())).toBe(true);
  });
});

describe('one step at a time (C31)', () => {
  it('shows the step before the current one, the current one, and the next', () => {
    const shown = (current: number): number[] =>
      Array.from({ length: 10 }, (_, i) => i).filter((i) => isLineShown(i, current, 10));
    expect(shown(0)).toEqual([0, 1]);
    expect(shown(4)).toEqual([3, 4, 5]);
    // Finished: the current index is past the end, and the last three show.
    expect(shown(10)).toEqual([7, 8, 9]);
  });

  it('makes the first step not done the current one, and counts what is done', () => {
    const done = new Set(['mine-iron', 'mine-coal']);
    const view = objectivesView(OBJECTIVES, done, () => 0);
    expect(view.current).toBe(1);
    expect(view.doneCount).toBe(2);
    expect(view.hint).toBe(OBJECTIVES[1]?.hint);
  });

  it('asks the world only about steps still open', () => {
    const asked: ObjectiveGoal[] = [];
    const done = new Set(OBJECTIVES.slice(1).map((step) => step.id));
    objectivesView(OBJECTIVES, done, (goal) => {
      asked.push(goal);
      return 0;
    });
    expect(asked).toEqual([OBJECTIVES[0]?.goal]);
  });
});

describe('v5 -> v6: the quest log', () => {
  it('gives a v5 save an empty log and keeps everything else', () => {
    const v5 = {
      format: 'ironflow-save',
      version: 5,
      metadata: { name: 'old', thumbnail: null, hotbar: null },
      state: { tick: 5 },
    };
    expect(v5ToV6.migrate(v5)).toEqual({ ...v5, version: 6, metadata: { ...v5.metadata, quests: null } });
  });

  it('leaves a malformed metadata for the validator to refuse', () => {
    expect(v5ToV6.migrate({ version: 5, metadata: 'nope' })).toEqual({ version: 6, metadata: 'nope' });
  });
});
