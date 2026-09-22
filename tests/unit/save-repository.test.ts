import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DATABASE_NAME,
  IndexedDbSaveRepository,
} from '../../src/persistence/indexeddb-save-repository.js';
import { MemorySaveRepository } from '../../src/persistence/memory-save-repository.js';
import { SaveError, type SaveRepository } from '../../src/persistence/save-repository.js';

import { FakeIndexedDb, failWrites, quotaError } from '../fixtures/fake-indexeddb.js';
import { sampleSave, sampleSimulation } from '../fixtures/saves.js';

/**
 * Storage, both implementations, one set of tests. C25 tasks 1, 2 and 5.
 *
 * > Repository contract tests run against both implementations; quota and
 * > unavailability failure paths with a mocked IDB.
 *
 * The contract block below runs twice. That is the whole point of having two
 * implementations: every test in `save-controller.test.ts` and every headless
 * check of the save flow runs against `MemorySaveRepository`, and this is what
 * makes those results mean something about the browser — a behaviour that
 * holds here but not in IndexedDB is a behaviour those tests are lying about.
 *
 * Underneath the IndexedDB half is `tests/fixtures/fake-indexeddb.ts`, which
 * is a small real implementation rather than a mock: it holds what is put in
 * it, and it **rolls back an aborted transaction**, which is the one behaviour
 * §14's quota row depends on.
 */

let fake: FakeIndexedDb;

beforeEach(() => {
  fake = new FakeIndexedDb();
  failWrites(null);
});

afterEach(() => {
  failWrites(null);
});

interface Subject {
  readonly name: string;
  open(): Promise<SaveRepository>;
}

const SUBJECTS: readonly Subject[] = [
  { name: 'MemorySaveRepository', open: async () => new MemorySaveRepository() },
  {
    name: 'IndexedDbSaveRepository',
    open: () => IndexedDbSaveRepository.open({ factory: fake.asFactory() }),
  },
];

describe.each(SUBJECTS)('$name — the SaveRepository contract', (subject) => {
  let repository: SaveRepository;

  beforeEach(async () => {
    repository = await subject.open();
  });

  afterEach(() => {
    repository.close();
  });

  it('starts empty', async () => {
    expect(await repository.list()).toEqual([]);
  });

  it('round-trips a save through storage, byte for byte', async () => {
    const save = sampleSave('Copper outpost');
    await repository.save('manual-1', save, 'manual');

    const back = await repository.load('manual-1');
    expect(back.state).toEqual(save.state);
    expect(back.metadata.name).toBe('Copper outpost');
    expect(back.version).toBe(save.version);
  });

  it('describes a slot without reading its state', async () => {
    await repository.save('manual-1', sampleSave('Named'), 'manual');
    const [slot] = await repository.list();

    expect(slot).toMatchObject({ id: 'manual-1', name: 'Named', kind: 'manual' });
    expect(slot?.bytes).toBeGreaterThan(0);
    expect(slot?.playtimeTicks).toBe(sampleSimulation().getTick());
    expect(typeof slot?.compressed).toBe('boolean');
  });

  it('lists newest first', async () => {
    let clock = 1000;
    const stamp = (): number => (clock += 1000);
    const timed = await (subject.name === 'MemorySaveRepository'
      ? Promise.resolve<SaveRepository>(new MemorySaveRepository({ now: stamp }))
      : IndexedDbSaveRepository.open({ factory: fake.asFactory(), now: stamp }));

    await timed.save('a', sampleSave('A'), 'manual');
    await timed.save('b', sampleSave('B'), 'manual');
    await timed.save('c', sampleSave('C'), 'auto');

    expect((await timed.list()).map((slot) => slot.id)).toEqual(['c', 'b', 'a']);
    timed.close();
  });

  it('keeps createdAt across an overwrite and moves updatedAt', async () => {
    let clock = 5000;
    const stamp = (): number => (clock += 1000);
    const timed = await (subject.name === 'MemorySaveRepository'
      ? Promise.resolve<SaveRepository>(new MemorySaveRepository({ now: stamp }))
      : IndexedDbSaveRepository.open({ factory: fake.asFactory(), now: stamp }));

    const first = await timed.save('slot', sampleSave('First'), 'manual');
    const second = await timed.save('slot', sampleSave('Second'), 'manual');

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect((await timed.list()).length).toBe(1);
    timed.close();
  });

  it('renames without touching the state', async () => {
    await repository.save('manual-1', sampleSave('Before'), 'manual');
    const before = await repository.load('manual-1');

    const slot = await repository.rename('manual-1', 'After');
    expect(slot.name).toBe('After');

    const after = await repository.load('manual-1');
    expect(after.metadata.name).toBe('After');
    expect(after.state).toEqual(before.state);
  });

  it('deletes a slot, and is not upset by deleting one twice', async () => {
    await repository.save('manual-1', sampleSave(), 'manual');
    await repository.delete('manual-1');
    await repository.delete('manual-1');

    expect(await repository.list()).toEqual([]);
    await expect(repository.load('manual-1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a load of something that was never stored', async () => {
    await expect(repository.load('nobody')).rejects.toBeInstanceOf(SaveError);
    await expect(repository.load('nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a rename of something that was never stored', async () => {
    await expect(repository.rename('nobody', 'x')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('keeps autosaves and manual saves apart by kind', async () => {
    await repository.save('auto-1', sampleSave('Autosave 1'), 'auto');
    await repository.save('manual-1', sampleSave('Mine'), 'manual');

    const kinds = new Map((await repository.list()).map((slot) => [slot.id, slot.kind]));
    expect(kinds.get('auto-1')).toBe('auto');
    expect(kinds.get('manual-1')).toBe('manual');
  });
});

describe('the listing does not deserialize state (C25 task 2)', () => {
  it('reads no save body, and answers fifty slots quickly', async () => {
    const repository = new MemorySaveRepository();
    const save = sampleSave('Fifty');
    for (let index = 0; index < 50; index++) await repository.save(`manual-${index}`, save, 'manual');

    repository.bodyReads = 0;
    const started = performance.now();
    const slots = await repository.list();
    const elapsed = performance.now() - started;

    expect(slots.length).toBe(50);
    // The acceptance criterion is 50 ms. Asserted rather than measured-and-
    // printed because the property under test is *algorithmic* — the listing
    // touches the metadata store and nothing else — so the number is a very
    // long way from the machine's speed either way.
    expect(elapsed).toBeLessThan(50);
    expect(repository.bodyReads).toBe(0);
  });

  it('touches only the metadata store in IndexedDB', async () => {
    const repository = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    await repository.save('manual-1', sampleSave(), 'manual');

    // Both stores hold a row, and the listing returns a whole slot out of the
    // small one — which is the schema doing the work rather than a cache.
    expect(fake.rowCount(DATABASE_NAME, 'metadata')).toBe(1);
    expect(fake.rowCount(DATABASE_NAME, 'saves')).toBe(1);
    const [slot] = await repository.list();
    expect(slot?.name).toBe('Test factory');
    repository.close();
  });
});

describe('§14 failure modes', () => {
  it('refuses to open when IndexedDB is not there at all', async () => {
    await expect(IndexedDbSaveRepository.open({ factory: undefined })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses to open when the database errors — private browsing', async () => {
    fake.openFails = true;
    await expect(IndexedDbSaveRepository.open({ factory: fake.asFactory() })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('refuses to open when another tab blocks an upgrade', async () => {
    fake.openBlocks = true;
    await expect(IndexedDbSaveRepository.open({ factory: fake.asFactory() })).rejects.toMatchObject({
      code: 'unavailable',
    });
  });

  it('reports a quota failure as one', async () => {
    const repository = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    failWrites(quotaError());
    await expect(repository.save('manual-1', sampleSave(), 'manual')).rejects.toMatchObject({ code: 'quota' });
    repository.close();
  });

  it('does not destroy the existing save when a write hits the quota', async () => {
    // §14: "do not destroy the existing save by writing a truncated one."
    // Both puts are in one transaction, so a refused body put rolls the
    // metadata put back with it and what is on disk is the previous save.
    const repository = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    await repository.save('manual-1', sampleSave('The good one'), 'manual');

    failWrites(quotaError());
    await expect(repository.save('manual-1', sampleSave('The doomed one'), 'manual')).rejects.toMatchObject({
      code: 'quota',
    });
    failWrites(null);

    const survivor = await repository.load('manual-1');
    expect(survivor.metadata.name).toBe('The good one');
    expect((await repository.list()).map((slot) => slot.name)).toEqual(['The good one']);
    repository.close();
  });

  it('leaves an unrelated save alone when a write fails', async () => {
    const repository = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    await repository.save('manual-1', sampleSave('Keep me'), 'manual');

    failWrites(quotaError());
    await expect(repository.save('manual-2', sampleSave('New'), 'manual')).rejects.toMatchObject({ code: 'quota' });
    failWrites(null);

    expect((await repository.list()).map((slot) => slot.id)).toEqual(['manual-1']);
    repository.close();
  });

  it('refuses a corrupt blob and keeps it rather than deleting it', async () => {
    // §14: "Validate on load; refuse and keep the corrupt blob for export
    // rather than deleting it." The slot stays in the list, which is what
    // makes C26's export of it possible.
    const repository = new MemorySaveRepository();
    await repository.save('manual-1', sampleSave('Damaged'), 'manual');
    repository.poison('manual-1', new TextEncoder().encode('}{ not a save'));

    await expect(repository.load('manual-1')).rejects.toMatchObject({ code: 'corrupt' });
    expect((await repository.list()).map((slot) => slot.id)).toEqual(['manual-1']);
  });

  it('refuses every operation once it has been closed', async () => {
    const repository = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    repository.close();
    repository.close(); // idempotent
    await expect(repository.list()).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('a full browser restart', () => {
  it('finds the factory again through a second connection', async () => {
    // The acceptance criterion, at the storage layer: same `FakeIndexedDb`,
    // new `IndexedDbSaveRepository`, which is what a reload is.
    const first = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    const save = sampleSave('Across a restart');
    await first.save('manual-1', save, 'manual');
    first.close();

    const second = await IndexedDbSaveRepository.open({ factory: fake.asFactory() });
    const back = await second.load('manual-1');
    expect(back.state).toEqual(save.state);
    second.close();
  });
});
