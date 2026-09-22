import { describe, expect, it } from 'vitest';

import { TabLock, type BroadcastChannelLike, type TabLockState } from '../../src/persistence/tab-lock.js';

/**
 * Two tabs, one writer. C25 task 6 and §14's last failure row.
 *
 * The bug this prevents is silent, which is why it is worth a file: two tabs
 * autosaving a divergent factory into `auto-1` every three minutes produce a
 * save that is whole, loadable and belongs to neither of them.
 *
 * The fake channel below delivers synchronously to every *other* member of the
 * bus, which is what a real `BroadcastChannel` does asynchronously and never
 * to itself. Synchronous delivery makes the ordering in a test the ordering in
 * the assertions; the asynchrony a real one adds is covered by the `pending`
 * state, which is the thing under test rather than the thing being faked away.
 */

class Bus {
  readonly members: FakeChannel[] = [];

  channel(): FakeChannel {
    const channel = new FakeChannel(this);
    this.members.push(channel);
    return channel;
  }

  send(from: FakeChannel, message: unknown): void {
    for (const member of this.members) {
      if (member !== from && !member.closed) member.onmessage?.({ data: message } as MessageEvent);
    }
  }
}

class FakeChannel implements BroadcastChannelLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  closed = false;

  constructor(private readonly bus: Bus) {}

  postMessage(message: unknown): void {
    this.bus.send(this, message);
  }

  close(): void {
    this.closed = true;
  }
}

/** A lock on `bus`, with the settle timer under the test's control. */
function lockOn(bus: Bus, id: string): { lock: TabLock; settle: () => void; states: TabLockState[] } {
  const states: TabLockState[] = [];
  let pending: (() => void) | null = null;
  const lock = new TabLock({
    channel: bus.channel(),
    id,
    onChange: (state) => states.push(state),
    schedule: (fn) => {
      pending = fn;
    },
  });
  return { lock, settle: () => pending?.(), states };
}

describe('TabLock', () => {
  it('is the writer when nothing answers its claim', () => {
    const bus = new Bus();
    const only = lockOn(bus, 'a');

    // Before the timer, the honest answer is "nobody has said". A lock that
    // assumed it was alone would let both tabs write in the first frame.
    expect(only.lock.getState()).toBe('pending');
    expect(only.lock.isPrimary()).toBe(false);

    only.settle();
    expect(only.lock.getState()).toBe('primary');
  });

  it('resolves `ready()` once the claim has been answered or timed out', async () => {
    const bus = new Bus();
    const only = lockOn(bus, 'a');
    const ready = only.lock.ready();
    only.settle();
    expect(await ready).toBe('primary');
  });

  it('is the writer at once when there is no channel at all', () => {
    // A browser with no BroadcastChannel: one tab, which saves.
    const lock = new TabLock({ channel: null });
    expect(lock.isPrimary()).toBe(true);
  });

  it('makes the second tab stand down', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();
    expect(first.lock.isPrimary()).toBe(true);

    const second = lockOn(bus, 'b');
    // The claim reached the holder, which answered `held` — so the second tab
    // knows before its own timer fires, and never becomes a writer.
    expect(second.lock.getState()).toBe('secondary');
    second.settle();
    expect(second.lock.getState()).toBe('secondary');
    expect(first.lock.isPrimary()).toBe(true);
  });

  it('breaks a simultaneous tie by id rather than by timing', () => {
    // §6 R6's reasoning one layer out: resolve by identity, never by who was
    // noticed first, so both tabs reach the same answer with no round trip.
    const bus = new Bus();
    const low = lockOn(bus, 'aaa');
    const high = lockOn(bus, 'zzz');

    expect(low.lock.getState()).toBe('primary');
    expect(high.lock.getState()).toBe('secondary');
  });

  it('hands the lock over when a tab asks for it', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();
    const second = lockOn(bus, 'b');
    expect(second.lock.isPrimary()).toBe(false);

    second.lock.takeOver();

    expect(second.lock.isPrimary()).toBe(true);
    expect(first.lock.isPrimary()).toBe(false);
  });

  it('never has two writers at once, whatever the order', () => {
    const bus = new Bus();
    const a = lockOn(bus, 'a');
    const b = lockOn(bus, 'b');
    const c = lockOn(bus, 'c');
    a.settle();
    b.settle();
    c.settle();

    const writers = [a, b, c].filter((tab) => tab.lock.isPrimary());
    expect(writers.length).toBe(1);
  });

  it('lets the next tab take over when the writer closes', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();
    const second = lockOn(bus, 'b');
    expect(second.lock.isPrimary()).toBe(false);

    first.lock.close();

    // The release is what stops a closed tab from locking the game out of
    // saving for the rest of the session.
    expect(second.lock.isPrimary()).toBe(true);
  });

  it('reports every change exactly once', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();
    first.settle(); // a second timer firing changes nothing

    expect(first.states).toEqual(['primary']);
  });

  it('ignores traffic that is not ours', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();

    const stranger = bus.channel();
    stranger.postMessage({ hello: 'world' });
    stranger.postMessage(null);
    stranger.postMessage({ k: 'someone-elses-lock', t: 'held', id: 'x' });

    expect(first.lock.isPrimary()).toBe(true);
  });

  it('does not throw when posting to a channel that has gone', () => {
    const bus = new Bus();
    const first = lockOn(bus, 'a');
    first.settle();
    first.lock.close();
    // Closing twice, and taking over afterwards, must not reach the caller as
    // an exception out of a save.
    expect(() => {
      first.lock.close();
      first.lock.takeOver();
    }).not.toThrow();
  });
});
