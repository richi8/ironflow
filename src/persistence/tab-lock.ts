/**
 * Which tab is allowed to write. See ironflow.md C25 task 6 and §14.
 *
 * > Two tabs open on the same save — detect via a BroadcastChannel lock; the
 * > second tab opens read-only or prompts. Do not let two tabs interleave
 * > writes.
 *
 * Interleaved writes are the worst bug in this chunk because they are silent:
 * two tabs autosaving a divergent factory into `auto-1` every three minutes
 * produce a save that is whole, loadable, and belongs to neither of them. This
 * lock does not make the write atomic — nothing here could — it makes the
 * *second tab know*, which is what turns a corrupted factory into a prompt.
 *
 * ## The three states, and why there is a third
 *
 * ```text
 *   pending     just asked; nobody has answered yet
 *   primary     the tab that saves
 *   secondary   another tab answered first
 * ```
 *
 * `BroadcastChannel` delivery is asynchronous, so a tab cannot know at
 * construction whether it is alone. Starting as `primary` and demoting on the
 * first answer would mean a save in the first few milliseconds went out from
 * both tabs; starting as `secondary` would mean a single tab — the normal
 * case — is never allowed to save at all. `pending` is the honest answer to a
 * question that has not come back yet, and `ready()` is how a caller waits for
 * it. Autosave's interval is three minutes, so nothing real waits on this.
 *
 * ## Ties are broken by id, not by timing
 *
 * Two tabs opened in the same frame both claim and both see the other's claim.
 * Whoever compares lower wins, in both tabs, without a round trip — the same
 * reasoning §6 R6 applies to two inserters reaching for one item: resolve by
 * identity, never by who was noticed first.
 */

/**
 * The part of `BroadcastChannel` this uses. Narrow, so a test can supply one.
 *
 * `onmessage` is typed with the DOM's `MessageEvent` rather than with the
 * `{ data: unknown }` this file actually reads, because the assignment has to
 * go the other way: a real `BroadcastChannel` must satisfy this interface, and
 * under `strictFunctionTypes` a handler slot accepting less than the real one
 * does is a slot the real one cannot be assigned to.
 */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export type TabLockState = 'pending' | 'primary' | 'secondary';

/** The channel name. One per database, because the lock is over the database. */
export const TAB_LOCK_CHANNEL = 'ironflow-save-lock';

/** How long to wait for another tab to object before assuming there is none. */
export const TAB_LOCK_SETTLE_MS = 60;

type MessageType = 'claim' | 'held' | 'takeover' | 'release';

interface LockMessage {
  readonly k: typeof TAB_LOCK_CHANNEL;
  readonly t: MessageType;
  readonly id: string;
}

export interface TabLockOptions {
  /**
   * The channel. Defaults to a real `BroadcastChannel` where the browser has
   * one; pass `null` to run without a lock, which is what a browser with no
   * `BroadcastChannel` gets — one tab that saves, exactly as before.
   */
  readonly channel?: BroadcastChannelLike | null | undefined;
  /** This tab's identity. Defaults to a random string; injected for tests. */
  readonly id?: string;
  /** Called whenever the state changes, including on settling. */
  readonly onChange?: (state: TabLockState) => void;
  /** How long `pending` lasts. Injected so a test need not wait 60 ms. */
  readonly settleMs?: number;
  /** Deferred execution. Injected for the same reason. */
  readonly schedule?: (fn: () => void, ms: number) => unknown;
}

export class TabLock {
  private readonly channel: BroadcastChannelLike | null;
  private readonly id: string;
  private readonly onChange: (state: TabLockState) => void;
  private readonly waiting: (() => void)[] = [];

  private state: TabLockState = 'pending';
  private closed = false;

  constructor(options: TabLockOptions = {}) {
    this.id = options.id ?? `tab-${Math.random().toString(36).slice(2, 10)}`;
    this.onChange = options.onChange ?? (() => undefined);
    this.channel = options.channel === undefined ? defaultChannel() : options.channel;

    if (this.channel === null) {
      this.state = 'primary';
      return;
    }

    this.channel.onmessage = (event) => this.receive(event.data);
    this.post('claim');
    const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    schedule(() => this.settle(), options.settleMs ?? TAB_LOCK_SETTLE_MS);
  }

  getState(): TabLockState {
    return this.state;
  }

  /** May this tab write? False while pending — see the header. */
  isPrimary(): boolean {
    return this.state === 'primary';
  }

  /** Resolves once the claim has been answered, or has gone unanswered. */
  ready(): Promise<TabLockState> {
    if (this.state !== 'pending') return Promise.resolve(this.state);
    return new Promise((resolve) => {
      this.waiting.push(() => resolve(this.state));
    });
  }

  /**
   * Take the lock from whichever tab has it. C25 task 6's "or prompts".
   *
   * The player is the authority here and not this class: they are looking at
   * two windows and know which one has the factory they care about. The other
   * tab demotes itself on the message, so there is still never more than one
   * writer.
   */
  takeOver(): void {
    this.post('takeover');
    this.enter('primary');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.state === 'primary') this.post('release');
    if (this.channel !== null) {
      this.channel.onmessage = null;
      this.channel.close();
    }
  }

  private settle(): void {
    if (this.closed || this.state !== 'pending') return;
    this.enter('primary');
  }

  private receive(data: unknown): void {
    const message = asLockMessage(data);
    if (message === null || message.id === this.id || this.closed) return;

    switch (message.t) {
      case 'claim':
        // A newcomer while we hold it, or a tie we win: answer, and stay.
        if (this.state === 'primary' || (this.state === 'pending' && this.id < message.id)) {
          this.post('held');
          this.enter('primary');
        } else if (this.state === 'pending') {
          this.enter('secondary');
        }
        return;
      case 'held':
      case 'takeover':
        this.enter('secondary');
        return;
      case 'release':
        // The writer is gone. Ask again rather than assuming: a third tab may
        // be asking at the same moment, and the tie-break above settles it.
        if (this.state === 'secondary') {
          this.state = 'pending';
          this.post('claim');
          this.enter('primary');
        }
        return;
    }
  }

  private enter(state: TabLockState): void {
    if (this.state === state) return;
    this.state = state;
    for (const resolve of this.waiting.splice(0)) resolve();
    this.onChange(state);
  }

  private post(t: MessageType): void {
    const message: LockMessage = { k: TAB_LOCK_CHANNEL, t, id: this.id };
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed channel, or a tab being torn down. The lock degrades to "this
      // tab thinks it is alone", which is the same answer a browser with no
      // BroadcastChannel gets — never a thrown error out of a save.
    }
  }
}

/** A real channel where there is one, and null where there is not. */
function defaultChannel(): BroadcastChannelLike | null {
  if (typeof globalThis.BroadcastChannel !== 'function') return null;
  try {
    return new BroadcastChannel(TAB_LOCK_CHANNEL);
  } catch {
    return null;
  }
}

/** A message of ours, or null. Anything else on the channel is not our business. */
function asLockMessage(data: unknown): LockMessage | null {
  if (data === null || typeof data !== 'object') return null;
  const message = data as Partial<LockMessage>;
  if (message.k !== TAB_LOCK_CHANNEL || typeof message.id !== 'string') return null;
  if (message.t !== 'claim' && message.t !== 'held' && message.t !== 'takeover' && message.t !== 'release') return null;
  return { k: TAB_LOCK_CHANNEL, t: message.t, id: message.id };
}
