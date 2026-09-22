import { describe, expect, it } from 'vitest';

import { SAVE_VERSION } from '../../src/game/save/save-format.js';
import { deserialize } from '../../src/game/save/save-serializer.js';
import {
  MAX_SAVE_FILE_BYTES,
  SAVE_FILE_EXTENSION,
  SAVE_FILE_MAGIC,
  decodeSaveFile,
  encodeSaveFile,
  readSaveFile,
  saveFileName,
  wrapSaveBytes,
} from '../../src/persistence/export-import.js';
import { SaveError } from '../../src/persistence/save-repository.js';

import { hashState } from '../determinism/state-hash.js';
import { factorySimulation, sampleSave } from '../fixtures/saves.js';
import { createPlaygroundGenerator } from '../fixtures/world-fixtures.js';

/**
 * A factory leaving the browser and coming back. C26 tasks 1, 2 and 5.
 *
 * > A save exported on one browser imports on another and continues
 * > correctly.
 *
 * "Another browser" is not something a test can have, so what is checked is
 * the thing that makes it true: the file is self-describing — magic, schema
 * version and encoding in plain bytes — and what comes back out of it hashes
 * identically to the world that went in (§6 R8's comparison, one layer up).
 */

const GENERATOR = createPlaygroundGenerator();

function header(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0x0a)));
}

describe('the envelope', () => {
  it('puts the magic and the schema version in plain sight', async () => {
    const bytes = await encodeSaveFile(sampleSave('Header'));
    expect(header(bytes)).toBe(`${SAVE_FILE_MAGIC} v${SAVE_VERSION} gzip`);
  });

  it('says which encoding it used, rather than leaving it to be sniffed', async () => {
    const raw = wrapSaveBytes(new TextEncoder().encode('{}'), false, SAVE_VERSION);
    expect(header(raw)).toBe(`${SAVE_FILE_MAGIC} v${SAVE_VERSION} json`);
  });

  it('round-trips a save unchanged', async () => {
    const save = sampleSave('Round trip', factorySimulation());
    expect(await decodeSaveFile(await encodeSaveFile(save))).toEqual(save);
  });

  it('carries a factory across without moving a single value', async () => {
    const before = factorySimulation(19);
    const bytes = await encodeSaveFile(sampleSave('Portable', before));

    const file = await decodeSaveFile(bytes);
    const after = deserialize(file.state, { worldGenerator: () => GENERATOR });

    expect(hashState(after)).toBe(hashState(before));
  });

  it('continues correctly once imported', async () => {
    const before = factorySimulation(23);
    const file = await decodeSaveFile(await encodeSaveFile(sampleSave('Continues', before)));
    const after = deserialize(file.state, { worldGenerator: () => GENERATOR });

    // §6 R8: a loaded world and the world it was saved from tick the same.
    for (let tick = 0; tick < 120; tick++) {
      before.tick();
      after.tick();
    }
    expect(hashState(after)).toBe(hashState(before));
  });

  it('is much smaller than the JSON it carries', async () => {
    const save = sampleSave('Compressed', factorySimulation());
    const plain = new TextEncoder().encode(JSON.stringify(save)).byteLength;
    expect((await encodeSaveFile(save)).byteLength).toBeLessThan(plain);
  });
});

describe('a file that is not one of ours', () => {
  async function refuse(bytes: Uint8Array): Promise<SaveError> {
    try {
      await decodeSaveFile(bytes);
    } catch (error) {
      if (error instanceof SaveError) return error;
      throw error;
    }
    throw new Error('the file was accepted.');
  }

  it('refuses a file with no header at all', async () => {
    const error = await refuse(new TextEncoder().encode('{"format":"ironflow-save"}'));
    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/no IRONFLOW-SAVE header/);
  });

  it('refuses a truncated file', async () => {
    const bytes = await encodeSaveFile(sampleSave('Truncated', factorySimulation()));
    const error = await refuse(bytes.slice(0, Math.floor(bytes.byteLength / 2)));
    expect(error.code).toBe('corrupt');
  });

  it('refuses an empty file', async () => {
    expect((await refuse(new Uint8Array(0))).code).toBe('corrupt');
  });

  it('refuses a header from a future schema version', async () => {
    const bytes = await encodeSaveFile(sampleSave('Future'));
    const error = await refuse(wrapSaveBytes(bytes.subarray(bytes.indexOf(0x0a) + 1), true, SAVE_VERSION + 1));
    expect(error.code).toBe('unsupported');
  });

  it('refuses a header whose version disagrees with the save inside it', async () => {
    // The one thing two copies of a number buy: a file edited to look older
    // than it is cannot sneak past a migration that has not been written.
    const save = { ...sampleSave('Lying'), version: SAVE_VERSION };
    const bytes = await encodeSaveFile(save);
    const payload = bytes.subarray(bytes.indexOf(0x0a) + 1);
    const error = await refuse(wrapSaveBytes(payload, true, SAVE_VERSION + 1));
    // Refused for being from the future, before the mismatch is even reached.
    expect(error.code).toBe('unsupported');
  });

  it('refuses an encoding it does not write', async () => {
    const bytes = await encodeSaveFile(sampleSave('Brotli'));
    const payload = bytes.subarray(bytes.indexOf(0x0a) + 1);
    const header = new TextEncoder().encode(`${SAVE_FILE_MAGIC} v${SAVE_VERSION} brotli\n`);
    const forged = new Uint8Array(header.byteLength + payload.byteLength);
    forged.set(header, 0);
    forged.set(payload, header.byteLength);
    expect((await refuse(forged)).message).toMatch(/"brotli"/);
  });

  it('refuses a file larger than the cap before reading it', async () => {
    const blob = { size: MAX_SAVE_FILE_BYTES + 1, arrayBuffer: () => Promise.reject(new Error('never read')) };
    await expect(readSaveFile(blob as unknown as Blob)).rejects.toThrow(/limit is/);
  });

  it('refuses a save whose contents are invalid, with the reason', async () => {
    const save = sampleSave('Invalid', factorySimulation());
    const spoiled = JSON.parse(JSON.stringify(save));
    spoiled.state.research.queue = ['time_travel'];
    const error = await refuse(await encodeSaveFile(spoiled));
    expect(error.code).toBe('corrupt');
    expect(error.message).toMatch(/time_travel/);
  });
});

describe('a Blob from the file picker', () => {
  it('reads and validates one', async () => {
    const save = sampleSave('From disk', factorySimulation());
    const blob = new Blob([await encodeSaveFile(save)]);
    expect(await readSaveFile(blob)).toEqual(save);
  });
});

describe('the file name', () => {
  it('is the shape C26 asks for', () => {
    expect(saveFileName('Copper outpost', Date.UTC(2026, 8, 22, 14, 32))).toBe(
      `ironflow-save-copper-outpost-2026-09-22-1432${SAVE_FILE_EXTENSION}`,
    );
  });

  it('never lets a save name become a path', () => {
    expect(saveFileName('../../etc/passwd', 0)).toBe(`ironflow-save-etc-passwd-1970-01-01-0000${SAVE_FILE_EXTENSION}`);
    expect(saveFileName('  ', 0)).toMatch(/^ironflow-save-factory-/);
    expect(saveFileName('💥', 0)).toMatch(/^ironflow-save-factory-/);
  });

  it('caps a name somebody pasted an essay into', () => {
    expect(saveFileName('x'.repeat(500), 0).length).toBeLessThan(80);
  });
});
