import { describe, expect, it } from 'vitest';

import {
  AudioEngine,
  HUM_VOICES,
  MAX_SOURCES,
  MIN_RAMP_S,
  pickNearest,
  sourcesFor,
  type HumSource,
  type SoundName,
} from '../../src/audio/audio-engine.js';

/**
 * Sound. See ironflow.md C30 tasks 1 and 2, and its acceptance line:
 *
 * > Audio never exceeds the source cap and never clicks or pops.
 *
 * Both halves are properties of *what the engine asks the context to do*,
 * which is what a fake context can record exactly: every source started and
 * ended, and every change to every gain, in order. "Never clicks" is then a
 * rule about that record — no gain is ever assigned, only scheduled; every
 * envelope starts at zero and is back at zero before its source stops.
 */

type ParamEvent =
  | { readonly kind: 'set'; readonly value: number; readonly time: number }
  | { readonly kind: 'linear'; readonly value: number; readonly time: number }
  | { readonly kind: 'exponential'; readonly value: number; readonly time: number }
  | { readonly kind: 'target'; readonly value: number; readonly time: number };

class FakeParam {
  readonly events: ParamEvent[] = [];
  assignments = 0;
  private current = 0;

  get value(): number {
    return this.current;
  }

  /** An assignment is an instant jump: the thing a click is. Counted, never expected. */
  set value(next: number) {
    this.assignments += 1;
    this.current = next;
  }

  setValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.events.push({ kind: 'exponential', value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number): this {
    this.events.push({ kind: 'target', value, time });
    return this;
  }
}

class FakeNode {
  connect(): void {}
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam();
}

class FakeSource extends FakeNode {
  readonly frequency = new FakeParam();
  type = '';
  loop = false;
  buffer: unknown = null;
  startedAt: number | null = null;
  stopAt: number | null = null;
  ended = false;
  private readonly onEnded: (() => void)[] = [];

  constructor(private readonly context: FakeContext) {
    super();
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.onEnded.push(listener);
  }

  start(at = this.context.currentTime): void {
    this.startedAt = at;
  }

  stop(at = this.context.currentTime): void {
    this.stopAt = at;
  }

  /** What the browser does when the stop time passes. */
  finish(): void {
    if (this.ended) return;
    this.ended = true;
    for (const listener of this.onEnded) listener();
  }
}

class FakeContext {
  currentTime = 0;
  state: 'running' | 'suspended' = 'running';
  readonly sampleRate = 4000;
  readonly destination = new FakeNode();
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];

  createGain(): FakeGain {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }

  createOscillator(): FakeSource {
    const source = new FakeSource(this);
    this.sources.push(source);
    return source;
  }

  createBufferSource(): FakeSource {
    return this.createOscillator();
  }

  createBiquadFilter(): { type: string; frequency: FakeParam; Q: FakeParam; connect(): void } {
    return { type: '', frequency: new FakeParam(), Q: new FakeParam(), connect: () => {} };
  }

  createStereoPanner(): { pan: FakeParam; connect(): void } {
    return { pan: new FakeParam(), connect: () => {} };
  }

  createBuffer(_channels: number, length: number): { getChannelData(): Float32Array } {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Sources started and not yet ended: what the browser is actually running. */
  get live(): number {
    return this.sources.filter((source) => source.startedAt !== null && !source.ended).length;
  }

  /** End every one-shot whose stop time has passed. */
  settle(): void {
    for (const source of this.sources) {
      if (source.stopAt !== null && source.stopAt <= this.currentTime) source.finish();
    }
  }
}

function makeEngine(options: { volume?: number; muted?: boolean } = {}): { engine: AudioEngine; context: FakeContext } {
  const context = new FakeContext();
  const engine = new AudioEngine({
    createContext: () => context as unknown as AudioContext,
    ...options,
  });
  return { engine, context };
}

const SOUNDS: readonly SoundName[] = ['place', 'remove', 'research', 'alert'];

describe('AudioEngine before a gesture', () => {
  it('builds nothing and plays nothing until it is unlocked', () => {
    const { engine, context } = makeEngine();
    expect(engine.play('place')).toBe(false);
    engine.setHum([{ pan: 0, distance: 0 }]);
    engine.setBeltLevel(1);
    expect(context.sources).toHaveLength(0);
    expect(engine.ready).toBe(false);
  });

  it('stays silent, rather than throwing, where there is no Web Audio at all', () => {
    const engine = new AudioEngine({ createContext: () => null });
    engine.unlock();
    expect(engine.ready).toBe(false);
    expect(engine.play('alert')).toBe(false);
  });
});

describe('the source cap (C30 task 2)', () => {
  it('never runs more than MAX_SOURCES, however many events arrive', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    engine.setHum([{ pan: 0, distance: 0.1 }]);
    engine.setBeltLevel(1);

    let refused = 0;
    for (let i = 0; i < 400; i++) {
      // Faster than any sound finishes, slower than the repeat guard, so the
      // cap and not the guard is what is being leaned on.
      context.currentTime += 0.07;
      for (const sound of SOUNDS) if (!engine.play(sound)) refused += 1;
      expect(engine.activeSources).toBeLessThanOrEqual(MAX_SOURCES);
      expect(context.live).toBeLessThanOrEqual(MAX_SOURCES);
      if (i % 3 === 0) context.settle();
    }
    // The storm really did reach the cap: something was turned away.
    expect(refused).toBeGreaterThan(0);
  });

  it('counts a source out again when it ends, so the budget comes back', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    expect(engine.play('research')).toBe(true);
    expect(engine.activeSources).toBe(sourcesFor('research'));
    context.currentTime += 5;
    context.settle();
    expect(engine.activeSources).toBe(0);
  });

  it('voices a thousand running machines with HUM_VOICES oscillators, and keeps them', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    const thousand: HumSource[] = Array.from({ length: 1000 }, (_unused, i) => ({
      pan: (i % 21) / 10 - 1,
      distance: (i % 97) / 100,
    }));
    for (let frame = 0; frame < 20; frame++) engine.setHum(thousand);
    expect(context.sources).toHaveLength(HUM_VOICES);
    expect(engine.activeSources).toBe(HUM_VOICES);
  });

  it('culls by distance: the nearest are voiced, and nothing off screen is', () => {
    const sources: HumSource[] = [
      { pan: 0, distance: 0.9 },
      { pan: 0, distance: 0.2 },
      { pan: 0, distance: 1.4 },
      { pan: 0, distance: 0.5 },
      { pan: 0, distance: 0.1 },
      { pan: 0, distance: 0.7 },
    ];
    expect(pickNearest(sources, 4).map((source) => source.distance)).toEqual([0.1, 0.2, 0.5, 0.7]);
    expect(pickNearest([{ pan: 0, distance: 1 }], 4)).toEqual([]);
  });
});

describe('never clicks or pops', () => {
  function everyParam(context: FakeContext): FakeParam[] {
    return context.gains.map((gain) => gain.gain);
  }

  it('never assigns a gain, only schedules one', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    for (const sound of SOUNDS) {
      context.currentTime += 1;
      engine.play(sound);
    }
    engine.setHum([{ pan: -0.5, distance: 0.3 }]);
    engine.setBeltLevel(0.5);
    engine.setVolume(0.2);
    engine.setMuted(true);
    engine.setMuted(false);
    engine.setHum([]);
    for (const param of everyParam(context)) expect(param.assignments).toBe(0);
  });

  it('starts every gain at silence', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    engine.play('alert');
    engine.setHum([{ pan: 0, distance: 0 }]);
    engine.setBeltLevel(1);
    for (const param of everyParam(context)) {
      const first = param.events[0];
      expect(first?.kind).toBe('set');
      expect(first?.value).toBe(0);
    }
  });

  it('ramps each tone in over at least MIN_RAMP_S, and back to zero before it stops', () => {
    const { engine, context } = makeEngine();
    engine.unlock();
    context.currentTime = 3;
    for (const sound of SOUNDS) {
      context.currentTime += 1;
      engine.play(sound);
    }

    const oneShots = context.sources.filter((source) => source.stopAt !== null);
    expect(oneShots.length).toBe(SOUNDS.reduce((sum, sound) => sum + sourcesFor(sound), 0));

    // Each one-shot's envelope is the gain created right after its oscillator.
    const envelopes = context.gains.slice(1).map((gain) => gain.gain.events);
    expect(envelopes).toHaveLength(oneShots.length);
    envelopes.forEach((events, index) => {
      const source = oneShots[index];
      const [start, up, down] = events;
      expect(start).toMatchObject({ kind: 'set', value: 0 });
      expect(up?.kind).toBe('linear');
      expect((up?.time ?? 0) - (start?.time ?? 0)).toBeGreaterThanOrEqual(MIN_RAMP_S - 1e-9);
      expect(down).toMatchObject({ kind: 'linear', value: 0 });
      expect(source?.stopAt ?? 0).toBeGreaterThan(down?.time ?? Infinity);
    });
  });
});

describe('volume and mute', () => {
  it('plays nothing while muted, and glides the master rather than cutting it', () => {
    const { engine, context } = makeEngine({ muted: true });
    engine.unlock();
    expect(engine.play('place')).toBe(false);
    const master = context.gains[0]?.gain;
    engine.setMuted(false);
    expect(master?.events.at(-1)).toMatchObject({ kind: 'target', value: 0.7 });
    expect(engine.play('place')).toBe(true);
  });

  it('hears one of a burst: the same sound inside the repeat guard is one sound', () => {
    const { engine } = makeEngine();
    engine.unlock();
    expect(engine.play('place')).toBe(true);
    expect(engine.play('place')).toBe(false);
    expect(engine.play('remove')).toBe(true);
  });
});
