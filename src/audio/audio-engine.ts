/**
 * Sound. See ironflow.md C30 task 1 and 2.
 *
 * Everything is synthesised with `AudioContext` — oscillators, a filter, a
 * loop of noise — so there are no sound files, for the reason §11 gave for
 * sprites: nothing to load, nothing to license, and nothing that can be
 * missing. The layer knows no game: the composition root tells it "a
 * building went down", "these machines are running, here", and it decides
 * what that sounds like.
 *
 * ## The cap is a count of sources, and it is hard
 *
 * A thousand humming machines must not become a thousand oscillators (C30
 * task 2). So the engine owns a fixed budget of `MAX_SOURCES` scheduled
 * sources, split three ways:
 *
 * ```text
 *   hum       HUM_VOICES persistent voices, reassigned every update to
 *             the nearest running machines; the rest are culled
 *   belts     one looping noise source, its level set by how much is moving
 *   one-shots whatever is left; a sound that would go over is dropped,
 *             never queued, because a click that sounds late is wrong
 * ```
 *
 * A voice is created once and retuned, never re-created per machine, so the
 * number of hum sources is `HUM_VOICES` whether one machine is on screen or
 * twenty thousand. `activeSources` is counted at the point of `start()` and
 * released on `ended`, and `tests/unit/audio-engine.test.ts` asserts it
 * against a fake context under a storm of events.
 *
 * ## It never clicks
 *
 * A click is a gain that jumps. So no gain here is ever assigned: every
 * source starts silent and ramps in over at least `MIN_RAMP_S`, ramps to
 * silence before its `stop()`, and every level change on a running voice is a
 * `setTargetAtTime` glide. Mute and volume are glides on the master too.
 *
 * ## The context waits for a gesture
 *
 * Browsers refuse to start audio before the player has done something, and a
 * context made earlier is born suspended. So nothing is built until
 * `unlock()`, which the composition root calls from the first key or click.
 * Until then every call is a no-op, which is also what a browser with no Web
 * Audio at all gets.
 */

/** Scheduled sources alive at once, across everything. C30 task 2's hard cap. */
export const MAX_SOURCES = 16;

/** Machines heard at once. The nearest ones win. */
export const HUM_VOICES = 4;

/** The shortest a gain may take to change. Five milliseconds is below hearing a ramp and above hearing a click. */
export const MIN_RAMP_S = 0.005;

/** How long a running voice takes to glide to a new level (a time constant). */
const GLIDE_S = 0.08;

/** The same sound twice inside this is one sound: a belt drag lays thirty in a frame. */
const REPEAT_GUARD_S = 0.06;

/** Per-voice levels, before the master volume. */
const HUM_LEVEL = 0.05;
const BELT_LEVEL = 0.035;

/** The shape of one tone in a one-shot. Times in seconds, from the sound's start. */
interface Tone {
  readonly wave: OscillatorType;
  readonly from: number;
  readonly to: number;
  readonly delay: number;
  readonly attack: number;
  readonly length: number;
  readonly level: number;
}

export type SoundName = 'place' | 'remove' | 'mine' | 'research' | 'alert';

/**
 * What each event sounds like. Short, low and soft: these play hundreds of
 * times an hour, and a sound that is pleasant once is grating by the fiftieth.
 */
const SOUNDS: Readonly<Record<SoundName, readonly Tone[]>> = Object.freeze({
  // A soft thud, dropping: something set down.
  place: [{ wave: 'triangle', from: 220, to: 130, delay: 0, attack: 0.006, length: 0.11, level: 0.35 }],
  // Rising and thinner: something lifted away.
  remove: [{ wave: 'triangle', from: 170, to: 300, delay: 0, attack: 0.006, length: 0.12, level: 0.25 }],
  // A pick on rock: a short low knock under a quick bright tick. Shorter and
  // drier than `place`, since a player mining by hand hears it every second.
  mine: [
    { wave: 'triangle', from: 150, to: 85, delay: 0, attack: 0.005, length: 0.07, level: 0.3 },
    { wave: 'square', from: 1900, to: 1300, delay: 0, attack: 0.005, length: 0.035, level: 0.045 },
  ],
  // Three notes up a major triad: the one sound that is good news.
  research: [
    { wave: 'sine', from: 523, to: 523, delay: 0, attack: 0.01, length: 0.22, level: 0.22 },
    { wave: 'sine', from: 659, to: 659, delay: 0.09, attack: 0.01, length: 0.22, level: 0.22 },
    { wave: 'sine', from: 784, to: 784, delay: 0.18, attack: 0.01, length: 0.36, level: 0.22 },
  ],
  // Two notes down: something needs you. Not a siren — it will be heard often.
  alert: [
    { wave: 'triangle', from: 740, to: 740, delay: 0, attack: 0.008, length: 0.12, level: 0.2 },
    { wave: 'triangle', from: 554, to: 554, delay: 0.12, attack: 0.008, length: 0.16, level: 0.2 },
  ],
});

/** How many sources a sound needs, so the cap can be checked before any start. */
export function sourcesFor(sound: SoundName): number {
  return SOUNDS[sound].length;
}

/** One running machine, as the ear places it. */
export interface HumSource {
  /** Left -1 to right 1, where it is across the screen. */
  readonly pan: number;
  /** 0 at the centre of the screen, 1 at its edge or beyond. */
  readonly distance: number;
}

interface HumVoice {
  readonly gain: GainNode;
  readonly panner: StereoPannerNode | null;
}

export interface AudioEngineOptions {
  /**
   * Makes the context. Injected so a test can hand it a fake and a browser
   * with no Web Audio can hand back null.
   */
  readonly createContext: () => AudioContext | null;
  readonly volume?: number;
  readonly muted?: boolean;
}

export class AudioEngine {
  private readonly createContext: () => AudioContext | null;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume: number;
  private muted: boolean;

  private active = 0;
  private readonly lastPlayed = new Map<SoundName, number>();

  private hum: HumVoice[] | null = null;
  private beltGain: GainNode | null = null;

  constructor(options: AudioEngineOptions) {
    this.createContext = options.createContext;
    this.volume = clamp01(options.volume ?? 0.7);
    this.muted = options.muted ?? false;
  }

  /** Scheduled sources alive right now. Never more than `MAX_SOURCES`. */
  get activeSources(): number {
    return this.active;
  }

  /** Is there a context to play into? False until `unlock`, and forever without Web Audio. */
  get ready(): boolean {
    return this.context !== null;
  }

  /**
   * Build the context, from inside a user gesture. Safe to call on every
   * gesture: the second call only resumes a context the browser suspended.
   */
  unlock(): void {
    if (this.context === null) {
      let context: AudioContext | null = null;
      try {
        context = this.createContext();
      } catch {
        context = null;
      }
      if (context === null) return;
      this.context = context;
      const master = context.createGain();
      master.gain.setValueAtTime(0, context.currentTime);
      master.connect(context.destination);
      this.master = master;
      this.applyMaster();
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    this.applyMaster();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMaster();
  }

  /**
   * Play a one-shot. Returns whether it played.
   *
   * Refused — silently, this is sound — while muted, before `unlock`, inside
   * `REPEAT_GUARD_S` of the same sound, or when it would take the engine
   * over `MAX_SOURCES`.
   */
  play(sound: SoundName): boolean {
    const context = this.context;
    const master = this.master;
    if (context === null || master === null || this.muted || this.volume === 0) return false;

    const now = context.currentTime;
    const last = this.lastPlayed.get(sound);
    if (last !== undefined && now - last < REPEAT_GUARD_S) return false;

    const tones = SOUNDS[sound];
    if (this.active + tones.length > MAX_SOURCES) return false;
    this.lastPlayed.set(sound, now);

    for (const tone of tones) this.startTone(context, master, now, tone);
    return true;
  }

  /**
   * The machines running where the player can hear them. Called a few times
   * a second with every one on screen; the nearest `HUM_VOICES` are voiced and
   * the rest are culled here, by distance, which is task 2's second half.
   */
  setHum(sources: readonly HumSource[]): void {
    const context = this.context;
    if (context === null) return;
    const voices = this.humVoices(context);
    if (voices === null) return;

    const nearest = pickNearest(sources, voices.length);
    const now = context.currentTime;
    voices.forEach((voice, index) => {
      const source = nearest[index];
      const closeness = source === undefined ? 0 : 1 - clamp01(source.distance);
      voice.gain.gain.setTargetAtTime(HUM_LEVEL * closeness * closeness, now, GLIDE_S);
      if (source !== undefined && voice.panner !== null) {
        voice.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, source.pan)) * 0.8, now, GLIDE_S);
      }
    });
  }

  /** How much is moving on the belts on screen, 0 to 1. */
  setBeltLevel(level: number): void {
    const context = this.context;
    if (context === null) return;
    const gain = this.beltVoice(context);
    if (gain === null) return;
    gain.gain.setTargetAtTime(BELT_LEVEL * clamp01(level), context.currentTime, GLIDE_S * 3);
  }

  /** Stop everything and let the context go. */
  close(): void {
    const context = this.context;
    if (context === null) return;
    this.context = null;
    this.master = null;
    this.hum = null;
    this.beltGain = null;
    this.active = 0;
    void context.close().catch(() => undefined);
  }

  private applyMaster(): void {
    const context = this.context;
    if (context === null || this.master === null) return;
    const target = this.muted ? 0 : this.volume;
    this.master.gain.setTargetAtTime(target, context.currentTime, GLIDE_S * 0.5);
  }

  /** Count a source in, and out again when it ends. The only two places `active` moves. */
  private track(source: AudioScheduledSourceNode): void {
    this.active += 1;
    source.addEventListener('ended', () => {
      this.active = Math.max(0, this.active - 1);
    });
  }

  private startTone(context: AudioContext, master: GainNode, now: number, tone: Tone): void {
    const start = now + tone.delay;
    const attack = Math.max(MIN_RAMP_S, tone.attack);
    const end = start + Math.max(tone.length, attack + MIN_RAMP_S);

    const oscillator = context.createOscillator();
    oscillator.type = tone.wave;
    oscillator.frequency.setValueAtTime(tone.from, start);
    if (tone.to !== tone.from) oscillator.frequency.exponentialRampToValueAtTime(tone.to, end);

    const envelope = context.createGain();
    // Silent, up, and back to silent before the stop: no edge anywhere.
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(tone.level, start + attack);
    envelope.gain.linearRampToValueAtTime(0, end);

    oscillator.connect(envelope);
    envelope.connect(master);
    this.track(oscillator);
    oscillator.start(start);
    oscillator.stop(end + MIN_RAMP_S);
  }

  /**
   * The hum voices, built on first use and kept. Each is a low sawtooth under
   * a low-pass filter — a transformer, not a tune — at a slightly different
   * pitch from the others, so four machines are a chord rather than one loud
   * note, and started at zero gain.
   */
  private humVoices(context: AudioContext): HumVoice[] | null {
    if (this.hum !== null) return this.hum;
    const master = this.master;
    if (master === null || this.active + HUM_VOICES > MAX_SOURCES) return null;

    const voices: HumVoice[] = [];
    for (let i = 0; i < HUM_VOICES; i++) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(55 + i * 7, context.currentTime);
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(240, context.currentTime);
      const gain = context.createGain();
      gain.gain.setValueAtTime(0, context.currentTime);
      const panner = typeof context.createStereoPanner === 'function' ? context.createStereoPanner() : null;

      oscillator.connect(filter);
      filter.connect(gain);
      if (panner === null) {
        gain.connect(master);
      } else {
        gain.connect(panner);
        panner.connect(master);
      }
      this.track(oscillator);
      oscillator.start();
      voices.push({ gain, panner });
    }
    this.hum = voices;
    return voices;
  }

  /** The belt voice: a second of noise, looped, band-passed into a rumble. */
  private beltVoice(context: AudioContext): GainNode | null {
    if (this.beltGain !== null) return this.beltGain;
    const master = this.master;
    if (master === null || this.active + 1 > MAX_SOURCES) return null;

    const length = Math.max(1, Math.floor(context.sampleRate));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    // Math.random is fine here: this is sound, not simulation (§6's list).
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(320, context.currentTime);
    filter.Q.setValueAtTime(0.7, context.currentTime);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, context.currentTime);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    this.track(source);
    source.start();
    this.beltGain = gain;
    return gain;
  }
}

/**
 * The `count` sources nearest the centre, nearest first.
 *
 * A partial selection rather than a sort, since there may be thousands and
 * only four are wanted. Ties keep their input order, so the same screen
 * voices the same machines frame to frame and nothing flickers between two.
 */
export function pickNearest(sources: readonly HumSource[], count: number): HumSource[] {
  const best: HumSource[] = [];
  for (const source of sources) {
    if (!(source.distance < 1)) continue;
    let at = best.length;
    while (at > 0 && (best[at - 1]?.distance ?? 0) > source.distance) at -= 1;
    if (at >= count) continue;
    best.splice(at, 0, source);
    if (best.length > count) best.pop();
  }
  return best;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
