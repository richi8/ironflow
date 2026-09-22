import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SAVE_FILE_EXTENSION,
  downloadSaveFile,
  watchSaveFileDrops,
} from '../../src/persistence/export-import.js';
import { SaveError } from '../../src/persistence/save-repository.js';

/**
 * The two places a save file meets the browser. C26 tasks 1 and 2.
 *
 * Both are four lines of DOM with one failure mode each, and both of those
 * failure modes lose the player's factory: a download that navigates the tab
 * instead of saving a file, and a drop the browser handles itself by opening
 * the file as a page. Each has a test here for that reason and no other.
 */

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

/** An object-URL implementation jsdom does not have. */
function bridge(): {
  readonly created: Blob[];
  readonly revoked: string[];
  readonly document: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
} {
  const created: Blob[] = [];
  const revoked: string[] = [];
  return {
    created,
    revoked,
    document,
    createObjectURL: (blob) => {
      created.push(blob);
      return `blob:ironflow/${created.length}`;
    },
    revokeObjectURL: (url) => void revoked.push(url),
  };
}

describe('downloading a save', () => {
  it('clicks an anchor with a download name and then lets the URL go', async () => {
    const bridged = bridge();
    const clicks: string[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        clicks.push(`${this.download}|${this.href}`);
        // The anchor must be in the document when it is clicked, or Firefox
        // ignores the click entirely.
        expect(this.isConnected).toBe(true);
      });

    downloadSaveFile(new Uint8Array([1, 2, 3]), `ironflow-save-test${SAVE_FILE_EXTENSION}`, bridged);

    expect(click).toHaveBeenCalledOnce();
    expect(clicks[0]).toBe(`ironflow-save-test${SAVE_FILE_EXTENSION}|blob:ironflow/1`);
    expect(bridged.created).toHaveLength(1);
    expect(bridged.created[0]?.size).toBe(3);
    expect(bridged.created[0]?.type).toBe('application/octet-stream');

    // Left behind, the anchor would accumulate one node per export.
    expect(document.querySelector('a')).toBeNull();

    // Revoked, but not before the click has been dispatched.
    expect(bridged.revoked).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridged.revoked).toEqual(['blob:ironflow/1']);
  });

  it('says so rather than throwing something unrecognisable where it cannot', () => {
    // A browser with object URLs blocked, which is the same browser §14's
    // first row is about: the answer is a message, not an exception nobody
    // has a sentence for.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.stubGlobal('URL', { createObjectURL: undefined, revokeObjectURL: undefined });
    try {
      expect(() => downloadSaveFile(new Uint8Array([1]), 'x.ifsave', { document })).toThrow(SaveError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('dropping a save on the window', () => {
  /** A drag event jsdom can carry a file list on. */
  function dragEvent(type: string, files: readonly File[], types: readonly string[] = ['Files']): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { files, types, dropEffect: 'none' },
    });
    return event;
  }

  it('takes the dropped file and stops the browser opening it', () => {
    const dropped: File[] = [];
    const stop = watchSaveFileDrops(window, (file) => void dropped.push(file));

    const over = dragEvent('dragover', []);
    window.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);

    const file = new File(['bytes'], `factory${SAVE_FILE_EXTENSION}`);
    const drop = dragEvent('drop', [file]);
    window.dispatchEvent(drop);

    expect(drop.defaultPrevented).toBe(true);
    expect(dropped).toEqual([file]);
    stop();
  });

  it('prefers the save among a handful of files', () => {
    const dropped: File[] = [];
    const stop = watchSaveFileDrops(window, (file) => void dropped.push(file));

    const png = new File(['x'], 'screenshot.png');
    const save = new File(['y'], `factory${SAVE_FILE_EXTENSION}`);
    window.dispatchEvent(dragEvent('drop', [png, save]));

    expect(dropped.map((file) => file.name)).toEqual([save.name]);
    stop();
  });

  it('takes a renamed save rather than refusing it on its extension', () => {
    const dropped: File[] = [];
    const stop = watchSaveFileDrops(window, (file) => void dropped.push(file));
    window.dispatchEvent(dragEvent('drop', [new File(['y'], 'factory.txt')]));
    expect(dropped.map((file) => file.name)).toEqual(['factory.txt']);
    stop();
  });

  it('ignores a drag that carries no files', () => {
    const dropped: File[] = [];
    const stop = watchSaveFileDrops(window, (file) => void dropped.push(file));

    const over = dragEvent('dragover', [], ['text/plain']);
    window.dispatchEvent(over);
    const drop = dragEvent('drop', [], ['text/plain']);
    window.dispatchEvent(drop);

    // Not cancelled: dragging text over the window is the browser's business.
    expect(over.defaultPrevented).toBe(false);
    expect(drop.defaultPrevented).toBe(false);
    expect(dropped).toEqual([]);
    stop();
  });

  it('stops listening when it is told to', () => {
    const dropped: File[] = [];
    watchSaveFileDrops(window, (file) => void dropped.push(file))();
    window.dispatchEvent(dragEvent('drop', [new File(['y'], `a${SAVE_FILE_EXTENSION}`)]));
    expect(dropped).toEqual([]);
  });
});
