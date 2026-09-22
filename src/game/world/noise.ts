/**
 * Hand-written integer hashing and value noise. See ironflow.md C19 task 2.
 *
 * C19 asks for "2–3 octaves of value noise for elevation and moisture" and for
 * the noise to be hand-written (~60 lines). This is that, plus the positional
 * hash §6 R2 names — `hash(seed, cx, cy)` — because the two are the same
 * arithmetic and splitting them across files would mean two copies of the same
 * mixing constants.
 *
 * ## Why this is deterministic, and what would break it
 *
 * Every hash below is 32-bit integer arithmetic through `Math.imul`, `^` and
 * `>>>`, all of which are exactly specified by the language. Interpolation is
 * `+`, `-`, `*` and `/` on doubles, which IEEE-754 specifies exactly and which
 * every JavaScript engine therefore agrees on bit for bit.
 *
 * What is **banned here**, and the reason C19's world survives a browser
 * change: `Math.sin`, `Math.cos`, `Math.pow`, `Math.exp` and `Math.log` are
 * *not* exactly specified — an engine may return a result one ulp from
 * another's. A gradient noise built on `Math.sin`, the usual shadertoy idiom,
 * would give two players slightly different coastlines from the same seed, and
 * the difference would show up as a save that fails to reload identically
 * months later. `Math.sqrt` is allowed: IEEE-754 requires it to be correctly
 * rounded, and it is the one transcendental-looking operation that is exact.
 *
 * ## Why value noise rather than Perlin or simplex
 *
 * Value noise is a hash at lattice corners and a smooth interpolation between
 * them. Perlin adds gradients, which buys a less blocky look at the cost of a
 * gradient table, and simplex adds a skewed lattice on top of that. Neither
 * difference survives being quantised to five terrain types and drawn as
 * flat-shaded tiles, and §3's dependency policy applies to complexity as much
 * as to packages.
 */

/** murmur3's finaliser constants. Chosen for avalanche, not for beauty. */
const MIX_A = 0x85ebca6b;
const MIX_B = 0xc2b2ae35;

/** Odd multipliers that fold each coordinate into the running hash. */
const SALT_X = 0x27d4eb2d;
const SALT_Y = 0x165667b1;
const SALT_Z = 0x9e3779b1;

/** 2^32, the divisor mapping a 32-bit hash onto `[0, 1)`. Same as `rng.ts`. */
const UINT32_RANGE = 4294967296;

/**
 * murmur3's 32-bit finaliser: one integer in, one well-scrambled integer out.
 *
 * Every hash in this file is this function with the inputs folded in one at a
 * time. It matters that it avalanches — that flipping one bit of the input
 * changes about half the output bits — because the lattice coordinates handed
 * to it differ by **one** between neighbouring tiles, and a weak mixer would
 * produce visibly correlated neighbours: diagonal banding across the map that
 * looks like a rendering artefact rather than like a hash.
 */
export function mix32(value: number): number {
  let h = value | 0;
  h ^= h >>> 16;
  h = Math.imul(h, MIX_A);
  h ^= h >>> 13;
  h = Math.imul(h, MIX_B);
  h ^= h >>> 16;
  return h >>> 0;
}

/** §6 R2's `hash(seed, x, y)`, as a 32-bit unsigned integer. */
export function hash2(seed: number, x: number, y: number): number {
  const a = mix32((seed ^ Math.imul(x | 0, SALT_X)) | 0);
  return mix32((a ^ Math.imul(y | 0, SALT_Y)) | 0);
}

/** `hash2` with a third coordinate — a resource type, or a patch-grid cell. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  return mix32((hash2(seed, x, y) ^ Math.imul(z | 0, SALT_Z)) | 0);
}

/** A hash as a number in `[0, 1)`. */
export function unitFloat(hash: number): number {
  return (hash >>> 0) / UINT32_RANGE;
}

/**
 * Hermite smoothing, `3t² − 2t³`.
 *
 * Linear interpolation between lattice corners would leave the lattice visible
 * as a grid of creases where the derivative jumps. This has zero derivative at
 * both ends, so the octaves join invisibly — which is the whole reason value
 * noise looks like terrain rather than like a quilt.
 */
function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Read a typed-array slot that is provably in range.
 *
 * `noUncheckedIndexedAccess` types every read as possibly `undefined` and
 * `no-non-null-assertion` is a lint error, so the check is written out. It is
 * unreachable while the octave index is in range — which is why it throws
 * rather than substituting a default: silently sampling octave zero would make
 * the map subtly wrong in a way no test would name.
 */
function at(array: Float64Array | Int32Array, index: number): number {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`NoiseField: index ${index} is outside the octave arrays.`);
  }
  return value;
}

/** How each successive octave's amplitude shrinks. */
const DEFAULT_GAIN = 0.5;

/** How each successive octave's frequency grows. */
const DEFAULT_LACUNARITY = 2;

export interface NoiseFieldOptions {
  /** Cycles per tile of the first octave. `1 / 96` is a feature every 96 tiles. */
  readonly frequency: number;
  /** How many octaves are summed. C19 asks for two or three. */
  readonly octaves: number;
  readonly gain?: number;
  readonly lacunarity?: number;
}

/**
 * Fractal value noise over tile space, sampled one point at a time.
 *
 * Pure and positional in C19's sense: `sample(x, y)` depends on the seed and
 * the coordinates and on nothing else — not on which points were sampled
 * before, not on how many, not on the order. The one-cell memo below is the
 * only state and it is transparent, in the sense that a memo hit and a memo
 * miss return the same number. A test samples a shuffled grid and compares it
 * against a freshly built field, which is what keeps that true.
 *
 * ## Why the memo exists
 *
 * A sample costs four hashes per octave. Chunk generation walks tiles
 * row-major, and the first octave's lattice is 96 tiles wide, so ~96
 * consecutive samples fall in the same lattice cell and want the same four
 * corner values. Caching the last cell per octave turns twenty hashes per tile
 * into roughly one, which is most of the difference between C19's 500 ms
 * budget for a 40×40-chunk world and several seconds.
 */
export class NoiseField {
  private readonly frequency: number;
  private readonly octaves: number;
  private readonly gain: number;
  private readonly lacunarity: number;
  /** Divides the summed octaves back into `[0, 1]`. */
  private readonly normalizer: number;

  /** Per-octave seed, so two octaves of the same field never correlate. */
  private readonly octaveSeeds: Int32Array;

  /**
   * Where in the noise this field's origin sits. Derived from the seed.
   *
   * Without it, tile (0, 0) lands exactly on a lattice corner of every octave,
   * so `sample(0, 0)` is a raw hash with no interpolation — **uniformly**
   * distributed, where every other tile in the world is the bell-shaped
   * average of four. The spawn tile is therefore the one tile in the world
   * that does not obey the generator's own terrain distribution, and it showed
   * up as exactly that: a third of all seeds put the player in a lake, against
   * a global water coverage of an eighth. The same artefact ran through the
   * ore-density field, where every patch cell near the origin shared one
   * corner value and a seed's starting area was all-or-nothing per resource.
   *
   * A seed-derived offset moves the origin off the lattice and, incidentally,
   * decorrelates two fields that share a seed. It is not a fudge factor: the
   * bug is that a lattice has special points, and this is what stops one of
   * them from being the place the game starts.
   */
  private readonly offsetX: number;
  private readonly offsetY: number;

  /* The one-cell memo: the lattice cell each octave last sampled, and its four
   * corner values. `cellX` starts at a coordinate no lattice cell can hold, so
   * the first sample always misses rather than needing a separate valid flag. */
  private readonly cellX: Int32Array;
  private readonly cellY: Int32Array;
  private readonly corners: Float64Array;

  constructor(seed: number, options: NoiseFieldOptions) {
    const { frequency, octaves, gain = DEFAULT_GAIN, lacunarity = DEFAULT_LACUNARITY } = options;
    if (!Number.isInteger(octaves) || octaves < 1) {
      throw new RangeError(`NoiseField: octaves must be a positive integer, got ${octaves}.`);
    }
    if (!(frequency > 0) || !Number.isFinite(frequency)) {
      throw new RangeError(`NoiseField: frequency must be a positive number, got ${frequency}.`);
    }

    this.frequency = frequency;
    this.octaves = octaves;
    this.gain = gain;
    this.lacunarity = lacunarity;

    let total = 0;
    let amplitude = 1;
    for (let o = 0; o < octaves; o++) {
      total += amplitude;
      amplitude *= gain;
    }
    this.normalizer = total;

    this.octaveSeeds = new Int32Array(octaves);
    for (let o = 0; o < octaves; o++) {
      this.octaveSeeds[o] = mix32((seed ^ Math.imul(o + 1, SALT_Z)) | 0) | 0;
    }

    // A few thousand tiles, which is far enough that no octave's lattice lines
    // up with the tile grid's origin at any frequency this project uses.
    this.offsetX = unitFloat(mix32((seed ^ 0x1b873593) | 0)) * 8192;
    this.offsetY = unitFloat(mix32((seed ^ 0x38b34ae5) | 0)) * 8192;

    this.cellX = new Int32Array(octaves).fill(0x7fffffff);
    this.cellY = new Int32Array(octaves).fill(0x7fffffff);
    this.corners = new Float64Array(octaves * 4);
  }

  /** The field at a tile position, in `[0, 1]`. Fractional coordinates welcome. */
  sample(x: number, y: number): number {
    const ox = x + this.offsetX;
    const oy = y + this.offsetY;
    let total = 0;
    let amplitude = 1;
    let frequency = this.frequency;

    for (let o = 0; o < this.octaves; o++) {
      total += amplitude * this.octave(o, ox * frequency, oy * frequency);
      amplitude *= this.gain;
      frequency *= this.lacunarity;
    }

    return total / this.normalizer;
  }

  /** One octave at a point already scaled into that octave's lattice space. */
  private octave(o: number, nx: number, ny: number): number {
    const x0 = Math.floor(nx);
    const y0 = Math.floor(ny);

    if (at(this.cellX, o) !== x0 || at(this.cellY, o) !== y0) {
      const seed = at(this.octaveSeeds, o);
      const base = o * 4;
      this.corners[base] = unitFloat(hash2(seed, x0, y0));
      this.corners[base + 1] = unitFloat(hash2(seed, x0 + 1, y0));
      this.corners[base + 2] = unitFloat(hash2(seed, x0, y0 + 1));
      this.corners[base + 3] = unitFloat(hash2(seed, x0 + 1, y0 + 1));
      this.cellX[o] = x0;
      this.cellY[o] = y0;
    }

    const base = o * 4;
    const u = smooth(nx - x0);
    const v = smooth(ny - y0);
    return lerp(
      lerp(at(this.corners, base), at(this.corners, base + 1), u),
      lerp(at(this.corners, base + 2), at(this.corners, base + 3), u),
      v,
    );
  }
}
