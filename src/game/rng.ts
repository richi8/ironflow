/**
 * The seeded pseudo-random number generator. See ironflow.md §6 R2 and C18
 * task 1.
 *
 * §6 R1 bans every ambient source of randomness from `game/` — `Math.random`,
 * `crypto.getRandomValues`, anything derived from a clock — and R2 says what
 * replaces them: one generator, seeded, whose **stream position is
 * authoritative state and must be serialized**. That last clause is the whole
 * design. A generator that cannot say where it is in its stream cannot be
 * saved, and a factory that reloads with every generator rewound to zero is a
 * factory that quietly produces different results after a reload than it did
 * before — §6 R8's failure, found weeks later, with no reproduction.
 *
 * ## Deviation from §6's snippet
 *
 * §6 writes `createRng(seed)` returning a closure. The arithmetic below is
 * that snippet verbatim — mulberry32, the same two `Math.imul`s, the same
 * shifts, the same `/ 4294967296` — but it lives on a class, because a closure
 * hides `s`, and `s` is exactly the thing the contract requires to be
 * serializable. `createRng` is kept as the one-line convenience §6 names, and
 * it returns a bound `next` off the same object, so there is one implementation
 * and not two.
 *
 * ## Why mulberry32 rather than something stronger
 *
 * It is 32 bits of state, it passes gjrand's smallcrush, and it is *fast* and
 * *exactly reproducible in JavaScript* — which is the only property that
 * matters here. Nothing in IronFlow is cryptographic and nothing is
 * statistically demanding: §6 lists the uses as worldgen and jitter. A larger
 * generator would be more state in every save for no observable difference.
 *
 * ## What is not here
 *
 * **Worldgen's positional stream.** §6 R2 says worldgen uses a *separate*,
 * positionally-derived stream — `hash(seed, cx, cy)` — so that generating
 * world chunks in a different order still yields the same world, and so that
 * worldgen never consumes the simulation stream. That hash belongs to C19's
 * generator, which is the first thing that will need it; writing it here
 * before then would be a function with no caller (§19 rule 10).
 *
 * **A consumer.** As of C18 nothing in the game draws a random number: every
 * decision in the simulation is a deterministic round-robin or a counter, on
 * purpose. This file is here because §6 R2 names it and C18's job is to make
 * §6 true — and because the *seed* is already real state, carried by
 * `Simulation` and folded into the determinism hash from this chunk onward, so
 * the day C19 draws from the stream the round-trip test already covers it.
 */

/** Mulberry32's increment. §6 R2's `0x6d2b79f5`, and the reason it is odd. */
const STEP = 0x6d2b79f5;

/** 2^32, the divisor that maps a 32-bit result onto `[0, 1)`. */
const UINT32_RANGE = 4294967296;

/**
 * A seeded stream of numbers whose position can be read and restored.
 *
 * The position **is** the state: mulberry32 keeps one 32-bit word, advances it
 * by a constant and scrambles it, so "where the stream is" and "what the
 * generator holds" are the same number. That is what makes `state` a field a
 * save can carry rather than a count of calls a loader would have to replay.
 */
export class Rng {
  /** The 32-bit state word. Authoritative (§10), serialized (§6 R2). */
  private s: number;

  /**
   * `seed` is coerced to a 32-bit unsigned integer, because that is what the
   * arithmetic below operates on and because a caller handing in a float or a
   * negative number should get a usable stream rather than `NaN` for ever
   * (§6 R7).
   */
  constructor(seed: number) {
    this.s = toUint32(seed);
  }

  /** Resume a stream from a saved position. See `state`. */
  static fromState(state: number): Rng {
    const rng = new Rng(0);
    rng.s = toUint32(state);
    return rng;
  }

  /**
   * Where the stream is. Persist this, not the number of calls made.
   *
   * Always a whole number in `[0, 2^32)`, so it survives `JSON.stringify` and
   * `structuredClone` identically — which is what `entities/entity.ts`'s
   * serializability rule asks of every field a save carries.
   */
  get state(): number {
    return this.s;
  }

  /** The next number in `[0, 1)`. */
  next(): number {
    this.s = (this.s + STEP) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  }

  /**
   * The next whole number in `[0, bound)`.
   *
   * Multiply-and-floor rather than a modulus, because a modulus over a
   * non-power-of-two bound is biased toward the low values — invisible in
   * play, and exactly the sort of thing a worldgen balance pass would chase
   * for a day. `bound` must be a positive integer; anything else is a caller
   * bug, not a value to guess at, so it throws (§6 R7: never invent a number).
   */
  nextInt(bound: number): number {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new RangeError(`Rng.nextInt: bound must be a positive integer, got ${bound}.`);
    }
    return Math.floor(this.next() * bound);
  }
}

/**
 * §6 R2's `createRng`, over the class above.
 *
 * Returns the stream's `next` alone, for a caller that only wants numbers and
 * has no state to persist — a test fixture, or a piece of presentation-side
 * jitter, which §6 explicitly permits to be non-authoritative. Anything inside
 * the simulation holds the `Rng` itself, because it has a position to save.
 */
export function createRng(seed: number): () => number {
  const rng = new Rng(seed);
  return () => rng.next();
}

/**
 * A seed as the 32-bit unsigned integer the generator runs on.
 *
 * `>>> 0` alone turns `NaN` and `Infinity` into `0`, silently, which is how
 * two different worlds end up sharing a seed. This rejects them instead and
 * truncates everything else, so the mapping from "what the player typed" to
 * "which world they get" is one a save can reproduce.
 */
export function toUint32(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Rng: a seed must be a finite number, got ${String(value)} (§6 R7).`);
  }
  return Math.trunc(value) >>> 0;
}
