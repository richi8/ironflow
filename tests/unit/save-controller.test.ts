import { describe, expect, it } from 'vitest';

import type { SerializedGameState } from '../../src/game/save/save-format.js';
import { deserialize, serialize } from '../../src/game/save/save-serializer.js';
import type { Simulation } from '../../src/game/simulation.js';
import { Autosave } from '../../src/persistence/autosave.js';
import { MemorySaveRepository } from '../../src/persistence/memory-save-repository.js';
import { SaveController, type SaveSessionState } from '../../src/persistence/save-controller.js';
import { SaveError } from '../../src/persistence/save-repository.js';
import { encodeSaveFile, decodeSaveFile } from '../../src/persistence/export-import.js';
import { SaveService } from '../../src/persistence/save-service.js';
import { TabLock } from '../../src/persistence/tab-lock.js';

import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';
import { factorySimulation, sampleSave, sampleSimulation } from '../fixtures/saves.js';
import { hashState } from '../determinism/state-hash.js';

/**
 * What happens between a click and a message. C25 tasks 5, 6 and 7.
 *
 * Every one of §14's failure rows ends in a sentence the player reads, and
 * every one of those sentences is produced here — which is why this file
 * exists rather than the flow living in the composition root. A message that
 * only a browser session can produce is a message nobody checks.
 */

const GENERATOR = createPlaygroundGenerator();

interface Harness {
  readonly controller: SaveController;
  readonly repository: MemorySaveRepository;
  readonly service: SaveService;
  readonly states: SaveSessionState[];
  /** Files the player was handed (C26), newest last. */
  readonly downloads: { readonly bytes: Uint8Array; readonly filename: string }[];
  world(): Simulation;
  last(): SaveSessionState;
}

function harness(
  options: { lock?: TabLock; warning?: string | null; start?: Simulation } = {},
): Harness {
  const repository = new MemorySaveRepository({ now: () => Date.now() });
  const service = new SaveService({ repository, lock: options.lock });
  const states: SaveSessionState[] = [];
  const downloads: { bytes: Uint8Array; filename: string }[] = [];
  let world = options.start ?? sampleSimulation();

  const controller = new SaveController({
    service,
    capture: () => ({ state: serialize(world), playtimeTicks: world.getTick(), hotbar: null }),
    apply: (state: SerializedGameState) => {
      world = deserialize(state, { worldGenerator: () => GENERATOR });
    },
    onChange: (state) => states.push(state),
    warning: options.warning ?? null,
    // The browser's half of an export, which is the composition root's in the
    // real game (§4) and a list in a test — the whole reason it is injected.
    download: (bytes, filename) => void downloads.push({ bytes, filename }),
    now: () => Date.UTC(2026, 8, 22, 14, 32),
  });

  return {
    controller,
    repository,
    service,
    states,
    downloads,
    world: () => world,
    last: () => states[states.length - 1] ?? controller.getState(),
  };
}

describe('saving', () => {
  it('writes a slot and says so', async () => {
    const h = harness();
    await h.controller.saveNew('Copper outpost');

    expect(h.last().status).toBe('Saved "Copper outpost".');
    expect(h.last().tone).toBe('info');
    expect(h.last().slots.map((slot) => slot.name)).toEqual(['Copper outpost']);
  });

  it('marks the slot it just wrote as the one being played', async () => {
    const h = harness();
    await h.controller.saveNew('Mine');
    const [slot] = h.last().slots;
    expect(h.last().currentId).toBe(slot?.id);
  });

  it('gives every manual save its own key, so none overwrites another', async () => {
    const h = harness();
    await h.controller.saveNew('One');
    await h.controller.saveNew('One');
    expect(h.last().slots.length).toBe(2);
  });

  it('holds every button while a write is in flight', async () => {
    const h = harness();
    const pending = h.controller.saveNew('Slow');
    expect(h.last().busy).toBe(true);
    await pending;
    expect(h.last().busy).toBe(false);
  });

  it('refuses to write over an autosave slot', async () => {
    const h = harness();
    await h.controller.overwrite('auto-2', 'Mine');
    // §14's rotation never overwrites a manual save; a manual save dropped
    // into the rotation is the same mistake facing the other way.
    expect(h.last().status).toContain('autosave slot');
    expect(h.last().tone).toBe('warn');
    expect(h.last().slots).toEqual([]);
  });

  it('writes over a manual slot in place', async () => {
    const h = harness();
    await h.controller.saveNew('First');
    const id = h.last().slots[0]?.id ?? '';

    await h.controller.overwrite(id, 'First, again');
    expect(h.last().slots.length).toBe(1);
    expect(h.last().slots[0]?.name).toBe('First, again');
  });

  it('turns a quota failure into the sentence that names the way out', async () => {
    const h = harness();
    await h.controller.saveNew('Good');
    h.repository.failWrites = new SaveError('quota', 'full');

    await h.controller.saveNew('Doomed');
    expect(h.last().tone).toBe('error');
    expect(h.last().status).toContain('Out of storage space');
    expect(h.last().status).toContain('export');
    // The existing save is still listed, which is half of what makes that
    // sentence true.
    expect(h.last().slots.map((slot) => slot.name)).toEqual(['Good']);
  });

  it('resets the autosave interval after a manual save', async () => {
    const autosave = new Autosave({ write: async () => undefined });
    const repository = new MemorySaveRepository();
    const service = new SaveService({ repository });
    const world = sampleSimulation();
    const controller = new SaveController({
      service,
      autosave,
      capture: () => ({ state: serialize(world), playtimeTicks: world.getTick(), hotbar: null }),
      apply: () => undefined,
      onChange: () => undefined,
    });

    autosave.update(100_000);
    await controller.saveNew('Fresh');
    expect(autosave.remainingMs()).toBe(180_000);
  });
});

describe('loading', () => {
  it('replaces the running world', async () => {
    const h = harness();
    await h.controller.saveNew('Before');
    const id = h.last().slots[0]?.id ?? '';
    const before = h.world();

    await h.controller.load(id);

    expect(h.world()).not.toBe(before);
    expect(serialize(h.world())).toEqual(serialize(before));
    expect(h.last().status).toBe('Loaded "Before".');
    expect(h.last().currentId).toBe(id);
  });

  it('refuses a slot that is not there, and refreshes the list', async () => {
    const h = harness();
    await h.controller.load('ghost');
    expect(h.last().status).toContain('no longer there');
    expect(h.last().tone).toBe('error');
  });

  it('keeps the running game when a save decodes but will not open', async () => {
    const repository = new MemorySaveRepository();
    const service = new SaveService({ repository });
    const world = sampleSimulation();
    const states: SaveSessionState[] = [];
    const controller = new SaveController({
      service,
      capture: () => ({ state: serialize(world), playtimeTicks: world.getTick(), hotbar: null }),
      // What `deserialize` does for a save from a foreign world generator.
      apply: () => {
        throw new Error('this save was written by world generator 99');
      },
      onChange: (state) => states.push(state),
    });

    await controller.saveNew('Foreign');
    const id = controller.getState().slots[0]?.id ?? '';
    await controller.load(id);

    const last = states[states.length - 1];
    expect(last?.tone).toBe('error');
    expect(last?.status).toContain('world generator 99');
    expect(last?.busy).toBe(false);
  });

  it('refuses a corrupt blob and leaves it in the list', async () => {
    const h = harness();
    await h.controller.saveNew('Damaged');
    const id = h.last().slots[0]?.id ?? '';
    h.repository.poison(id, new TextEncoder().encode('nonsense'));

    await h.controller.load(id);
    expect(h.last().status).toContain('kept, not deleted');
    expect(h.last().slots.map((slot) => slot.id)).toEqual([id]);
  });
});

describe('deleting and renaming', () => {
  it('deletes a slot and forgets it was the current one', async () => {
    const h = harness();
    await h.controller.saveNew('Gone');
    const id = h.last().slots[0]?.id ?? '';

    await h.controller.remove(id);
    expect(h.last().slots).toEqual([]);
    expect(h.last().currentId).toBeNull();
  });

  it('renames without rewriting the factory', async () => {
    const h = harness();
    await h.controller.saveNew('Old name');
    const id = h.last().slots[0]?.id ?? '';
    const bytesBefore = h.last().slots[0]?.bytes ?? 0;

    await h.controller.rename(id, 'New name');
    expect(h.last().slots[0]?.name).toBe('New name');
    expect(h.last().slots[0]?.bytes).toBe(bytesBefore);
  });

  it('gives an unnamed save a name rather than an empty string', async () => {
    const h = harness();
    await h.controller.saveNew('x');
    const id = h.last().slots[0]?.id ?? '';
    await h.controller.rename(id, '   ');
    expect(h.last().slots[0]?.name).toBe('Untitled');
  });
});

describe('the multi-tab lock', () => {
  it('lets the writing tab write', async () => {
    const h = harness({ lock: new TabLock({ channel: null }) });
    await h.controller.saveNew('Fine');
    expect(h.last().canWrite).toBe(true);
    expect(h.last().offerTakeOver).toBe(false);
    expect(h.last().slots.length).toBe(1);
  });

  it('refuses the second tab, visibly, and offers the way out', async () => {
    // The lock's own behaviour is `tab-lock.test.ts`'s; what is under test
    // here is what the *save flow* does with the answer, so the answer is
    // stubbed to the two questions the service asks.
    const stub = {
      isPrimary: () => false,
      ready: async () => 'secondary' as const,
      takeOver: () => undefined,
      close: () => undefined,
    } as unknown as TabLock;

    const h = harness({ lock: stub });
    await h.controller.saveNew('Refused');

    expect(h.last().canWrite).toBe(false);
    expect(h.last().offerTakeOver).toBe(true);
    expect(h.last().status).toContain('Another tab');
    expect(h.last().slots).toEqual([]);
  });
});

describe('the standing warning', () => {
  it('is what the menu says before anything has happened', () => {
    const h = harness({ warning: 'Storage is unavailable — private browsing blocks it.' });
    expect(h.controller.getState().status).toContain('private browsing');
    expect(h.controller.getState().tone).toBe('warn');
  });
});


/* -------------------------------------------------------------------------- *
 * C26
 * -------------------------------------------------------------------------- */

describe('exporting', () => {
  it('hands the player a named file for the slot they picked', async () => {
    const h = harness();
    await h.controller.saveNew('Copper outpost');
    const id = h.last().slots[0]?.id ?? '';

    await h.controller.exportSlot(id);

    expect(h.downloads).toHaveLength(1);
    expect(h.downloads[0]?.filename).toBe('ironflow-save-copper-outpost-2026-09-22-1432.ifsave');
    expect(h.last().status).toBe('Exported "Copper outpost".');
    expect((await decodeSaveFile(h.downloads[0]?.bytes ?? new Uint8Array(0))).metadata.name).toBe('Copper outpost');
  });

  it('exports the name the player sees, not the one the body was written under', async () => {
    const h = harness();
    await h.controller.saveNew('Old name');
    const id = h.last().slots[0]?.id ?? '';
    await h.controller.rename(id, 'New name');

    await h.controller.exportSlot(id);
    expect((await decodeSaveFile(h.downloads[0]?.bytes ?? new Uint8Array(0))).metadata.name).toBe('New name');
  });

  it('exports the running game when nothing is stored at all', async () => {
    // §14's first row: with no IndexedDB there is no slot to pick, and this
    // is the whole of how a factory survives that session.
    const h = harness({ start: factorySimulation() });
    await h.controller.exportCurrent('Unstored');

    expect(h.last().slots).toEqual([]);
    expect(h.downloads[0]?.filename).toMatch(/^ironflow-save-unstored-/);
    const file = await decodeSaveFile(h.downloads[0]?.bytes ?? new Uint8Array(0));
    expect(file.state.entities.length).toBe(h.world().entities.size);
  });

  it('gets the bytes of an unreadable save out rather than losing them', async () => {
    // §14: "refuse and keep the corrupt blob for export rather than deleting
    // it." This is the export that promise was made for.
    const h = harness();
    await h.controller.saveNew('Doomed');
    const id = h.last().slots[0]?.id ?? '';
    h.repository.poison(id, new TextEncoder().encode('not a save at all'));

    await h.controller.exportSlot(id);

    expect(h.downloads).toHaveLength(1);
    expect(h.last().tone).toBe('warn');
    expect(h.last().status).toMatch(/could not be read/);
    // Wrapped in a header, so what left the browser says what it claims to be
    // — and is still refused on the way back in.
    await expect(decodeSaveFile(h.downloads[0]?.bytes ?? new Uint8Array(0))).rejects.toThrow(SaveError);
  });

  it('says so when there is nothing to export a file with', async () => {
    const repository = new MemorySaveRepository();
    const service = new SaveService({ repository });
    const world = sampleSimulation();
    const states: SaveSessionState[] = [];
    const controller = new SaveController({
      service,
      capture: () => ({ state: serialize(world), playtimeTicks: world.getTick(), hotbar: null }),
      apply: () => undefined,
      onChange: (state) => states.push(state),
    });

    await controller.exportCurrent('Nowhere');
    expect(states[states.length - 1]?.tone).toBe('error');
  });
});

describe('importing', () => {
  async function fileOf(name = 'Imported', simulation = factorySimulation()): Promise<Blob> {
    return new Blob([await encodeSaveFile(sampleSave(name, simulation))]);
  }

  it('plays the factory in the file and stores it', async () => {
    const source = factorySimulation(31);
    const h = harness();
    await h.controller.importFile(await fileOf('From a friend', source), 'from-a-friend.ifsave');

    expect(h.last().status).toBe('Imported "From a friend".');
    expect(hashState(h.world())).toBe(hashState(source));
    expect(h.last().slots.map((slot) => slot.name)).toEqual(['From a friend']);
    expect(h.last().currentId).toBe(h.last().slots[0]?.id);
  });

  it('refuses a file that is not a save, and says why, changing nothing', async () => {
    const h = harness();
    const before = hashState(h.world());

    await h.controller.importFile(new Blob([new TextEncoder().encode('hello')]), 'notes.txt');

    expect(h.last().tone).toBe('error');
    expect(h.last().status).toMatch(/not imported/);
    expect(hashState(h.world())).toBe(before);
    expect(h.last().slots).toEqual([]);
  });

  it('lists the reason the validator gave rather than shrugging', async () => {
    const spoiled = JSON.parse(JSON.stringify(sampleSave('Spoiled', factorySimulation())));
    spoiled.state.research.queue = ['time_travel'];
    const h = harness();

    await h.controller.importFile(new Blob([await encodeSaveFile(spoiled)]), 'spoiled.ifsave');
    expect(h.last().status).toMatch(/time_travel/);
  });

  it('keeps the imported factory even when it cannot be stored', async () => {
    const source = factorySimulation(7);
    const h = harness();
    h.repository.failWrites = new SaveError('quota', 'No room.');

    await h.controller.importFile(await fileOf('Too big', source), 'too-big.ifsave');

    // The world is the imported one; only the slot was lost, and the message
    // says which of the two happened.
    expect(hashState(h.world())).toBe(hashState(source));
    expect(h.last().tone).toBe('warn');
    expect(h.last().status).toMatch(/could not be stored/);
  });

  it('names an imported factory after the file when the save has no name', async () => {
    const nameless = sampleSave('', factorySimulation());
    const h = harness();
    await h.controller.importFile(new Blob([await encodeSaveFile(nameless)]), 'rusty-outpost.ifsave');
    expect(h.last().status).toBe('Imported "rusty-outpost".');
  });
});
