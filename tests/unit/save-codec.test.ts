import { afterEach, describe, expect, it, vi } from 'vitest';

import { SAVE_FORMAT, SAVE_VERSION } from '../../src/game/save/save-format.js';
import {
  MAX_DECODED_BYTES,
  compressionAvailable,
  decodeSave,
  encodeSave,
  type SaveBytes,
} from '../../src/persistence/save-codec.js';
import { SaveError } from '../../src/persistence/save-repository.js';

import { largeSimulation, sampleSave } from '../fixtures/saves.js';

/**
 * Bytes in and bytes out. C25 task 3.
 *
 * > Store the state as a compressed blob using `CompressionStream('gzip')`
 * > where available, with an uncompressed fallback and a flag in the metadata.
 *
 * Three things have to hold and each has a test here: gzip is used when it
 * exists, the fallback produces a *readable* save rather than a smaller
 * disaster, and the flag says which of the two happened — because a save
 * written on a browser without gzip is read on one with it.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function bytesOf(text: string): SaveBytes {
  return new TextEncoder().encode(text);
}

describe('encodeSave', () => {
  it('gzips where the browser can, and says so', async () => {
    expect(compressionAvailable()).toBe(true);
    const encoded = await encodeSave(sampleSave());
    expect(encoded.compressed).toBe(true);
    // The gzip magic. Not relied on for reading — see the header of
    // `save-codec.ts` on why the flag is stored — but a useful assurance that
    // what went in is what came out.
    expect([encoded.bytes[0], encoded.bytes[1]]).toEqual([0x1f, 0x8b]);
  });

  it('is much smaller than the JSON a real factory produces', async () => {
    const save = sampleSave('Four hundred belts', largeSimulation());
    const plain = new TextEncoder().encode(JSON.stringify(save)).byteLength;
    const encoded = await encodeSave(save);
    expect(encoded.bytes.byteLength).toBeLessThan(plain / 2);
  });

  it('falls back to plain JSON where there is no CompressionStream', async () => {
    vi.stubGlobal('CompressionStream', undefined);
    expect(compressionAvailable()).toBe(false);

    const encoded = await encodeSave(sampleSave('Uncompressed'));
    expect(encoded.compressed).toBe(false);

    // Readable as JSON, which is the whole of what "fallback" has to mean.
    const text = new TextDecoder().decode(encoded.bytes);
    expect(JSON.parse(text).format).toBe(SAVE_FORMAT);
  });

  it('falls back when the constructor exists and then throws', async () => {
    vi.stubGlobal(
      'CompressionStream',
      class {
        constructor() {
          throw new Error('nope');
        }
      },
    );
    const encoded = await encodeSave(sampleSave());
    expect(encoded.compressed).toBe(false);
    expect(await decodeSave(encoded)).toMatchObject({ format: SAVE_FORMAT });
  });
});

describe('decodeSave', () => {
  it('round-trips a compressed save unchanged', async () => {
    const save = sampleSave('Round trip');
    const back = await decodeSave(await encodeSave(save));
    expect(back).toEqual(save);
  });

  it('round-trips an uncompressed one unchanged', async () => {
    const save = sampleSave('Round trip');
    vi.stubGlobal('CompressionStream', undefined);
    const encoded = await encodeSave(save);
    vi.unstubAllGlobals();
    expect(await decodeSave(encoded)).toEqual(save);
  });

  it('refuses bytes that are not JSON', async () => {
    await expect(decodeSave({ bytes: bytesOf('{not json'), compressed: false })).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('refuses a document without our header', async () => {
    const stranger = JSON.stringify({ format: 'someone-elses-save', version: 1, metadata: {}, state: {} });
    await expect(decodeSave({ bytes: bytesOf(stranger), compressed: false })).rejects.toMatchObject({
      code: 'corrupt',
    });
  });

  it('refuses a save from a newer schema, and says which', async () => {
    const future = JSON.stringify({ ...sampleSave(), version: SAVE_VERSION + 1 });
    const error = await decodeSave({ bytes: bytesOf(future), compressed: false }).catch((e: unknown) => e);
    // `unsupported`, not `corrupt`: the file is fine and this build is old,
    // which is a different sentence to the player and C27's problem, not this
    // module's.
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe('unsupported');
    expect((error as SaveError).message).toContain(String(SAVE_VERSION + 1));
  });

  it('refuses a save with no state', async () => {
    const empty = JSON.stringify({ format: SAVE_FORMAT, version: SAVE_VERSION, metadata: {} });
    await expect(decodeSave({ bytes: bytesOf(empty), compressed: false })).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('refuses to inflate a decompression bomb (C26 task 5)', async () => {
    // Half a gigabyte of zeroes gzips to a few hundred kilobytes; inflating it
    // is how a tab dies. The guard has to fire *during* the inflate, which is
    // why `transform` reads chunk by chunk rather than through a `Response`.
    const bomb = new Uint8Array(MAX_DECODED_BYTES + 1024);
    const stream = new Response(
      new Blob([bomb]).stream().pipeThrough(new CompressionStream('gzip')),
    );
    const packed = new Uint8Array(await stream.arrayBuffer());

    expect(packed.byteLength).toBeLessThan(1_000_000);
    await expect(decodeSave({ bytes: packed, compressed: true })).rejects.toMatchObject({ code: 'corrupt' });
  });

  it('says so rather than throwing a stream error when gzip is gone', async () => {
    const encoded = await encodeSave(sampleSave());
    vi.stubGlobal('DecompressionStream', undefined);
    await expect(decodeSave(encoded)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
