import { describe, expect, it } from 'vitest';

import type { Command, CommandRejectionReason } from '../../src/game/commands/command.js';
import { initialBuildingState } from '../../src/game/entities/building-init.js';
import type { Entity } from '../../src/game/entities/entity.js';
import { asGenerator } from '../../src/game/entities/generator-entity.js';
import { asLab, type LabEntity } from '../../src/game/entities/lab-entity.js';
import { MachineStatus } from '../../src/game/entities/machine-status.js';
import { BuildingRegistry } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { TPS } from '../../src/game/simulation-clock.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { NORTH } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { canonicalState, canonicalize, fnv1a } from '../determinism/state-hash.js';

/**
 * Research. See ironflow.md C22 and §8 phase 7.
 *
 * The chunk's four acceptance criteria, in its order:
 *
 * ```text
 *   prerequisites are enforced; an unreachable technology cannot be started
 *   completing a technology immediately makes its unlocks buildable
 *   research consumes science at the specified rate and pauses when starved
 *   unlock state after loading a save exactly matches the pre-save state
 * ```
 *
 * The last is C24's to test properly — there is no save format yet — so what
 * is asserted here is the half that exists and that C24 will build on:
 * `ResearchState` round-trips through its own `toJSON`, and the derived unlock
 * tables come back identical from the restored state alone (§10).
 *
 * ## The layout
 *
 * ```text
 *   y=0..2   [LAB]        3x3, 180 kW
 *   y=4      ·p·          a pole: reach 8, area 5, so it covers both
 *   y=6..8   [GEN]        3x3, 900 kW, with coal in it
 * ```
 *
 * A lab is the first building in the game that *must* be powered to do
 * anything at all, so every test here that is about research rather than about
 * power builds the grid with it.
 */

function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

/** Create a building directly in the store, as `power-system.test.ts` does. */
function place(simulation: Simulation, buildingId: string, x: number, y: number): Entity {
  const definition = simulation.buildings.get(buildingId);
  return simulation.entities.create(
    initialBuildingState(definition, x, y, BuildingRegistry.normalizeRotation(definition, NORTH)),
  );
}

interface Harness {
  readonly simulation: Simulation;
  readonly lab: LabEntity;
  readonly core: number;
}

/** A powered lab with `cores` data cores in it, and the grid to run it. */
function poweredLab(cores = 0, coal = 50): Harness {
  const simulation = new Simulation({ world: flatWorld() });
  const generator = place(simulation, 'generator', 0, 6);
  const fuel = asGenerator(generator, simulation.buildings);
  if (fuel === null) throw new Error('that is not a generator');
  fuel.fuel = [[simulation.items.idOf('coal'), coal]];
  place(simulation, 'power_pole', 1, 4);

  const entity = place(simulation, 'lab', 0, 0);
  const lab = asLab(entity, simulation.buildings);
  if (lab === null) throw new Error('that is not a lab');

  const core = simulation.items.idOf('data_core');
  if (cores > 0) lab.input = [[core, cores]];
  return { simulation, lab, core };
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

/**
 * Apply a command through the queue, and answer with how it was refused.
 *
 * **The tick this runs is a research tick too.** Commands are phase 1 and labs
 * are phase 7 (§8), so a `startResearch` applied here has a lab a tick into
 * its first unit by the time this returns — which is the behaviour, and why
 * the tick counts below are one off the round numbers.
 */
function dispatch(simulation: Simulation, command: Command): CommandRejectionReason | null {
  simulation.commands.enqueue(command);
  simulation.tick();
  const rejections = simulation.commands.takeRejections();
  return rejections[0]?.reason ?? null;
}

function held(lab: LabEntity, itemId: number): number {
  return lab.input.find((entry) => entry[0] === itemId)?.[1] ?? 0;
}

/** Ticks one research unit takes. Five seconds, uniform across v1 (C22). */
const UNIT_TICKS = 5 * TPS;

describe('starting research', () => {
  it('refuses a technology whose prerequisites are neither done nor queued', () => {
    const { simulation } = poweredLab();

    // `power_1` needs `smelting_2`, which needs `logistics_1`. C22's first
    // acceptance criterion: an unreachable technology cannot be started.
    expect(dispatch(simulation, { type: 'startResearch', technologyId: 'power_1' })).toBe(
      'missing_prerequisites',
    );
    expect(simulation.research.queue).toHaveLength(0);
  });

  it('accepts a whole branch in one pass, because a queued prerequisite counts', () => {
    const { simulation } = poweredLab();

    expect(dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' })).toBeNull();
    // Still unresearched, but it is ahead in the queue and will be done first,
    // which is what makes the queue worth having.
    expect(dispatch(simulation, { type: 'startResearch', technologyId: 'smelting_2' })).toBeNull();
    expect(dispatch(simulation, { type: 'startResearch', technologyId: 'power_1' })).toBeNull();

    expect(simulation.research.queue.map((id) => simulation.technologies.byId(id).id)).toEqual([
      'logistics_1',
      'smelting_2',
      'power_1',
    ]);
  });

  it.each([
    ['an id nothing answers to', 'teleportation', 'unknown_technology'],
    ['one already in the queue', 'logistics_1', 'already_queued'],
  ])('refuses %s', (_label, technologyId, reason) => {
    const { simulation } = poweredLab();
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    expect(dispatch(simulation, { type: 'startResearch', technologyId })).toBe(reason);
  });

  it('refuses one that is already researched', () => {
    const { simulation } = poweredLab();
    simulation.researchSystem.grant('logistics_1');
    expect(dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' })).toBe(
      'already_researched',
    );
  });
});

describe('cancelling research', () => {
  it('drops a technology and keeps the units already paid for', () => {
    const { simulation, lab, core } = poweredLab(4);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 2 * UNIT_TICKS);

    // Two units done, and a third one tick in — the lab starts the next unit
    // on the tick the last one lands, so there is no idle tick between them.
    const logistics = simulation.technologies.get('logistics_1').technologyId;
    expect(simulation.research.unitsOf(logistics)).toBe(2);
    expect(lab.progressTicks).toBe(1);
    expect(held(lab, core)).toBe(1);

    expect(dispatch(simulation, { type: 'cancelResearch', technologyId: 'logistics_1' })).toBeNull();
    expect(simulation.research.queue).toHaveLength(0);
    // Changing your mind costs nothing: the science is spent and both the
    // units it bought and the unit in flight are still there when the player
    // comes back to it.
    expect(simulation.research.unitsOf(logistics)).toBe(2);
    // Frozen, not advanced: the cancel landed in phase 1 and phase 7 of the
    // same tick found nothing to spend the unit on.
    expect(lab.progressTicks).toBe(1);

    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, UNIT_TICKS - 2);
    expect(simulation.research.unitsOf(logistics)).toBe(3);
  });

  it('takes the technologies that depended on it out of the queue too', () => {
    const { simulation } = poweredLab();
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    dispatch(simulation, { type: 'startResearch', technologyId: 'smelting_2' });
    dispatch(simulation, { type: 'startResearch', technologyId: 'power_1' });

    // A queue whose middle technology is gone is a queue with a stall in it
    // that nothing would explain, so the whole branch goes.
    dispatch(simulation, { type: 'cancelResearch', technologyId: 'smelting_2' });
    expect(simulation.research.queue.map((id) => simulation.technologies.byId(id).id)).toEqual([
      'logistics_1',
    ]);
  });

  it('refuses to cancel something that is not queued', () => {
    const { simulation } = poweredLab();
    expect(dispatch(simulation, { type: 'cancelResearch', technologyId: 'logistics_1' })).toBe(
      'nothing_queued',
    );
    expect(dispatch(simulation, { type: 'cancelResearch', technologyId: 'teleportation' })).toBe(
      'unknown_technology',
    );
  });
});

describe('a lab', () => {
  it('spends one science item per unit, at the technology’s rate', () => {
    const { simulation, lab, core } = poweredLab(10);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });

    // One unit is five seconds and one data core. The core leaves the buffer
    // when the unit *starts*, which was the `dispatch` tick above.
    expect(held(lab, core)).toBe(9);
    expect(lab.status).toBe(MachineStatus.Running);
    expect(lab.progressTicks).toBe(1);

    const logistics = simulation.technologies.get('logistics_1').technologyId;
    run(simulation, UNIT_TICKS - 2);
    expect(simulation.research.unitsOf(logistics)).toBe(0);

    run(simulation, 1);
    expect(simulation.research.unitsOf(logistics)).toBe(1);
    // Three units in, three cores gone: 0.2 units a second, which is exactly
    // what one tier-1 assembler making data cores produces (§15).
    run(simulation, 2 * UNIT_TICKS);
    expect(simulation.research.unitsOf(logistics)).toBe(3);
    expect(held(lab, core)).toBe(7);
  });

  it('pauses when it is starved, and says so', () => {
    const { simulation, lab, core } = poweredLab(2);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 2 * UNIT_TICKS);

    const logistics = simulation.technologies.get('logistics_1').technologyId;
    expect(simulation.research.unitsOf(logistics)).toBe(2);
    expect(held(lab, core)).toBe(0);

    // C22's third acceptance criterion: it pauses rather than stalling
    // silently, and §13's rule is that the panel must be able to say why.
    run(simulation, 10 * UNIT_TICKS);
    expect(simulation.research.unitsOf(logistics)).toBe(2);
    expect(lab.status).toBe(MachineStatus.NoInput);

    // And it carries straight on when something arrives.
    lab.input = [[core, 3]];
    run(simulation, UNIT_TICKS);
    expect(simulation.research.unitsOf(logistics)).toBe(3);
  });

  it('does nothing at all with no power, and says that instead', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const entity = place(simulation, 'lab', 0, 0);
    const lab = asLab(entity, simulation.buildings);
    if (lab === null) throw new Error('that is not a lab');
    lab.input = [[simulation.items.idOf('data_core'), 10]];

    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 4 * UNIT_TICKS);

    // The lab is C22's reason the grid stops being optional: every technology
    // in the game goes through a building that will not turn over without one.
    expect(simulation.research.unitsOf(simulation.technologies.get('logistics_1').technologyId)).toBe(0);
    expect(lab.status).toBe(MachineStatus.NoPower);
    expect(lab.input[0]?.[1]).toBe(10);
  });

  it('keeps a part-finished unit when the queue empties, and spends it later', () => {
    const { simulation, lab } = poweredLab(10);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 59);
    expect(lab.progressTicks).toBe(60);

    dispatch(simulation, { type: 'cancelResearch', technologyId: 'logistics_1' });
    run(simulation, 60);
    // A unit of research work belongs to no technology (`lab-entity.ts`), so
    // it is neither lost nor advanced while there is nothing to spend it on.
    expect(lab.progressTicks).toBe(60);
    expect(lab.status).toBe(MachineStatus.Idle);

    // `smelting_2` needs `logistics_1`, so the test grants it rather than
    // researching it: what is being asked here is where the sixty ticks went.
    simulation.researchSystem.grant('logistics_1');
    dispatch(simulation, { type: 'startResearch', technologyId: 'smelting_2' });
    run(simulation, UNIT_TICKS - 61);
    expect(simulation.research.unitsOf(simulation.technologies.get('smelting_2').technologyId)).toBe(1);
  });
});

describe('several labs', () => {
  /** A second lab on the same pole, so both are powered. */
  function twoLabs(cores: number): Harness & { readonly second: LabEntity } {
    const harness = poweredLab(cores);
    // Inside the pole's supply square (centred on (1,4), five tiles across),
    // which reaches x -1..3 and y 2..6: this lab's east column is x -1.
    const entity = place(harness.simulation, 'lab', -3, 0);
    const second = asLab(entity, harness.simulation.buildings);
    if (second === null) throw new Error('that is not a lab');
    second.input = [[harness.core, cores]];
    return { ...harness, second };
  }

  it('researches in parallel: two labs, two units per unit time', () => {
    const { simulation } = twoLabs(10);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });

    run(simulation, UNIT_TICKS - 1);
    // A second lab is a second unit in flight, not a faster one — which is
    // what keeps the rate a whole number of items per lab per unit.
    expect(simulation.research.unitsOf(simulation.technologies.get('logistics_1').technologyId)).toBe(2);
  });

  it('never starts more units than the technology still needs', () => {
    // `logistics_1` is ten units; nine are already done, so of the two labs
    // exactly one may start the tenth. Without the in-flight guard the other
    // would spend a core on a unit with nowhere to go.
    const { simulation, lab, second, core } = twoLabs(10);
    for (let i = 0; i < 9; i++) simulation.research.addUnit(simulation.technologies.get('logistics_1').technologyId);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });

    expect(held(lab, core) + held(second, core)).toBe(19);

    run(simulation, UNIT_TICKS);
    expect(simulation.research.isUnlocked(simulation.technologies.get('logistics_1').technologyId)).toBe(true);
    expect(held(lab, core) + held(second, core)).toBe(19);
  });
});

describe('completing a technology', () => {
  it('makes its unlocks buildable on the same tick', () => {
    const { simulation } = poweredLab(10);
    simulation.inventory.add('splitter', 1);
    // Within build reach, so the answer is about the technology and not about
    // how far away the player is standing (C10).
    simulation.player.setTilePosition(20, 22);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });

    expect(simulation.checkPlacement('splitter', 20, 20, NORTH)).toBe('locked');

    run(simulation, 10 * UNIT_TICKS);

    // C22's second acceptance criterion. Phase 7 applies the unlock, so phase
    // 1 of the next tick — the earliest a command can be applied — already
    // sees it.
    expect(simulation.research.isUnlocked(simulation.technologies.get('logistics_1').technologyId)).toBe(true);
    expect(simulation.unlocks.isBuildingIdUnlocked('splitter')).toBe(true);
    expect(simulation.checkPlacement('splitter', 20, 20, NORTH)).toBeNull();
  });

  it('leaves the queue and starts the next technology without a wasted tick', () => {
    const { simulation } = poweredLab(40);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    dispatch(simulation, { type: 'startResearch', technologyId: 'smelting_2' });

    run(simulation, 10 * UNIT_TICKS);
    expect(simulation.research.queue.map((id) => simulation.technologies.byId(id).id)).toEqual([
      'smelting_2',
    ]);

    run(simulation, UNIT_TICKS);
    expect(simulation.research.unitsOf(simulation.technologies.get('smelting_2').technologyId)).toBe(1);
  });

  it('tells the player, because it happens while they are looking elsewhere', () => {
    const { simulation } = poweredLab(10);
    dispatch(simulation, { type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 10 * UNIT_TICKS);

    const alerts = simulation.alerts.take();
    expect(alerts.map((alert) => alert.type)).toContain('research_complete');
    expect(alerts.find((alert) => alert.type === 'research_complete')?.subject).toBe('Logistics 1');
  });
});

describe('what a lock actually stops', () => {
  it('refuses to build a locked building, wherever it is pointed', () => {
    const { simulation } = poweredLab();
    simulation.inventory.add('splitter', 1);
    simulation.player.setTilePosition(20, 20);

    expect(
      dispatch(simulation, { type: 'build', buildingId: 'splitter', x: 20, y: 21, rotation: NORTH }),
    ).toBe('locked');
    expect(simulation.entities.at(20, 21)).toBeUndefined();
  });

  it('refuses to hand-craft a locked recipe, and to set one in a machine', () => {
    const { simulation } = poweredLab();
    simulation.player.inventory.add(simulation.items.idOf('steel'), 10);
    simulation.player.inventory.add(simulation.items.idOf('brick'), 10);

    // `make_frame` is behind `construction_1`, and `locked` is asked before
    // `not_craftable`: the player cannot make it at all yet, and sending them
    // to build a machine for it would be the wrong instruction.
    expect(dispatch(simulation, { type: 'craftItem', recipeId: 'make_frame', count: 1 })).toBe('locked');

    const assembler = place(simulation, 'assembler', 20, 20);
    simulation.player.setTilePosition(20, 22);
    expect(
      dispatch(simulation, { type: 'setRecipe', entityId: assembler.id, recipeId: 'make_frame' }),
    ).toBe('locked');
  });

  it('lets a locked building be demolished, because it is already standing', () => {
    const { simulation } = poweredLab();
    simulation.researchSystem.grant('logistics_1');
    simulation.inventory.add('splitter', 1);
    simulation.player.setTilePosition(20, 22);
    dispatch(simulation, { type: 'build', buildingId: 'splitter', x: 20, y: 20, rotation: NORTH });

    // There is no way back to a locked state in v1, but the rule is worth
    // pinning: a building the player can neither use nor remove would be the
    // worst outcome of a content change (C27).
    expect(dispatch(simulation, { type: 'remove', x: 20, y: 20 })).toBeNull();
    expect(simulation.inventory.count('splitter')).toBe(1);
  });
});

describe('determinism (§6)', () => {
  /**
   * Two identical runs of a lab factory hash identically, and a run that
   * researched something does not hash like one that did not.
   *
   * `state-hash.ts` gained a `research` root in C22, and a root that is in the
   * hash but never varies would be a root nobody could tell was broken. This
   * is the smallest thing that makes it vary: the same seed, the same
   * commands, the same tick count (§6), with a lab turning science into
   * technologies in between.
   */
  function runLab(ticks: number, research: boolean): string {
    const { simulation } = poweredLab(20);
    if (research) simulation.commands.enqueue({ type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, ticks);
    return fnv1a(canonicalize(canonicalState(simulation)));
  }

  it('hashes two identical runs the same', () => {
    expect(runLab(12 * UNIT_TICKS, true)).toBe(runLab(12 * UNIT_TICKS, true));
  });

  it('hashes a factory that researched differently from one that did not', () => {
    expect(runLab(12 * UNIT_TICKS, true)).not.toBe(runLab(12 * UNIT_TICKS, false));
  });

  it('holds no NaN, no Infinity and no -0 after a long run (§6 R7)', () => {
    const { simulation } = poweredLab(20);
    simulation.commands.enqueue({ type: 'startResearch', technologyId: 'logistics_1' });
    run(simulation, 20 * UNIT_TICKS);
    expect(canonicalize(canonicalState(simulation))).not.toMatch(/NaN|Infinity|-0/);
  });
});

describe('research state', () => {
  it('round-trips through its own JSON, and the unlocks come back identical', () => {
    const { simulation } = poweredLab(10);
    simulation.researchSystem.grant('logistics_1');
    dispatch(simulation, { type: 'startResearch', technologyId: 'smelting_2' });
    run(simulation, 3 * UNIT_TICKS);

    const saved = simulation.research.toJSON();
    const before = simulation.unlocks.snapshot();

    // The half of C22's fourth acceptance criterion that exists before C24:
    // restore the authoritative state, recompute the derived tables, and the
    // world is the world that was saved (§10).
    const loaded = new Simulation({ world: flatWorld() });
    loaded.research.load(saved);
    loaded.researchSystem.rebuild();

    expect(loaded.research.toJSON()).toEqual(saved);
    expect(loaded.unlocks.snapshot()).toEqual(before);
    expect(loaded.research.unitsOf(loaded.technologies.get('smelting_2').technologyId)).toBe(3);
  });

  it('drops ids the registry has never heard of rather than indexing past its arrays', () => {
    const { simulation } = poweredLab();
    simulation.research.load({ unlocked: [0, 99], progress: [[98, 4]], queue: [1, 97] });

    expect(simulation.research.toJSON()).toEqual({ unlocked: [0], progress: [], queue: [1] });
  });
});
