import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import { Simulation } from '../../src/game/simulation.js';
import { Autosave } from '../../src/persistence/autosave.js';
import { IndexedDbSaveRepository } from '../../src/persistence/indexeddb-save-repository.js';
import { SaveController } from '../../src/persistence/save-controller.js';
import type { SaveRepository } from '../../src/persistence/save-repository.js';
import { SaveService } from '../../src/persistence/save-service.js';

import { FakeIndexedDb, failWrites, quotaError } from '../fixtures/fake-indexeddb.js';
import {
  PLAYER_TILE,
  layReferenceFactory,
  oreEverywhere,
  referenceWorld,
} from '../determinism/reference-factory.js';
import { hashSavedState } from '../determinism/state-hash.js';

/**
 * "A factory survives a full browser restart, bit-for-bit." C25's first
 * acceptance criterion, run end to end.
 *
 * ```text
 *   run a factory ──> SaveController.saveNew ──> gzip ──> IndexedDB
 *                                                            │
 *   close the tab, open a new one, new repository over the same disk
 *                                                            │
 *   SaveController.load <── gunzip <── IndexedDB ─────────────┘
 *                     │
 *                     └──> deserialize ──> hash equals the world that was saved
 * ```
 *
 * The bar is `hashSavedState` rather than "it loaded without throwing", which
 * is the same bar §6 R8 sets in `tests/determinism/save-round-trip.test.ts`
 * and for the same reason: a loader that dropped a furnace's part-burnt coal
 * would pass every other assertion in this file.
 *
 * What is new *here* is everything between the serializer and the disk — the
 * gzip, the two object stores, the metadata that the save menu lists from, and
 * a second connection standing in for a second session. C24 proved the
 * document; this proves the filing cabinet.
 */

/** A factory with belts running, machines part-way through, and ore mined out. */
function runningFactory(ticks = 300): Simulation {
  const simulation = new Simulation({ world: referenceWorld(), seed: 0x51c25 });
  simulation.player.setTilePosition(PLAYER_TILE.x, PLAYER_TILE.y);
  // Twelve cells: enough for belts, a splitter, an inserter, a chest and a
  // furnace to all be mid-cycle when the snapshot is taken.
  layReferenceFactory(simulation, 'forwards', 12);
  for (let tick = 0; tick < ticks; tick++) simulation.tick();
  return simulation;
}

/** A controller over `repository`, with the world it is playing held beside it. */
function session(repository: SaveRepository, world: Simulation) {
  const service = new SaveService({ repository });
  let current = world;
  const controller = new SaveController({
    service,
    capture: () => ({ state: serialize(current), playtimeTicks: current.getTick(), hotbar: null, quests: null }),
    // The generator is pinned for the reason C24's `DeserializeOptions` gives:
    // this world is laid out from a fixed pattern rather than from C19's
    // noise, so without it a save test would also be a test of the octaves.
    apply: (state) => {
      current = deserialize(state, { worldGenerator: () => oreEverywhere() });
    },
    onChange: () => undefined,
  });
  return { controller, service, world: () => current };
}

let disk: FakeIndexedDb;

beforeEach(() => {
  disk = new FakeIndexedDb();
  failWrites(null);
});

afterEach(() => {
  failWrites(null);
});

describe('a factory across a browser restart', () => {
  it('comes back bit-for-bit', async () => {
    const before = runningFactory();
    const expected = hashSavedState(before);

    // ---- session one ------------------------------------------------------
    const first = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const one = session(first, before);
    await one.controller.saveNew('Across a restart');
    const [slot] = one.controller.getState().slots;
    expect(slot?.name).toBe('Across a restart');
    first.close();

    // ---- session two: a new repository over the same disk ------------------
    const second = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const two = session(second, new Simulation({ world: referenceWorld() }));

    await two.controller.refresh();
    const listed = two.controller.getState().slots[0];
    expect(listed?.id).toBe(slot?.id);
    expect(listed?.playtimeTicks).toBe(before.getTick());

    await two.controller.load(listed?.id ?? '');
    expect(hashSavedState(two.world())).toBe(expected);
    second.close();
  });

  it('keeps running in step with the world it was saved from', async () => {
    // A load that rebuilt the power networks or the belt order wrongly would
    // match at the instant of the load and diverge after it — which is the
    // failure the round trip alone cannot see.
    const before = runningFactory();
    const repository = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const one = session(repository, before);
    await one.controller.saveNew('In step');
    const id = one.controller.getState().slots[0]?.id ?? '';

    const two = session(repository, new Simulation({ world: referenceWorld() }));
    await two.controller.load(id);

    for (let tick = 0; tick < 200; tick++) {
      before.tick();
      two.world().tick();
      expect(hashSavedState(two.world())).toBe(hashSavedState(before));
    }
    repository.close();
  });

  it('survives an uncompressed write being read by a session that has gzip', async () => {
    // A save written on a browser without `CompressionStream` and opened on
    // one with it. The flag in the metadata is what makes this work; sniffing
    // the gzip magic would be right most of the time.
    const before = runningFactory(60);
    const repository = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });

    const original = globalThis.CompressionStream;
    Reflect.deleteProperty(globalThis, 'CompressionStream');
    const one = session(repository, before);
    await one.controller.saveNew('No gzip here');
    Object.defineProperty(globalThis, 'CompressionStream', { value: original, configurable: true, writable: true });

    const slot = one.controller.getState().slots[0];
    expect(slot?.compressed).toBe(false);

    const two = session(repository, new Simulation({ world: referenceWorld() }));
    await two.controller.load(slot?.id ?? '');
    expect(hashSavedState(two.world())).toBe(hashSavedState(before));
    repository.close();
  });
});

describe('the autosave rotation, against a real repository', () => {
  it('fills three slots, rotates, and never touches a manual save', async () => {
    const world = runningFactory(30);
    const repository = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const { controller, service } = session(repository, world);
    await controller.saveNew('My factory');

    const autosave = new Autosave({
      write: async (id) => {
        await service.write(id, {
          name: id,
          kind: 'auto',
          state: serialize(world),
          playtimeTicks: world.getTick(),
          hotbar: null,
          quests: null,
        });
      },
    });
    autosave.prime(await service.list());

    // Awaited rather than driven by the frame clock, so all four writes have
    // actually landed by the time the list is read. The interval itself is
    // `tests/unit/autosave.test.ts`'s.
    for (let round = 0; round < 4; round++) await autosave.trigger();

    const slots = await service.list();
    const manual = slots.filter((slot) => slot.kind === 'manual');
    const auto = slots.filter((slot) => slot.kind === 'auto');

    expect(manual.map((slot) => slot.name)).toEqual(['My factory']);
    expect(auto.map((slot) => slot.id).sort()).toEqual(['auto-1', 'auto-2', 'auto-3']);
    repository.close();
  });
});

describe('what an autosave costs a frame', () => {
  it('pays for the snapshot and hands the compression to a later turn', async () => {
    // C25's fourth acceptance criterion: "Autosave never blocks a frame for
    // more than 300 ms (serialize between ticks; write asynchronously)."
    //
    // What a frame actually pays is the *synchronous prologue* of the write:
    // `serialize`, then `JSON.stringify`. Gzip and the transaction happen
    // after the first `await`, which is a later turn of the event loop and
    // therefore a later frame — so the measurement below is the whole of the
    // frame-side cost, taken over the 5,005-entity factory §6 R8 is stated
    // against. (§12's 20,007-entity one is measured in
    // `tests/determinism/save-budget.test.ts`, which owns the scale budgets.)
    const world = new Simulation({ world: referenceWorld(), seed: 1 });
    world.player.setTilePosition(PLAYER_TILE.x, PLAYER_TILE.y);
    layReferenceFactory(world, 'forwards', 385);
    for (let tick = 0; tick < 100; tick++) world.tick();
    expect(world.entities.size).toBeGreaterThan(5000);

    const repository = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const service = new SaveService({ repository });
    let compressed = false;
    const autosave = new Autosave({
      write: async (id) => {
        await service.write(id, {
          name: id,
          kind: 'auto',
          state: serialize(world),
          playtimeTicks: world.getTick(),
          hotbar: null,
          quests: null,
        });
        compressed = true;
      },
    });

    const started = performance.now();
    const pending = autosave.trigger();
    const frameCost = performance.now() - started;

    expect(compressed).toBe(false);
    expect(frameCost).toBeLessThan(300);

    await pending;
    expect(compressed).toBe(true);
    expect((await service.list()).length).toBe(1);
    repository.close();
  });
});

describe('the quota, end to end', () => {
  it('leaves the stored factory intact and says what to do', async () => {
    const world = runningFactory(30);
    const repository = await IndexedDbSaveRepository.open({ factory: disk.asFactory() });
    const { controller, world: loaded } = session(repository, world);

    await controller.saveNew('The good one');
    const id = controller.getState().slots[0]?.id ?? '';

    failWrites(quotaError());
    await controller.overwrite(id, 'The doomed one');
    expect(controller.getState().status).toContain('Out of storage space');
    failWrites(null);

    // Still loadable, still the factory that was there before the failure.
    await controller.load(id);
    expect(hashSavedState(loaded())).toBe(hashSavedState(world));
    expect(controller.getState().slots[0]?.name).toBe('The good one');
    repository.close();
  });
});
