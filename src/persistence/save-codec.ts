/**
 * A save file to bytes, and back. See ironflow.md C25 task 3.
 *
 * > Store the state as a compressed blob using `CompressionStream('gzip')`
 * > where available, with an uncompressed fallback and a flag in the metadata.
 *
 * Both repositories go through here, so the memory one that the tests run
 * against stores exactly what the browser one stores — the same bytes, through
 * the same `JSON.stringify`, with the same flag. A test double that kept live
 * objects would pass every round-trip test and prove nothing about the thing
 * that actually has to work.
 *
 * ## Why the flag is stored and not inferred
 *
 * `CompressionStream` is missing from older Safari and from a few hardened
 * browser configurations, so a save can be written uncompressed on one machine
 * and read on another where gzip exists. Sniffing the two-byte gzip magic
 * would *usually* work and would be wrong for the save whose first two JSON
 * bytes happened to match. The flag is one boolean per slot and it removes the
 * question.
 *
 * ## The size cap
 *
 * Decompression is the one operation here whose output size is chosen by the
 * input rather than by us, which is C26 task 5's decompression bomb. The cap
 * lives here rather than in C26's validator because this is the function that
 * allocates the memory: a validator that runs after the allocation is a
 * validator that runs after the tab has died. C26 still owns the *content*
 * validation — this only bounds the bytes.
 */

import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../game/save/save-format.js';

import { SaveError, asSaveError } from './save-repository.js';

/** Refuse to inflate more than this. C26 task 5 names 64 MB; §12 budgets 2. */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * Bytes over a plain `ArrayBuffer`.
 *
 * Spelled out rather than left as `Uint8Array`, whose buffer may be a
 * `SharedArrayBuffer`: the gzip streams take a `BufferSource`, which a shared
 * one is not, so the distinction is the difference between a type error here
 * and a runtime one in a browser with cross-origin isolation turned on.
 */
export type SaveBytes = Uint8Array<ArrayBuffer>;

/** Stored bytes plus the one fact needed to read them back. */
export interface EncodedSave {
  readonly bytes: SaveBytes;
  readonly compressed: boolean;
}

/** Does this environment have gzip streams? Feature-detected per call, not cached. */
export function compressionAvailable(): boolean {
  return typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';
}

/**
 * A save file as bytes: UTF-8 JSON, gzipped when the browser can.
 *
 * `JSON.stringify` rather than `structuredClone` into the store, deliberately:
 * §14's rule is that the persisted form is JSON, and a record cloned into
 * IndexedDB would silently keep a `Map` or an `undefined` that the exported
 * file (C26) would then lose. One representation, one set of bugs.
 */
export async function encodeSave(file: SaveFile): Promise<EncodedSave> {
  const json = new TextEncoder().encode(JSON.stringify(file));
  if (!compressionAvailable()) return { bytes: json, compressed: false };
  try {
    return { bytes: await transform(json, new CompressionStream('gzip'), MAX_DECODED_BYTES), compressed: true };
  } catch (cause) {
    // A browser that advertises the constructor and then fails is not worth a
    // lost factory: fall back to the bytes we already have. The flag is what
    // makes that a decision the reader can act on rather than a guess.
    void cause;
    return { bytes: json, compressed: false };
  }
}

/**
 * Bytes back into a save file, with the header checked before anything else.
 *
 * The two header checks are not C26's validator and do not pretend to be: they
 * are the difference between "this is not one of ours" and "this is one of
 * ours from the future", which are different messages to the player and
 * different answers from C27.
 */
export async function decodeSave(encoded: EncodedSave): Promise<SaveFile> {
  const raw = encoded.compressed ? await inflate(encoded.bytes) : encoded.bytes;
  if (raw.byteLength > MAX_DECODED_BYTES) {
    throw new SaveError('corrupt', `Save is larger than the ${MAX_DECODED_BYTES} byte limit.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new SaveError('corrupt', 'Save is not readable JSON.', { cause });
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SaveError('corrupt', 'Save is not an object.');
  }
  const file = parsed as Partial<SaveFile>;
  if (file.format !== SAVE_FORMAT) {
    throw new SaveError('corrupt', `Save is missing the "${SAVE_FORMAT}" header.`);
  }
  if (typeof file.version !== 'number' || !Number.isInteger(file.version) || file.version < 1) {
    throw new SaveError('corrupt', 'Save has no usable schema version.');
  }
  if (file.version > SAVE_VERSION) {
    throw new SaveError('unsupported', `Save is schema version ${file.version}; this build reads ${SAVE_VERSION}.`);
  }
  if (file.state === undefined || file.metadata === undefined) {
    throw new SaveError('corrupt', 'Save has no state or no metadata.');
  }
  return file as SaveFile;
}

/**
 * What `CompressionStream` and `DecompressionStream` have in common.
 *
 * Written out rather than `TransformStream<Uint8Array, Uint8Array>`, which
 * they are not: both accept a `BufferSource` on the way in, so the narrower
 * type refuses them. The one thing this has to promise is that what comes back
 * out is bytes.
 */
interface GzipStream {
  readonly readable: ReadableStream<SaveBytes>;
  readonly writable: WritableStream<BufferSource>;
}

/** Gunzip, refusing to allocate past the cap. */
async function inflate(bytes: SaveBytes): Promise<SaveBytes> {
  if (!compressionAvailable()) {
    throw new SaveError('unsupported', 'This save is compressed and this browser cannot decompress it.');
  }
  try {
    return await transform(bytes, new DecompressionStream('gzip'), MAX_DECODED_BYTES);
  } catch (cause) {
    if (cause instanceof SaveError) throw cause;
    throw asSaveError(cause, 'corrupt');
  }
}

/**
 * Push `bytes` through a transform stream and collect the result.
 *
 * Read chunk by chunk rather than through `new Response(stream).arrayBuffer()`
 * so the running total can be checked *while* it grows — which is the whole
 * point of a bomb guard. A `Response` would hand back the finished 8 GB.
 */
async function transform(bytes: SaveBytes, stream: GzipStream, limit: number): Promise<SaveBytes> {
  const writer = stream.writable.getWriter();
  // Not awaited: the writer's promises only settle once the reader below has
  // drained enough of the pipe, so awaiting here deadlocks on a large save.
  void writer.write(bytes).then(() => writer.close()).catch(() => undefined);

  const reader = stream.readable.getReader();
  const chunks: SaveBytes[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new SaveError('corrupt', `Save inflates past the ${limit} byte limit.`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
