import { describe, expect, it, vi } from 'vitest';

import {
  AUTOSAVE_IDS,
  AUTOSAVE_INTERVAL_MS,
  AUTOSAVE_SLOTS,
  Autosave,
  autosaveId,
  isAutosaveId,
} from '../../src/persistence/autosave.js';
import type { SaveSlot } from '../../src/persistence/save-repository.js';

/**
 * The rotation. C25 task 4 and §14's autosave row.
 *
 * > Every 3 minutes and on `visibilitychange` to hidden, into a rotating set
 * > of 3 autosave slots, never overwriting a manual save.
 */

function slot(id: string, updatedAt: number): SaveSlot {
  return {
    id,
    kind: 'auto',
    version: 1,
    playtimeTicks: 0,
    createdAt: updatedAt,
    updatedAt,
    name: id,
    bytes: 1,
    compressed: true,
    thumbnail: null,
  };
}

/** An autosave whose writes are recorded rather than performed. */
function recorder(): { autosave: Autosave; written: string[]; errors: unknown[] } {
  const written: string[] = [];
  const errors: unknown[] = [];
  const autosave = new Autosave({
    write: async (id) => {
      written.push(id);
    },
    onError: (error) => errors.push(error),
  });
  return { autosave, written, errors };
}

describe('the autosave interval', () => {
  it('is §14’s three minutes, into §14’s three slots', () => {
    expect(AUTOSAVE_INTERVAL_MS).toBe(3 * 60 * 1000);
    expect(AUTOSAVE_SLOTS).toBe(3);
    expect(AUTOSAVE_IDS).toEqual(['auto-1', 'auto-2', 'auto-3']);
  });

  it('writes nothing before the interval is up', () => {
    const { autosave, written } = recorder();
    autosave.update(AUTOSAVE_INTERVAL_MS - 1);
    expect(written).toEqual([]);
    expect(autosave.remainingMs()).toBe(1);
  });

  it('writes once when it is', async () => {
    const { autosave, written } = recorder();
    autosave.update(AUTOSAVE_INTERVAL_MS);
    await vi.waitFor(() => expect(written).toEqual(['auto-1']));
  });

  it('counts frames, so three minutes is three minutes of play', () => {
    // §8 stops the loop in a background tab, so a timer would go on firing
    // against a simulation that is not advancing — three identical copies of
    // the same tick. See the header of `autosave.ts`.
    const { autosave, written } = recorder();
    for (let frame = 0; frame < 100; frame++) autosave.update(16.7);
    expect(written).toEqual([]);
    expect(autosave.remainingMs()).toBeCloseTo(AUTOSAVE_INTERVAL_MS - 1670, 0);
  });
});

describe('the rotation', () => {
  it('cycles through all three slots before it reuses one', async () => {
    const { autosave, written } = recorder();
    for (let round = 0; round < 4; round++) {
      await autosave.trigger();
    }
    expect(written).toEqual(['auto-1', 'auto-2', 'auto-3', 'auto-1']);
  });

  it('starts from an unused slot after a reload', () => {
    const { autosave } = recorder();
    autosave.prime([slot('auto-1', 5000)]);
    // Two slots have never been written, and an empty slot is older than any
    // written one: fill all three before overwriting any.
    expect(autosave.nextId()).toBe('auto-2');
  });

  it('starts from the oldest slot when all three exist', () => {
    const { autosave } = recorder();
    autosave.prime([slot('auto-1', 9000), slot('auto-2', 3000), slot('auto-3', 7000)]);
    // The stalest copy is the one worth losing; the one written thirty seconds
    // before the crash is precisely the one worth keeping.
    expect(autosave.nextId()).toBe('auto-2');
  });

  it('ignores manual slots when it primes', () => {
    const { autosave } = recorder();
    autosave.prime([{ ...slot('manual-7', 1), kind: 'manual' }, slot('auto-1', 2), slot('auto-2', 3), slot('auto-3', 4)]);
    expect(autosave.nextId()).toBe('auto-1');
  });

  it('never names a manual slot, however it is spelt', () => {
    // "Never overwriting a manual save" has to hold for a player who calls
    // their save `auto-pilot`, which a `startsWith` would quietly eat.
    expect(isAutosaveId('auto-1')).toBe(true);
    expect(isAutosaveId('auto-pilot')).toBe(false);
    expect(isAutosaveId('manual-1')).toBe(false);
    expect(autosaveId(0)).toBe('auto-1');
  });

  it('stays on a slot that failed rather than skipping past it', async () => {
    const written: string[] = [];
    const errors: unknown[] = [];
    let fail = true;
    const autosave = new Autosave({
      write: async (id) => {
        if (fail) throw new Error('disk is full');
        written.push(id);
      },
      onError: (error) => errors.push(error),
    });

    await autosave.trigger();
    expect(errors.length).toBe(1);

    fail = false;
    await autosave.trigger();
    // Three failures in a row would otherwise leave three stale autosaves and
    // no way to tell which is which.
    expect(written).toEqual(['auto-1']);
  });
});

describe('the re-entry guard', () => {
  it('does not stack writers when one write outlasts the interval', async () => {
    let inFlight = 0;
    let peak = 0;
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const autosave = new Autosave({
      write: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await held;
        inFlight -= 1;
      },
    });

    autosave.update(AUTOSAVE_INTERVAL_MS);
    autosave.update(AUTOSAVE_INTERVAL_MS);
    autosave.update(AUTOSAVE_INTERVAL_MS);
    expect(autosave.isWriting()).toBe(true);

    release();
    await vi.waitFor(() => expect(autosave.isWriting()).toBe(false));
    // Each stacked writer would be holding a whole serialized world.
    expect(peak).toBe(1);
  });

  it('can be switched off, and writes nothing while it is', async () => {
    const { autosave, written } = recorder();
    autosave.setEnabled(false);
    autosave.update(AUTOSAVE_INTERVAL_MS * 3);
    await autosave.trigger();
    expect(written).toEqual([]);
    expect(autosave.isEnabled()).toBe(false);
  });

  it('puts the interval back after a manual save', () => {
    const { autosave } = recorder();
    autosave.update(AUTOSAVE_INTERVAL_MS - 1000);
    autosave.reset();
    expect(autosave.remainingMs()).toBe(AUTOSAVE_INTERVAL_MS);
  });
});
