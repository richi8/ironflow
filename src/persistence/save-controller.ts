/**
 * The save menu's behaviour, without a DOM. See ironflow.md C25 tasks 5 and 7.
 *
 * ```text
 *   SaveMenu (ui/)  ──verbs──>  SaveController  ──>  SaveService  ──> storage
 *        ^                            │
 *        └────── SaveSessionState ────┘
 * ```
 *
 * Everything that happens when a player clicks LOAD — hold the game still,
 * read, decode, rebuild the world, refresh the list, say what happened, and
 * say something *useful* when any of those fails — lives here rather than in
 * the composition root, for the reason §4 gives about the composition root: if
 * logic accumulates there, it belongs somewhere else. Here it can be tested
 * headlessly, which is the only way the failure paths in §14's table get
 * tested at all.
 *
 * It knows nothing about the DOM and nothing about `Simulation`. The state it
 * publishes is plain data the UI maps to a view model, and the two things it
 * cannot do itself — take a snapshot between ticks, and put a loaded world
 * into the running game — arrive as two injected functions. That is the same
 * arrangement `Cursor` and `MapPanelOptions.viewport` use in the other
 * direction: the layer that owns the thing supplies it.
 *
 * ## Every failure says what to do next
 *
 * C25 task 5: "Each one gets a specific, actionable player-facing message —
 * never a silent failure, never a bare `catch {}`." Every method here funnels
 * through `fail`, which is the only place a caught error is allowed to stop,
 * and which turns it into one of `saveErrorMessage`'s sentences. A `catch`
 * that swallowed would leave the player clicking SAVE at a game that is not
 * saving.
 */

import type { SaveFile, SerializedGameState } from '../game/save/save-format.js';

import { isAutosaveId, type Autosave } from './autosave.js';
import { encodeSaveFile, readSaveFile, saveFileName, wrapSaveBytes } from './export-import.js';
import type { SaveBytes } from './save-codec.js';
import { SaveError, saveErrorMessage, type SaveSlot } from './save-repository.js';
import type { SaveService } from './save-service.js';

/** How the save menu is doing. Plain data; the UI decides how to draw it. */
export interface SaveSessionState {
  readonly slots: readonly SaveSlot[];
  /** The last thing that happened, or the standing reason nothing can. */
  readonly status: string | null;
  readonly tone: 'info' | 'warn' | 'error';
  /** An operation is in flight. Every button is held while it is. */
  readonly busy: boolean;
  readonly canWrite: boolean;
  /** Another tab holds the write lock, and this one could take it. */
  readonly offerTakeOver: boolean;
  /** The slot this session is playing: last loaded, or last manually saved. */
  readonly currentId: string | null;
}

/** What the snapshot half of a save needs from the game. */
export interface SaveSnapshot {
  readonly state: SerializedGameState;
  readonly playtimeTicks: number;
}

export interface SaveControllerOptions {
  readonly service: SaveService;
  /**
   * Take a snapshot. **Must run between ticks** (§14, C24 task 5) — the
   * composition root holds the loop, so it is the one that can promise that,
   * and `serialize` throws if the promise is broken.
   */
  readonly capture: () => SaveSnapshot;
  /** Put a loaded world into the running game. The composition root's. */
  readonly apply: (state: SerializedGameState) => void;
  /** Told whenever the published state changes, so the UI can repaint. */
  readonly onChange: (state: SaveSessionState) => void;
  /** The rotation, so a manual save can reset its timer. */
  readonly autosave?: Autosave | undefined;
  /**
   * A standing warning that has nothing to do with any one operation — "this
   * browser has no IndexedDB", above all. Shown whenever nothing more recent
   * has happened.
   */
  readonly warning?: string | null;
  /**
   * Hand a finished file to the player (C26 task 1).
   *
   * Injected for `capture`'s reason rather than called directly: a download is
   * an anchor and an object URL, and a controller that reached for them could
   * not be tested without a DOM — which is where every one of §14's failure
   * rows would stop being covered. `export-import.ts` has the implementation;
   * the composition root passes it in.
   */
  readonly download?: (bytes: SaveBytes, filename: string) => void;
  /** Wall clock, for an exported file's name. The UI layer's, not the game's. */
  readonly now?: () => number;
}

export class SaveController {
  private readonly options: SaveControllerOptions;

  private slots: readonly SaveSlot[] = [];
  private status: string | null;
  private tone: 'info' | 'warn' | 'error';
  private busy = false;
  private currentId: string | null = null;

  constructor(options: SaveControllerOptions) {
    this.options = options;
    const warning = options.warning ?? null;
    this.status = warning;
    this.tone = warning === null ? 'info' : 'warn';
  }

  getState(): SaveSessionState {
    return {
      slots: this.slots,
      status: this.status,
      tone: this.tone,
      busy: this.busy,
      canWrite: this.options.service.canWrite(),
      offerTakeOver: !this.options.service.canWrite(),
      currentId: this.currentId,
    };
  }

  /** The slot this session is playing, for a boot-time resume. */
  setCurrentId(id: string | null): void {
    this.currentId = id;
    this.publish();
  }

  /** Re-read the list. Cheap: metadata only, never a save body (task 2). */
  async refresh(): Promise<void> {
    try {
      this.slots = await this.options.service.list();
    } catch (error) {
      this.fail(error);
      return;
    }
    this.publish();
  }

  /** Write a new manual slot. */
  async saveNew(name: string): Promise<void> {
    await this.writeTo(this.options.service.newManualId(), name);
  }

  /**
   * Write over an existing slot, refusing an autosave one.
   *
   * §14's rotation "never overwrites a manual save"; this is the same rule
   * facing the other way. A manual save dropped into `auto-2` would be gone
   * within nine minutes and the player would have been told it was saved.
   */
  async overwrite(id: string, name: string): Promise<void> {
    if (isAutosaveId(id)) {
      this.say('That is an autosave slot — the rotation would overwrite it. Use SAVE to make a copy.', 'warn');
      return;
    }
    await this.writeTo(id, name);
  }

  /**
   * Replace the running game with a save.
   *
   * There is no confirmation, and that is deliberate: LOAD is reached by
   * picking a row and then clicking a button, which is already the two
   * deliberate acts DELETE gets its second click for — and unlike DELETE it
   * destroys nothing that a save is not.
   */
  async load(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Loading…', 'info');
    let file: SaveFile;
    try {
      file = await this.options.service.read(id);
    } catch (error) {
      this.busy = false;
      this.fail(error);
      void this.refresh();
      return;
    }

    try {
      this.options.apply(file.state);
    } catch (cause) {
      // A save that decoded and then would not load: a foreign generator
      // version, or state C27 has not migrated yet. The running game is
      // untouched, because `deserialize` builds a new world rather than
      // mutating the live one (C24).
      this.busy = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.say(`That save could not be opened: ${detail}`, 'error');
      return;
    }

    this.busy = false;
    this.currentId = id;
    this.say(`Loaded "${file.metadata.name}".`, 'info');
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.publish();
    try {
      await this.options.service.remove(id);
    } catch (error) {
      this.busy = false;
      this.fail(error);
      return;
    }
    this.busy = false;
    if (this.currentId === id) this.currentId = null;
    this.say('Deleted.', 'info');
    await this.refresh();
  }

  async rename(id: string, name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.publish();
    try {
      await this.options.service.rename(id, name);
    } catch (error) {
      this.busy = false;
      this.fail(error);
      return;
    }
    this.busy = false;
    this.say('Renamed.', 'info');
    await this.refresh();
  }

  /* ---------------------------------------------------------------- *
   * Export and import (C26)
   * ---------------------------------------------------------------- */

  /**
   * Write a stored slot out to a file. C26 task 1.
   *
   * The ordinary path re-encodes the *decoded* save, so the file carries the
   * name the player sees rather than the one the body was written under — a
   * slot renamed after the fact would otherwise export under its old name and
   * import back under it again.
   *
   * The fallback is §14's promise about a corrupt blob: a save this build
   * cannot read is still the player's, and the bytes leave the browser
   * wrapped in a header that says what they claim to be. That file will be
   * refused on import, which is correct — it is a bug report, not a factory.
   */
  async exportSlot(id: string): Promise<void> {
    if (this.busy) return;
    const slot = this.slots.find((candidate) => candidate.id === id) ?? null;
    this.busy = true;
    this.say('Exporting…', 'info');

    let file: SaveFile | null = null;
    try {
      file = await this.options.service.read(id);
    } catch (error) {
      if (!(error instanceof SaveError) || error.code !== 'corrupt' || slot === null) {
        this.busy = false;
        this.fail(error);
        return;
      }
    }

    try {
      if (file !== null) {
        this.hand(await encodeSaveFile(file), file.metadata.name);
        this.busy = false;
        this.say(`Exported "${file.metadata.name}".`, 'info');
        return;
      }
      const raw = await this.options.service.readRaw(id);
      // `slot` is non-null on this path: the branch above returned otherwise.
      const name = slot === null ? 'unreadable' : `${slot.name} unreadable`;
      this.hand(wrapSaveBytes(raw.bytes, raw.compressed, slot?.version ?? 1), name);
      this.busy = false;
      this.say('That save could not be read, so its stored bytes were exported as they are.', 'warn');
    } catch (error) {
      this.busy = false;
      this.fail(error);
    }
  }

  /**
   * Write the *running* game out to a file, without storing it.
   *
   * The path that matters most when §14's first row is true: with IndexedDB
   * blocked there is no slot to export, and this is the whole of how a factory
   * survives that session.
   */
  async exportCurrent(name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Exporting…', 'info');

    let snapshot: SaveSnapshot;
    try {
      snapshot = this.options.capture();
    } catch (cause) {
      this.busy = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.say(`The game could not be snapshotted: ${detail}`, 'error');
      return;
    }

    try {
      const file = this.options.service.fileFor({
        name,
        kind: 'manual',
        state: snapshot.state,
        playtimeTicks: snapshot.playtimeTicks,
      });
      this.hand(await encodeSaveFile(file), name);
    } catch (error) {
      this.busy = false;
      this.fail(error);
      return;
    }
    this.busy = false;
    this.say(`Exported "${name}".`, 'info');
  }

  /**
   * Play a file from disk. C26 tasks 2–4.
   *
   * Three steps in a fixed order, and the order is the safety: the file is
   * decoded and **validated** before anything else happens, the world is
   * built from it next — `deserialize` constructs a fresh `Simulation`, so a
   * failure there leaves the running factory exactly as it was — and only
   * then is it stored. A storage failure at the end costs a slot, not the
   * import, and says so.
   */
  async importFile(blob: Blob, filename = ''): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Reading file…', 'info');

    let file: SaveFile;
    try {
      file = await readSaveFile(blob);
    } catch (error) {
      this.busy = false;
      // The listed reasons, not a shrug: C26 task 4 says a rejection names
      // what is wrong, and `SaveError` carries the validator's sentence.
      const detail = error instanceof SaveError ? error.message : saveErrorMessage(error);
      this.say(`That file was not imported. ${detail}`, 'error');
      return;
    }

    try {
      this.options.apply(file.state);
    } catch (cause) {
      this.busy = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.say(`That save is valid but this build could not open it: ${detail}`, 'error');
      return;
    }

    const name = importName(file.metadata.name, filename);
    const id = this.options.service.newManualId();
    try {
      await this.options.service.write(id, {
        name,
        kind: 'manual',
        state: file.state,
        playtimeTicks: file.metadata.playtimeTicks,
      });
    } catch (error) {
      this.busy = false;
      this.currentId = null;
      this.options.autosave?.reset();
      this.say(`Imported "${name}", but it could not be stored: ${saveErrorMessage(error)}`, 'warn');
      return;
    }

    this.busy = false;
    this.currentId = id;
    this.options.autosave?.reset();
    this.say(`Imported "${name}".`, 'info');
    await this.refresh();
  }

  /** Become the writing tab (C25 task 6). */
  takeOver(): void {
    this.options.service.takeOver();
    this.say('This tab is now the one saving. The other tab will not write.', 'info');
  }

  /**
   * An autosave landed. Called by the rotation, never by the UI.
   *
   * It refreshes and says nothing: an autosave that announced itself every
   * three minutes would be the only line in the status the player never asked
   * for. A *failed* one does say something — see `noteAutosaveFailed` — because
   * silence there is the failure mode §14's table exists to prevent.
   */
  noteAutosave(): void {
    void this.refresh();
  }

  /** An autosave did not land. The one thing about it the player must hear. */
  noteAutosaveFailed(error: unknown): void {
    this.fail(error);
  }

  /** Give the bytes to the browser, or say that this one cannot take them. */
  private hand(bytes: SaveBytes, name: string): void {
    const download = this.options.download;
    if (download === undefined) {
      throw new SaveError('unsupported', 'This build cannot download a file.');
    }
    download(bytes, saveFileName(name, (this.options.now ?? Date.now)()));
  }

  /** The one place a caught error is allowed to stop (task 5). */
  private fail(error: unknown): void {
    this.say(saveErrorMessage(error), 'error');
  }

  private async writeTo(id: string, name: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.say('Saving…', 'info');

    let snapshot: SaveSnapshot;
    try {
      // Synchronous, and between ticks: see `SaveControllerOptions.capture`.
      // Nothing is awaited between here and the snapshot, so no tick can run
      // in the middle of it.
      snapshot = this.options.capture();
    } catch (cause) {
      this.busy = false;
      const detail = cause instanceof Error ? cause.message : String(cause);
      this.say(`The game could not be snapshotted: ${detail}`, 'error');
      return;
    }

    try {
      await this.options.service.write(id, {
        name,
        kind: 'manual',
        state: snapshot.state,
        playtimeTicks: snapshot.playtimeTicks,
      });
    } catch (error) {
      this.busy = false;
      this.fail(error);
      return;
    }

    this.busy = false;
    this.currentId = id;
    // A manual save resets the rotation's clock: an autosave one second later
    // would be three minutes of insurance spent on nothing.
    this.options.autosave?.reset();
    this.say(`Saved "${name}".`, 'info');
    await this.refresh();
  }

  private say(status: string, tone: 'info' | 'warn' | 'error'): void {
    this.status = status;
    this.tone = tone;
    this.publish();
  }

  private publish(): void {
    this.options.onChange(this.getState());
  }
}

/**
 * What an imported factory is called.
 *
 * The name inside the file, because that is what its owner called it — and
 * the filename only when the document has nothing to say, which is how a save
 * named "Factory" by the default and renamed on disk still arrives as
 * something the player recognises.
 */
function importName(metadataName: string, filename: string): string {
  const inside = metadataName.trim();
  if (inside !== '') return inside;
  const stem = filename.replace(/\.[^.]*$/, '').trim();
  return stem === '' ? 'Imported factory' : stem;
}
