import { describe, expect, it } from 'vitest';

import {
  CommandProcessor,
  MAX_COMMANDS_PER_TICK,
  MAX_PENDING_COMMANDS,
  MAX_RECORDED_REJECTIONS,
} from '../../src/game/commands/command-processor.js';
import { validateCommandShape, type Command } from '../../src/game/commands/command.js';
import { TILE_MAX } from '../../src/game/world/coordinates.js';

/**
 * The command pipeline. See ironflow.md C04 and §7.
 *
 * Three things are being protected here, and they are the three §7 calls out
 * as the ones that go wrong in this genre:
 *
 * 1. **Nothing fails silently.** Every refused command leaves a typed reason
 *    behind, because an invisible rejection reads to a player as a broken game.
 * 2. **The queue is bounded, twice.** A per-tick drain cap so one tick cannot
 *    be handed unbounded work, and a queue cap so a runaway producer cannot
 *    grow memory without anyone noticing.
 * 3. **Commands are plain data.** `structuredClone` is the check, because
 *    replay, save import and a future Web Worker all depend on it and all
 *    three are far too late to discover a closure hiding in a command.
 */

const MINE: Command = { type: 'mineTile', x: 3, y: 4 };

function mine(x: number): Command {
  return { type: 'mineTile', x, y: 0 };
}

describe('CommandProcessor queue', () => {
  it('drains in the order commands were enqueued', () => {
    const processor = new CommandProcessor();
    for (let i = 0; i < 5; i++) processor.enqueue(mine(i));

    expect(processor.drain().map((c) => (c.type === 'mineTile' ? c.x : -1))).toEqual([0, 1, 2, 3, 4]);
  });

  it('drains nothing twice', () => {
    const processor = new CommandProcessor();
    processor.enqueue(MINE);

    expect(processor.drain()).toHaveLength(1);
    expect(processor.drain()).toHaveLength(0);
    expect(processor.pending).toBe(0);
  });

  it('hands a tick at most MAX_COMMANDS_PER_TICK and keeps the rest', () => {
    const processor = new CommandProcessor();
    const total = MAX_COMMANDS_PER_TICK + 17;
    for (let i = 0; i < total; i++) processor.enqueue(mine(i % 100));

    const first = processor.drain();
    expect(first).toHaveLength(MAX_COMMANDS_PER_TICK);
    expect(processor.pending).toBe(17);

    // The overflow is deferred, not dropped: a build drag that outruns one
    // tick still places every tile, one tick later.
    expect(processor.drain()).toHaveLength(17);
  });

  it('honours a smaller explicit cap', () => {
    const processor = new CommandProcessor();
    for (let i = 0; i < 10; i++) processor.enqueue(mine(i));

    expect(processor.drain(3)).toHaveLength(3);
    expect(processor.pending).toBe(7);
  });

  it('refuses to grow past MAX_PENDING_COMMANDS, with a reason', () => {
    const processor = new CommandProcessor();
    for (let i = 0; i < MAX_PENDING_COMMANDS; i++) {
      expect(processor.enqueue(mine(i % 100))).toBe(true);
    }

    expect(processor.enqueue(MINE)).toBe(false);
    expect(processor.pending).toBe(MAX_PENDING_COMMANDS);
    expect(processor.takeRejections().at(-1)?.reason).toBe('queue_full');
  });

  it('returns the same empty array rather than allocating on an idle tick', () => {
    const processor = new CommandProcessor();
    expect(processor.drain()).toBe(processor.drain());
  });

  it('does not hand out an array it keeps writing to', () => {
    const processor = new CommandProcessor();
    processor.enqueue(MINE);

    const batch = processor.drain();
    processor.enqueue(mine(9));
    expect(batch).toHaveLength(1);
  });
});

describe('rejections', () => {
  it('records the command alongside its reason', () => {
    const processor = new CommandProcessor();
    processor.reject(MINE, 'occupied');

    const [rejection] = processor.takeRejections();
    expect(rejection?.reason).toBe('occupied');
    expect(rejection?.command).toBe(MINE);
  });

  it('clears on read, so a notification is shown once', () => {
    const processor = new CommandProcessor();
    processor.reject(MINE, 'occupied');

    expect(processor.takeRejections()).toHaveLength(1);
    expect(processor.takeRejections()).toHaveLength(0);
  });

  it('keeps the newest when nobody is reading, and says how many it lost', () => {
    const processor = new CommandProcessor();
    for (let i = 0; i < MAX_RECORDED_REJECTIONS + 5; i++) processor.reject(mine(i), 'occupied');

    const kept = processor.takeRejections();
    expect(kept).toHaveLength(MAX_RECORDED_REJECTIONS);
    expect(processor.unreadRejectionsDropped).toBe(5);
    // The last rejection is the one the player just caused.
    const last = kept.at(-1)?.command;
    expect(last?.type === 'mineTile' ? last.x : -1).toBe(MAX_RECORDED_REJECTIONS + 4);
  });
});

describe('shape validation', () => {
  it('accepts every well-formed member of the union', () => {
    const commands: Command[] = [
      { type: 'build', buildingId: 'miner', x: 1, y: -2, rotation: 3 },
      { type: 'remove', x: 0, y: 0 },
      { type: 'rotate', entityId: 7 },
      { type: 'setRecipe', entityId: 7, recipeId: 'iron-plate' },
      { type: 'setRecipe', entityId: 7, recipeId: null },
      { type: 'insertItems', entityId: 7, itemId: 'iron-ore', amount: 5 },
      { type: 'takeItems', entityId: 7, itemId: 'iron-ore', amount: 1 },
      { type: 'startResearch', technologyId: 'automation-1' },
      { type: 'movePlayer', dx: 1, dy: 0 },
      { type: 'mineTile', x: TILE_MAX, y: 0 },
    ];

    for (const command of commands) {
      expect(validateCommandShape(command), command.type).toBeNull();
    }
  });

  it.each([
    ['a fractional tile', { type: 'mineTile', x: 1.5, y: 0 }],
    ['a NaN tile, which is what a stray pointer event produces', { type: 'mineTile', x: Number.NaN, y: 0 }],
    ['a tile outside the packable range', { type: 'mineTile', x: TILE_MAX + 1, y: 0 }],
    ['an empty registry id', { type: 'build', buildingId: '', x: 0, y: 0, rotation: 0 }],
    ['a padded registry id', { type: 'startResearch', technologyId: ' automation-1' }],
    ['a rotation outside 0-3', { type: 'build', buildingId: 'miner', x: 0, y: 0, rotation: 4 }],
    ['a negative entity id', { type: 'rotate', entityId: -1 }],
    ['a zero amount', { type: 'insertItems', entityId: 1, itemId: 'iron-ore', amount: 0 }],
    ['a fractional amount', { type: 'takeItems', entityId: 1, itemId: 'iron-ore', amount: 0.5 }],
    ['an infinite movement', { type: 'movePlayer', dx: Number.POSITIVE_INFINITY, dy: 0 }],
    ['a type no system has ever heard of', { type: 'summonKraken' }],
  ] as [string, Command][])('rejects %s as malformed', (_label, command) => {
    expect(validateCommandShape(command)).toBe('malformed');
  });

  it('rejects malformed commands at enqueue, so they never reach a tick', () => {
    const processor = new CommandProcessor();

    expect(processor.enqueue({ type: 'mineTile', x: Number.NaN, y: 0 })).toBe(false);
    expect(processor.pending).toBe(0);
    expect(processor.takeRejections().at(0)?.reason).toBe('malformed');
  });
});

describe('commands are plain data', () => {
  it('survives structuredClone unchanged', () => {
    // Replay (§6), save import (C26) and a Web Worker simulation (§21) all
    // require this. Each of them is a long way from here, and each would find
    // out the hard way.
    const commands: Command[] = [
      { type: 'build', buildingId: 'miner', x: 1, y: -2, rotation: 3 },
      { type: 'setRecipe', entityId: 7, recipeId: null },
      { type: 'insertItems', entityId: 7, itemId: 'iron-ore', amount: 5 },
      { type: 'mineTile', x: 3, y: 4 },
    ];

    for (const command of commands) {
      const clone = structuredClone(command);
      expect(clone).toEqual(command);
      expect(clone).not.toBe(command);
    }
  });

  it('survives a JSON round trip, which is stricter still', () => {
    const command: Command = { type: 'build', buildingId: 'miner', x: 1, y: -2, rotation: 3 };
    expect(JSON.parse(JSON.stringify(command))).toEqual(command);
  });
});
