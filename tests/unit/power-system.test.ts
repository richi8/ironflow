import { describe, expect, it } from 'vitest';

import { BUILDINGS } from '../../src/game/data/buildings.js';
import { initialBuildingState } from '../../src/game/entities/building-init.js';
import type { Entity } from '../../src/game/entities/entity.js';
import { asGenerator } from '../../src/game/entities/generator-entity.js';
import { MachineStatus, machineStatusName } from '../../src/game/entities/machine-status.js';
import { asMachine, type MachineEntity } from '../../src/game/entities/machine-entity.js';
import { BuildingRegistry, type BuildingDefinition } from '../../src/game/registries/building-registry.js';
import { Simulation } from '../../src/game/simulation.js';
import { NO_NETWORK, POWER_SCALE, advancesOn } from '../../src/game/systems/power-system.js';
import { createChunk } from '../../src/game/world/chunk.js';
import { NORTH, type Rotation } from '../../src/game/world/coordinates.js';
import { World } from '../../src/game/world/world.js';
import { canonicalState, fnv1a, canonicalize } from '../determinism/state-hash.js';

/**
 * Power. See ironflow.md C21 and §8 phase 2.
 *
 * The chunk's four named tests, in its order — connected components including
 * disjoint networks, the ratio applied in fixed point, an incrementally
 * maintained graph matching a freshly built one, and determinism of partial
 * satisfaction — plus its five acceptance criteria.
 *
 * ## The layout every ratio test uses
 *
 * ```text
 *   y=0..1   [EF][EF][EF] ...          twelve 2x2 electric furnaces, 150 kW each
 *   y=3      ·p· ·p· ·p·  ...          poles every 4 tiles: reach 8, area 5
 *   y=4..6   [GEN]                     one 3x3 generator, 900 kW
 * ```
 *
 * 1800 kW demanded against 900 kW supplied is a satisfaction of exactly a
 * half, which is the number the Bresenham gate is cleanest to reason about:
 * every machine works on the even ticks and on no others, so 960 ticks buy 480
 * ticks of progress and 480 is five 96-tick smelts to the tick. Nothing in
 * these numbers is approximate, which is the whole point of §6 R3 — a test
 * that had to allow ±2% could not tell a rounding error from a lost tick.
 */

/** Grass with nothing on it. Power cares about tiles, not about terrain. */
function flatWorld(): World {
  return new World((cx, cy) => createChunk(cx, cy));
}

/**
 * Create a building directly in the store, the way a loaded save arrives.
 *
 * Not through a `build` command, for `reference-factory.ts`'s reason: these
 * layouts are wider than the player can reach, and walking them across a test
 * would be a test of `movePlayer`.
 */
function place(simulation: Simulation, buildingId: string, x: number, y: number, rotation: Rotation = NORTH): Entity {
  const definition = simulation.buildings.get(buildingId);
  return simulation.entities.create(
    initialBuildingState(definition, x, y, BuildingRegistry.normalizeRotation(definition, rotation)),
  );
}

function fuel(simulation: Simulation, entity: Entity, coal: number): void {
  const generator = asGenerator(entity, simulation.buildings);
  if (generator === null) throw new Error('that is not a generator');
  generator.fuel = [[simulation.items.idOf('coal'), coal]];
}

function feed(simulation: Simulation, entity: Entity, ore: number): MachineEntity {
  const machine = asMachine(entity, simulation.buildings);
  if (machine === null) throw new Error('that is not a machine');
  machine.input = [[simulation.items.idOf('iron_ore'), ore]];
  return machine;
}

function run(simulation: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) simulation.tick();
}

const SMELT_TICKS = 96; // 3.2 s at 30 TPS (§15).
const FURNACE_KW = 150;
const GENERATOR_KW = 900;

/* -------------------------------------------------------------------------- *
 * The shared grid                                                             *
 * -------------------------------------------------------------------------- */

interface Grid {
  readonly simulation: Simulation;
  readonly furnaces: readonly MachineEntity[];
  readonly generators: readonly Entity[];
}

/**
 * `furnaceCount` electric furnaces and `generatorCount` generators on one
 * network, every machine fed and every generator fuelled.
 *
 * Poles every four tiles: four is inside the wire reach of eight, so the line
 * is one network, and a supply area of five means the squares overlap rather
 * than leaving a gap — which is the layout a player ends up at for exactly
 * this reason.
 */
function grid(furnaceCount: number, generatorCount: number, options: { readonly poles?: boolean } = {}): Grid {
  const simulation = new Simulation({ world: flatWorld() });
  const furnaces: MachineEntity[] = [];
  const generators: Entity[] = [];

  // At least one pole even with no furnaces, so a lone generator still has
  // somewhere to push its power.
  const width = Math.max(furnaceCount * 3, 1);
  if (options.poles !== false) {
    for (let x = 1; x <= width; x += 4) place(simulation, 'power_pole', x, 3);
  }
  for (let i = 0; i < furnaceCount; i++) {
    furnaces.push(feed(simulation, place(simulation, 'electric_furnace', i * 3, 0), 50));
  }
  for (let i = 0; i < generatorCount; i++) {
    const generator = place(simulation, 'generator', i * 4, 4);
    fuel(simulation, generator, 50);
    generators.push(generator);
  }
  return { simulation, furnaces, generators };
}

function plates(simulation: Simulation, machine: MachineEntity): number {
  const plate = simulation.items.idOf('iron_plate');
  return machine.output.find((entry) => entry[0] === plate)?.[1] ?? 0;
}

/* -------------------------------------------------------------------------- *
 * Connected components                                                        *
 * -------------------------------------------------------------------------- */

describe('networks are connected components over pole reach', () => {
  it('wires two poles exactly at the reach, and not one tile past it', () => {
    const near = new Simulation({ world: flatWorld() });
    place(near, 'power_pole', 0, 0);
    place(near, 'power_pole', 8, 0);
    near.tick();
    expect(near.power.networks).toBe(1);

    const far = new Simulation({ world: flatWorld() });
    place(far, 'power_pole', 0, 0);
    place(far, 'power_pole', 9, 0);
    far.tick();
    expect(far.power.networks).toBe(2);
  });

  it('measures reach as a radius, so a diagonal span is shorter than a straight one', () => {
    // (6, 6) is 12 tiles away along the grid and 8.49 as the wire runs, which
    // is past a reach of 8 — a Manhattan test would have wired it.
    const simulation = new Simulation({ world: flatWorld() });
    place(simulation, 'power_pole', 0, 0);
    place(simulation, 'power_pole', 6, 6);
    simulation.tick();
    expect(simulation.power.networks).toBe(2);

    // (5, 5) is 7.07, which is inside it.
    const closer = new Simulation({ world: flatWorld() });
    place(closer, 'power_pole', 0, 0);
    place(closer, 'power_pole', 5, 5);
    closer.tick();
    expect(closer.power.networks).toBe(1);
  });

  it('joins two disjoint networks when a pole bridges them, and splits them again', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const left = place(simulation, 'power_pole', 0, 0);
    const right = place(simulation, 'power_pole', 16, 0);
    simulation.tick();
    expect(simulation.power.networks).toBe(2);
    expect(simulation.power.networkAt(left)).not.toBe(simulation.power.networkAt(right));

    const bridge = place(simulation, 'power_pole', 8, 0);
    simulation.tick();
    expect(simulation.power.networks).toBe(1);
    expect(simulation.power.networkAt(left)).toBe(simulation.power.networkAt(right));

    // And removing it splits them, which is the case a union-find cannot undo
    // and the reason the graph is rebuilt from the pole set rather than
    // patched. It takes effect on the *next* tick, because a removal is
    // applied in phase 9 and power runs in phase 2 (§8) — so for the rest of
    // the tick it was demolished in, the pole is still standing and still
    // carrying, which is what "no system ever observes a half-removed entity"
    // means.
    simulation.entities.remove(bridge.id);
    simulation.tick();
    expect(simulation.power.networks).toBe(1);
    simulation.tick();
    expect(simulation.power.networks).toBe(2);
    expect(simulation.power.networkAt(left)).not.toBe(simulation.power.networkAt(right));
  });

  it('connects a building whose footprint only clips the supply area', () => {
    // A pole at (10, 10) with an area of 5 covers x and y in 8..12. A 2x2
    // furnace at (12, 12) has exactly one tile inside it.
    const simulation = new Simulation({ world: flatWorld() });
    place(simulation, 'power_pole', 10, 10);
    const clipping = place(simulation, 'electric_furnace', 12, 12);
    const outside = place(simulation, 'electric_furnace', 14, 14);
    simulation.tick();

    expect(simulation.power.networkAt(clipping)).not.toBe(NO_NETWORK);
    expect(simulation.power.networkAt(outside)).toBe(NO_NETWORK);
  });

  it('gives a building covered by two networks to the lower-numbered pole', () => {
    // Unreachable with the shipped pole — a reach of 8 against an area of 5
    // means any two poles whose squares overlap are already wired together —
    // so the rule is tested against a pole that reaches one tile. §6 R6 is
    // about what happens when two things want the same thing, and it must
    // hold whatever the content says.
    const stubby: readonly BuildingDefinition[] = BUILDINGS.map((definition) =>
      definition.id === 'power_pole' ? { ...definition, pole: { wireReach: 1, supplyArea: 5 } } : definition,
    );
    const simulation = new Simulation({ world: flatWorld(), buildings: new BuildingRegistry(stubby) });

    // Areas of five centred four apart overlap on the column at x = 2, and a
    // reach of one leaves the two poles unwired.
    const first = place(simulation, 'power_pole', 0, 0);
    const second = place(simulation, 'power_pole', 4, 0);
    // The furnace covers (2,0)..(3,1): the first column is inside both
    // squares, the second only inside `second`'s. `first` has the lower id.
    const furnace = place(simulation, 'electric_furnace', 2, 0);
    simulation.tick();

    expect(simulation.power.networks).toBe(2);
    expect(simulation.power.networkAt(furnace)).toBe(simulation.power.networkAt(first));
    expect(simulation.power.networkAt(furnace)).not.toBe(simulation.power.networkAt(second));
  });
});

/* -------------------------------------------------------------------------- *
 * The rebuild                                                                 *
 * -------------------------------------------------------------------------- */

describe('the graph the poles are maintained against', () => {
  /** Every entity's network, as one comparable string. */
  function topology(simulation: Simulation): string {
    const rows: string[] = [];
    simulation.entities.forEach((entity) => rows.push(`${entity.id}:${simulation.power.networkAt(entity)}`));
    return `${simulation.power.networks}|${rows.join(',')}`;
  }

  it('matches a rebuild from scratch after a session of building and demolishing', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const poles: Entity[] = [];

    for (let i = 0; i < 6; i++) {
      poles.push(place(simulation, 'power_pole', i * 6, 0));
      place(simulation, 'electric_furnace', i * 6, 2);
      simulation.tick();
    }
    // Knock two out of the middle, which is what splits a line into pieces.
    simulation.entities.remove(poles[2]?.id ?? 0);
    simulation.entities.remove(poles[3]?.id ?? 0);
    simulation.tick();
    place(simulation, 'power_pole', 14, 0);
    simulation.tick();

    const maintained = topology(simulation);
    expect(simulation.power.networks).toBeGreaterThan(1);

    // §10: the networks are derived, and `rebuildDerived()` must be idempotent.
    simulation.power.rebuild();
    expect(topology(simulation)).toBe(maintained);
    simulation.power.rebuild();
    expect(topology(simulation)).toBe(maintained);
  });

  it('numbers networks by their lowest pole id, not by where the poles are', () => {
    // Built right to left, so the eastern network has the *lower* id and
    // therefore the lower index. Position plays no part: an index derived
    // from a coordinate would renumber every network when one was moved, and
    // ids are the thing §6 R5 promises never move.
    const simulation = new Simulation({ world: flatWorld() });
    const right = place(simulation, 'power_pole', 40, 0);
    const left = place(simulation, 'power_pole', 0, 0);
    simulation.tick();

    expect(simulation.power.networkAt(right)).toBe(0);
    expect(simulation.power.networkAt(left)).toBe(1);

    // And a rebuild lands on the same numbering rather than on the order the
    // buckets happened to come back in.
    simulation.power.rebuild();
    expect(simulation.power.networkAt(right)).toBe(0);
    expect(simulation.power.networkAt(left)).toBe(1);
  });
});

/* -------------------------------------------------------------------------- *
 * The ratio                                                                   *
 * -------------------------------------------------------------------------- */

describe('the satisfaction ratio', () => {
  it('is supply over demand, clamped at full', () => {
    const { simulation } = grid(12, 1);
    simulation.tick();

    const summary = simulation.power.summary();
    expect(summary).not.toBeNull();
    expect(summary?.demandKw).toBe(12 * FURNACE_KW);
    expect(summary?.supplyKw).toBe(GENERATOR_KW);
    expect(summary?.satisfactionPercent).toBe(50);
    expect(summary?.networks).toBe(1);
  });

  it('never reports more than full, however much is generated', () => {
    const { simulation } = grid(2, 2);
    simulation.tick();
    expect(simulation.power.summary()?.satisfactionPercent).toBe(100);
  });

  it('counts demand from what is built, not from what is running', () => {
    // Six furnaces exactly fill one generator. Empty five of them: a demand
    // that followed the machines would jump to 100% for the one that is left,
    // and the player's power budget would move while they were reading it.
    const { simulation, furnaces } = grid(6, 1);
    for (let i = 1; i < furnaces.length; i++) (furnaces[i] as MachineEntity).input = [];
    simulation.tick();

    expect(simulation.power.summary()?.demandKw).toBe(6 * FURNACE_KW);
    expect(simulation.power.summary()?.satisfactionPercent).toBe(100);
  });

  it('slows every machine on the network by exactly the ratio, and by the same amount', () => {
    const { simulation, furnaces } = grid(12, 1);
    // 960 ticks at half satisfaction is 480 ticks of work, which is five
    // 96-tick smelts to the tick.
    run(simulation, SMELT_TICKS * 10);

    for (const furnace of furnaces) {
      expect(plates(simulation, furnace)).toBe(5);
      expect(machineStatusName(furnace.status)).toBe('low_power');
    }
  });

  it('runs at full speed on a network that can pay for it', () => {
    const { simulation, furnaces } = grid(6, 1);
    run(simulation, SMELT_TICKS * 10);

    for (const furnace of furnaces) {
      expect(plates(simulation, furnace)).toBe(10);
      expect(machineStatusName(furnace.status)).toBe('running');
    }
  });

  it('gives a machine on its own network the ticks its share buys, to the tick', () => {
    // Nine furnaces on one generator is 1350 kW wanted against 900 supplied:
    // two thirds, which does not divide the tick rate and is where a float
    // accumulator would start to drift.
    //
    //   satisfaction  floor(900 * 1000 / 1350)          = 666 / 1000
    //   worked ticks  floor(900 * 666 / 1000)           = 599
    //   smelts        floor(599 / 96)                   = 6, and 23 over
    //
    // Every one of those is an integer division done once, which is the whole
    // of §6 R3 applied to a ratio.
    const { simulation, furnaces } = grid(9, 1);
    run(simulation, 900);

    const furnace = furnaces[0] as MachineEntity;
    expect(simulation.power.summary()?.satisfactionPercent).toBe(66);
    expect(plates(simulation, furnace)).toBe(6);
    expect(furnace.progressTicks).toBe(599 - 6 * SMELT_TICKS);
  });
});

describe('the Bresenham gate', () => {
  it('always works at full satisfaction and never at none', () => {
    for (let tick = 1; tick <= 50; tick++) {
      expect(advancesOn(tick, POWER_SCALE)).toBe(true);
      expect(advancesOn(tick, 0)).toBe(false);
    }
  });

  it.each([1, 37, 250, 500, 667, 999])('delivers exactly its share of ten thousand ticks at %i', (satisfaction) => {
    let worked = 0;
    for (let tick = 1; tick <= 10_000; tick++) if (advancesOn(tick, satisfaction)) worked += 1;
    expect(worked).toBe(Math.floor((10_000 * satisfaction) / POWER_SCALE));
  });

  it('depends on nothing but the tick and the ratio, so it survives a reload', () => {
    // The property that replaces a serialized accumulator (§6 R8): the tick a
    // machine's share falls on is a function of the tick counter, which *is*
    // saved, so a world reloaded mid-brownout resumes on the same schedule.
    for (const satisfaction of [123, 500, 811]) {
      for (const tick of [1, 2, 3, 97, 5000, 123_457]) {
        expect(advancesOn(tick, satisfaction)).toBe(advancesOn(tick, satisfaction));
      }
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Acceptance                                                                  *
 * -------------------------------------------------------------------------- */

describe('C21 acceptance', () => {
  it('will not run a machine that is on no network, and says why once', () => {
    const { simulation, furnaces } = grid(1, 0, { poles: false });
    run(simulation, SMELT_TICKS * 2);

    const furnace = furnaces[0] as MachineEntity;
    expect(furnace.progressTicks).toBe(0);
    expect(plates(simulation, furnace)).toBe(0);
    expect(machineStatusName(furnace.status)).toBe('no_power');

    // One alert on the transition, not one per tick (C11's rule, C20's table).
    expect(simulation.alerts.take().map((alert) => alert.type)).toEqual(['no_power_network']);
    run(simulation, 60);
    expect(simulation.alerts.take()).toEqual([]);
  });

  it('will not run a machine on a network with nothing generating', () => {
    const { simulation, furnaces } = grid(1, 0);
    run(simulation, SMELT_TICKS);

    const furnace = furnaces[0] as MachineEntity;
    expect(furnace.progressTicks).toBe(0);
    expect(machineStatusName(furnace.status)).toBe('no_power');
    expect(simulation.power.summary()?.satisfactionPercent).toBe(0);
  });

  it('says a generator with no pole beside it is not connected, and burns nothing', () => {
    const simulation = new Simulation({ world: flatWorld() });
    const entity = place(simulation, 'generator', 0, 0);
    fuel(simulation, entity, 50);
    run(simulation, 60);

    const generator = asGenerator(entity, simulation.buildings);
    expect(generator?.status).toBe(MachineStatus.NoPower);
    expect(generator?.fuel[0]?.[1]).toBe(50);
    expect(simulation.power.summary()).toBeNull();
  });

  it('idles rather than burning coal into a network nothing is drawing on', () => {
    const { simulation, generators } = grid(0, 1);
    run(simulation, 300);

    const generator = asGenerator(generators[0] as Entity, simulation.buildings);
    expect(generator?.status).toBe(MachineStatus.Idle);
    expect(generator?.fuel[0]?.[1]).toBe(50);
  });

  it('restores full speed within one tick of a generator being added', () => {
    const { simulation, furnaces } = grid(12, 1);
    run(simulation, 100);
    expect(simulation.power.summary()?.satisfactionPercent).toBe(50);

    const furnace = furnaces[0] as MachineEntity;
    fuel(simulation, place(simulation, 'generator', 8, 4), 50);
    const before = furnace.progressTicks;

    simulation.tick();
    expect(simulation.power.summary()?.satisfactionPercent).toBe(100);
    // The very next tick counts, whatever its parity: at half satisfaction
    // half of them did not.
    expect(furnace.progressTicks).toBe(before + 1);
    simulation.tick();
    expect(furnace.progressTicks).toBe(before + 2);
  });

  it('burns §15s 0.75 coal a second, which is what makes the electric furnace coal-neutral', () => {
    const { simulation, generators } = grid(6, 1);
    // 40 seconds at 30 TPS. §15: 0.75 coal/s, so thirty coal.
    run(simulation, 40 * 30);

    const generator = asGenerator(generators[0] as Entity, simulation.buildings);
    expect(generator?.fuel[0]?.[1]).toBe(50 - 30);
    // And the six furnaces it feeds would have burned the same thirty between
    // them at §15's eight seconds a coal: 6 x 40 / 8 = 30.
    expect((6 * 40) / 8).toBe(30);
  });

  it('puts no float into authoritative state, at any satisfaction', () => {
    const { simulation } = grid(9, 1);
    run(simulation, 500);
    expect(simulation.power.summary()?.satisfactionPercent).toBe(66);

    simulation.entities.forEach((entity) => {
      for (const [key, value] of Object.entries(entity as unknown as Record<string, unknown>)) {
        checkIntegers(value, `#${entity.id}.${key}`);
      }
    });
  });

  it('rebuilds the networks of a twenty-thousand-entity world in well under 100 ms', () => {
    // The acceptance criterion is worded about a loaded save, and C24 is what
    // will load one. What a load costs *here* is one full rebuild, which is
    // the only work a world arriving all at once puts on this system — so it
    // is the thing to measure, at the size §12's reference factory names.
    const simulation = new Simulation({ world: flatWorld() });
    let built = 0;
    for (let row = 0; built < 20_000; row += 1) {
      for (let column = 0; column < 200 && built < 20_000; column += 1) {
        // A pole every twentieth entity, which is a thousand of them — far
        // more than a real factory of this size carries.
        if (column % 20 === 0) place(simulation, 'power_pole', column * 2, row * 2);
        else place(simulation, 'belt', column * 2, row * 2);
        built += 1;
      }
    }
    expect(simulation.entities.size).toBe(20_000);

    const started = performance.now();
    simulation.power.rebuild();
    const elapsed = performance.now() - started;

    expect(simulation.power.networks).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(100);
  });
});

/* -------------------------------------------------------------------------- *
 * Determinism                                                                 *
 * -------------------------------------------------------------------------- */

describe('partial satisfaction is deterministic', () => {
  function hash(simulation: Simulation): string {
    return fnv1a(canonicalize(canonicalState(simulation)));
  }

  it('produces the same world from the same inputs', () => {
    const a = grid(9, 1);
    const b = grid(9, 1);
    run(a.simulation, 777);
    run(b.simulation, 777);
    expect(hash(a.simulation)).toBe(hash(b.simulation));
  });

  it('is unchanged by rebuilding the networks halfway through', () => {
    // The networks are derived state (§10), so throwing them away and building
    // them again — which is what a load does — must change nothing at all.
    const straight = grid(9, 1);
    run(straight.simulation, 777);

    const interrupted = grid(9, 1);
    run(interrupted.simulation, 400);
    interrupted.simulation.power.rebuild();
    run(interrupted.simulation, 377);

    expect(hash(interrupted.simulation)).toBe(hash(straight.simulation));
  });
});

/** Every number reachable from `value` must be a whole one (§6 R3, R7). */
function checkIntegers(value: unknown, path: string): void {
  if (typeof value === 'number') {
    expect(Number.isInteger(value), `${path} is ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkIntegers(item, `${path}[${index}]`));
  }
}
