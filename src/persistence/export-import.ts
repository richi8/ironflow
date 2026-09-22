/**
 * A factory as a file on disk. See ironflow.md C26 tasks 1, 2 and 5.
 *
 * ```text
 *   SaveFile ──encodeSaveFile──> IRONFLOW-SAVE v1 gzip\n<gzipped JSON>
 *                                              │
 *   SaveFile <──decodeSaveFile─────────────────┘   (validated on the way back)
 * ```
 *
 * This is §7's other door — the one §14 calls "imported file from a stranger"
 * — and everything that comes through it is treated as hostile: the envelope
 * is parsed a field at a time, the payload is inflated under a cap
 * (`save-codec.ts`), and the document inside is put through C26's validator
 * before a single value reaches the game. A file that fails any of those is a
 * message, never a partial load.
 *
 * ## The envelope, and why it is in plain sight
 *
 * C26 task 1: "gzipped JSON with a magic header and the schema version in
 * plain sight". One ASCII line, then bytes:
 *
 * ```text
 *   IRONFLOW-SAVE v1 gzip\n<payload>
 *   ^magic        ^schema ^encoding
 * ```
 *
 * A player who opens the file in a text editor — or a support request with
 * the first line pasted into it — can see what it is and what version it is
 * without a tool, which is the whole point of a magic header. It also carries
 * the **encoding flag** rather than leaving it to be sniffed, for the reason
 * `save-codec.ts` gives about the stored flag: a save written where
 * `CompressionStream` is missing travels to a browser where it exists, and
 * the gzip magic would be right almost always and wrong for the one file
 * whose first two JSON bytes matched.
 *
 * The version appears twice — once here and once inside the document — and a
 * disagreement between them is refused. They can only differ if somebody
 * edited one of them, and a file that lies about its own version is exactly
 * what a validator exists for.
 *
 * ## Why this file may touch the DOM
 *
 * §4 lets `persistence/**` reach browser storage and forbids it *rendering*.
 * A download is an anchor and an object URL and an import is a `File`; both
 * are browser plumbing rather than UI, and §4's own directory layout puts
 * `export-import.ts` here. The one screenful of DOM is kept in the three
 * functions at the bottom, none of which the codec or the envelope calls.
 */

import { SAVE_FORMAT, SAVE_VERSION, type SaveFile } from '../game/save/save-format.js';

import { decodeSave, encodeSave, type SaveBytes } from './save-codec.js';
import { SaveError, asSaveError } from './save-repository.js';

/** What an exported save is called. C26 task 1. */
export const SAVE_FILE_EXTENSION = '.ifsave';

/** The first token of every export. Task 3's "magic header". */
export const SAVE_FILE_MAGIC = 'IRONFLOW-SAVE';

/**
 * How many bytes of a chosen file we are willing to read at all.
 *
 * The same 64 MB `save-codec.ts` refuses to inflate past, applied one step
 * earlier: a decompression bomb is caught by that cap, and this one stops the
 * tab reading a two-gigabyte file into memory before anything has had a
 * chance to look at it.
 */
export const MAX_SAVE_FILE_BYTES = 64 * 1024 * 1024;

/** The header is one short line; anything longer is not one of ours. */
const MAX_HEADER_BYTES = 64;

/* -------------------------------------------------------------------------- *
 * The envelope
 * -------------------------------------------------------------------------- */

/** A save file as bytes a player can keep: header line, then the payload. */
export async function encodeSaveFile(file: SaveFile): Promise<SaveBytes> {
  const encoded = await encodeSave(file);
  return wrapSaveBytes(encoded.bytes, encoded.compressed, file.version);
}

/**
 * The envelope around bytes that are already encoded.
 *
 * Its own function because of the one caller that has bytes and *no* save: a
 * stored blob this build could not read. §14 keeps such a blob rather than
 * deleting it precisely so it can leave the browser, and re-encoding is not
 * available for a document nobody can parse. The file it produces is refused
 * on import, correctly — it is a bug report, not a factory.
 */
export function wrapSaveBytes(bytes: SaveBytes, compressed: boolean, version: number): SaveBytes {
  const header = new TextEncoder().encode(`${SAVE_FILE_MAGIC} v${version} ${compressed ? 'gzip' : 'json'}\n`);
  const out = new Uint8Array(header.byteLength + bytes.byteLength);
  out.set(header, 0);
  out.set(bytes, header.byteLength);
  return out;
}

/**
 * Bytes from disk back into a validated save, or a refusal that says why.
 *
 * Every `throw` here is a `SaveError`, because the caller's job is to turn one
 * into a sentence and `saveErrorMessage` already knows how (C25 task 5).
 */
export async function decodeSaveFile(bytes: Uint8Array): Promise<SaveFile> {
  if (bytes.byteLength > MAX_SAVE_FILE_BYTES) {
    throw new SaveError('corrupt', `That file is larger than the ${MAX_SAVE_FILE_BYTES} byte limit.`);
  }

  const newline = bytes.subarray(0, MAX_HEADER_BYTES).indexOf(0x0a);
  if (newline < 0) {
    throw new SaveError('corrupt', `That file has no ${SAVE_FILE_MAGIC} header; it is not an IronFlow save.`);
  }

  const header = new TextDecoder().decode(bytes.subarray(0, newline)).trim().split(' ');
  const [magic, version, encoding] = header;
  if (magic !== SAVE_FILE_MAGIC || header.length !== 3) {
    throw new SaveError('corrupt', `That file has no ${SAVE_FILE_MAGIC} header; it is not an IronFlow save.`);
  }

  const claimed = readHeaderVersion(version ?? '');
  if (claimed > SAVE_VERSION) {
    throw new SaveError('unsupported', `That save is schema version ${claimed}; this build reads ${SAVE_VERSION}.`);
  }
  if (encoding !== 'gzip' && encoding !== 'json') {
    throw new SaveError('corrupt', `That save says it is "${String(encoding)}" encoded, which is not something this build writes.`);
  }

  // Copied rather than shared with the caller's buffer: the decompression
  // streams take a `BufferSource`, and a subarray of somebody else's array is
  // a view they may still be writing into.
  const payload = new Uint8Array(bytes.subarray(newline + 1));
  const file = await decodeSave({ bytes: payload, compressed: encoding === 'gzip' });

  // The version in plain sight and the version inside have to agree; see the
  // file header on why a disagreement is refused rather than resolved.
  if (file.version !== claimed) {
    throw new SaveError('corrupt', `That file says it is version ${claimed} and the save inside it says ${file.version}.`);
  }
  if (file.format !== SAVE_FORMAT) {
    throw new SaveError('corrupt', `That file is not an ${SAVE_FORMAT} document.`);
  }
  return file;
}

function readHeaderVersion(token: string): number {
  const digits = token.startsWith('v') ? token.slice(1) : '';
  const version = Number(digits);
  if (digits === '' || !Number.isInteger(version) || version < 1) {
    throw new SaveError('corrupt', `That file's header says version "${token}", which is not one.`);
  }
  return version;
}

/* -------------------------------------------------------------------------- *
 * Naming
 * -------------------------------------------------------------------------- */

/**
 * `ironflow-save-<name>-<timestamp>.ifsave`, as task 1 spells it.
 *
 * The name is slugged rather than quoted: a save called `../../etc/passwd` or
 * one with a colon in it is a filename the operating system will either refuse
 * or misplace, and a download the player cannot find is a lost factory by
 * another route. The timestamp is the file's own, so two exports of the same
 * factory sort next to each other and never overwrite one another.
 */
export function saveFileName(name: string, at: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `ironflow-save-${slug === '' ? 'factory' : slug}-${timestamp(at)}${SAVE_FILE_EXTENSION}`;
}

/** `2026-09-22-1432`: sortable, filename-safe, and no locale in it. */
function timestamp(at: number): string {
  const when = Number.isFinite(at) ? new Date(at) : new Date(0);
  const iso = when.toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

/* -------------------------------------------------------------------------- *
 * The browser
 * -------------------------------------------------------------------------- */

/** Where a download and a drop reach the browser. Injected, so tests need none. */
export interface FileBridge {
  readonly document?: Document;
  readonly createObjectURL?: (blob: Blob) => string;
  readonly revokeObjectURL?: (url: string) => void;
}

/**
 * Hand the player a file. C26 task 1's "download via an object URL".
 *
 * An anchor with a `download` attribute rather than a `Blob:` navigation,
 * because the navigation replaces the page in some browsers — which in this
 * game would mean losing the factory the player was trying to keep.
 */
export function downloadSaveFile(bytes: SaveBytes, filename: string, bridge: FileBridge = {}): void {
  const doc = bridge.document ?? (typeof document === 'undefined' ? undefined : document);
  const createObjectURL = bridge.createObjectURL ?? URL.createObjectURL?.bind(URL);
  const revokeObjectURL = bridge.revokeObjectURL ?? URL.revokeObjectURL?.bind(URL);
  if (doc === undefined || createObjectURL === undefined) {
    throw new SaveError('unsupported', 'This browser cannot download a file.');
  }

  // `slice()` because a `Uint8Array` view into a larger buffer would put the
  // whole buffer in the blob.
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
  const url = createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next turn of the event loop rather than immediately: the
  // click is dispatched synchronously but the download starts after it, and
  // a URL revoked in between is a download that silently does not happen.
  setTimeout(() => revokeObjectURL?.(url), 0);
}

/**
 * A chosen or dropped file, validated. Task 2's other half.
 *
 * The size is checked before the bytes are read, which is the difference
 * between refusing a two-gigabyte file and dying of one.
 */
export async function readSaveFile(blob: Blob): Promise<SaveFile> {
  if (blob.size > MAX_SAVE_FILE_BYTES) {
    throw new SaveError('corrupt', `That file is ${blob.size} bytes; the limit is ${MAX_SAVE_FILE_BYTES}.`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch (cause) {
    throw asSaveError(cause, 'io');
  }
  return decodeSaveFile(bytes);
}

/**
 * Accept a save dropped anywhere on the window. C26 task 2.
 *
 * Returns the undo, because a listener on the window outlives everything that
 * is not the window — the same shape `TabLock.close` and every panel's
 * `destroy` have.
 *
 * `dragover` has to be cancelled or the browser navigates to the file, which
 * is the drag-and-drop equivalent of the object-URL navigation above: the tab
 * is replaced and the factory in it is gone.
 */
export function watchSaveFileDrops(target: EventTarget, onFile: (file: File) => void): () => void {
  const over = (event: Event): void => {
    const transfer = (event as DragEvent).dataTransfer;
    if (transfer === null || !Array.from(transfer.types).includes('Files')) return;
    event.preventDefault();
    transfer.dropEffect = 'copy';
  };

  const drop = (event: Event): void => {
    const transfer = (event as DragEvent).dataTransfer;
    const files = transfer === null ? [] : Array.from(transfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    // The first `.ifsave` if there is one, so dropping a folder's worth of
    // screenshots and one save does the obvious thing; otherwise the first
    // file, so a renamed save still imports and is refused on its contents
    // rather than on its extension.
    const save = files.find((file) => file.name.endsWith(SAVE_FILE_EXTENSION)) ?? files[0];
    if (save !== undefined) onFile(save);
  };

  target.addEventListener('dragover', over);
  target.addEventListener('drop', drop);
  return () => {
    target.removeEventListener('dragover', over);
    target.removeEventListener('drop', drop);
  };
}
