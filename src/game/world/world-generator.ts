/**
 * Procedural world generation. See ironflow.md C19 and §6 R2.
 *
 * This is pillar 2 — "replayability from the world, not from content volume" —
 * and it replaces the checkerboard C02 sanctioned and the hand-placed patches
 * C09 stamped near the origin. Both were scaffolding and both are gone; what
 * is left of them lives in `tests/fixtures/world-fixtures.ts`, where a fixed
 * pattern is what a test of some *other* system actually wants.
 *
 * ## The two rules this file exists to keep
 *
 * **Pure and positional (C19 task 1).** Generating world chunk (5, 5) gives the
 * same result whether it is the first world chunk asked for or the thousandth.
 * Nothing here consumes the simulation's RNG stream, and nothing accumulates
 * across calls except a noise memo that cannot change an answer. The per-chunk
 * scratch buffers are cleared on entry, not on exit, so a half-finished chunk
 * from a thrown error cannot leak into the next one.
 *
 * **Every stream is derived from position (§6 R2).** A patch site is drawn
 * from `new Rng(hash3(seed, cellX, cellY, resource))` — one throwaway stream
 * per patch-grid cell, which is exactly what makes a patch the same patch
 * however the player reached it.
 *
 * ## Shape of the world
 *
 * ```text
 * elevation   3 octaves, 1/96 tiles   water < sand < (grass|dirt) < stone
 * moisture    2 octaves, 1/140 tiles  splits the middle band grass/dirt
 * patches     one jittered grid per resource, each cell holding at most one
 *             ellipse: its own size, aspect, orientation, edge wobble and
 *             richness, all scaling with distance from the origin
 * ```
 *
 * C19 task 3 describes the patch layer as "a separate low-frequency noise per
 * resource type, thresholded". A jittered grid is used instead, and the reason
 * is the sentence immediately after it in the plan: *"per-patch variation in
 * size, shape and richness ... a long thin iron patch and a round one produce
 * different factories."* A thresholded noise field has no notion of a patch, so
 * it cannot vary anything *per patch* — every blob it produces is the same size
 * distribution with the same roundness, and richness could only be a function
 * of position rather than of the deposit. The grid gives each deposit an
 * identity to hang those four numbers on; the low-frequency noise is still
 * here, as the wobble that stops every patch from being a visible ellipse.
 * Recorded as a deviation in the plan's C19 section.
 */

import { Rng } from '../rng.js';
import { CHUNK_AREA, CHUNK_SIZE, createChunk, localIndex, type WorldChunk } from './chunk.js';
import { NoiseField, hash3 } from './noise.js';
import { NOMINAL_RESOURCE_AMOUNT, RESOURCE_TYPE_COUNT, ResourceType } from './resource.js';
import { TileType } from './tile.js';
import type { ChunkGenerator } from './world.js';

/* -------------------------------------------------------------------------- *
 * Version
 * -------------------------------------------------------------------------- */

/**
 * Which generator produced a world. C19 task 6; written into saves by §14.
 *
 * Bumped whenever a change to this file would give an existing seed a
 * different map — a threshold moved, an octave added, a patch constant
 * retuned. It is **not** bumped for a change that cannot move a tile.
 *
 * The number is what C27 migrates against: a save carrying an older version
 * must either pin the old generator or accept that its unexplored world has
 * changed underneath it, and it cannot make that choice without being told
 * which generator it was written by. Nothing reads it yet — C24 is the first
 * caller — and it is here rather than in C24 because the constant belongs
 * beside the code whose identity it states.
 */
export const GENERATOR_VERSION = 1;

/* -------------------------------------------------------------------------- *
 * Terrain
 * -------------------------------------------------------------------------- */

/** Cycles per tile of the elevation field's first octave: a feature per 96. */
const ELEVATION_FREQUENCY = 1 / 96;
const ELEVATION_OCTAVES = 3;

/** Moisture varies more slowly than elevation, so biomes are broader than lakes. */
const MOISTURE_FREQUENCY = 1 / 140;
const MOISTURE_OCTAVES = 2;

/**
 * Where the terrain bands fall on the elevation field.
 *
 * Three octaves of value noise at gain 0.5 land close to a bell around 0.5, so
 * these are chosen by standard deviations rather than by taste: water covers
 * roughly an eighth of the map, which is enough that routing around a lake is
 * a real decision (pillar 4) and little enough that a starting area is almost
 * always playable. The sand band is thin on purpose — it is a shoreline, not a
 * desert. Every number here is a **balance number** and belongs to C20's pass.
 */
const WATER_LEVEL = 0.345;
const SHORE_LEVEL = 0.375;
const STONE_LEVEL = 0.695;

/** Below this much moisture the middle band is dirt rather than grass. */
const DRY_LEVEL = 0.45;

/* -------------------------------------------------------------------------- *
 * Patches
 * -------------------------------------------------------------------------- */

/**
 * How a resource lays itself out. One entry per `ResourceType`, in enum order.
 *
 * `cellSize` is the patch grid's pitch in tiles and `chance` how often a cell
 * holds a deposit, so the two together set density: one patch per
 * `cellSize² / chance` tiles. The radii are the deposit's *mean* radius before
 * aspect and distance scaling — a patch of mean radius 4 covers about fifty
 * tiles, which is one miner's worth of ore for an hour at §15's rates.
 *
 * The four resources are deliberately on **different grid pitches**. On a
 * shared pitch every cell would hold one of each and the map would read as a
 * repeating tile; coprime-ish pitches make iron-next-to-coal a lucky spot
 * rather than a guaranteed one, which is the layout decision pillar 4 wants.
 *
 * Balance numbers, every one of them. C20 tunes them; C19 only has to make
 * them produce a world that is different every seed and playable at the start.
 */
interface PatchKind {
  readonly resource: ResourceType;
  /** Pitch of this resource's patch grid, in tiles. */
  readonly cellSize: number;
  /** Probability that a cell holds a deposit at all. */
  readonly chance: number;
  readonly minRadius: number;
  readonly maxRadius: number;
  /**
   * Largest ratio between a patch's long and short axis.
   *
   * The one number C19 task 3 singles out: "a long thin iron patch and a round
   * one produce different factories". Area is held constant as aspect varies,
   * so a stretched patch is *thin*, not merely bigger.
   */
  readonly maxAspect: number;
  /** Cycles per tile of the noise that roughens this resource's patch edges. */
  readonly wobbleFrequency: number;
  /** How far, as a fraction of the radius, the edge may wander in or out. */
  readonly wobbleAmount: number;
}

const PATCH_KINDS: readonly PatchKind[] = Object.freeze([
  Object.freeze({
    resource: ResourceType.Iron,
    cellSize: 26,
    chance: 0.95,
    minRadius: 2.6,
    maxRadius: 5.4,
    maxAspect: 3.2,
    wobbleFrequency: 1 / 7,
    wobbleAmount: 0.32,
  }),
  Object.freeze({
    resource: ResourceType.Copper,
    cellSize: 26,
    chance: 0.94,
    minRadius: 2.4,
    maxRadius: 4.9,
    maxAspect: 2.7,
    wobbleFrequency: 1 / 6,
    wobbleAmount: 0.34,
  }),
  Object.freeze({
    resource: ResourceType.Coal,
    cellSize: 27,
    chance: 0.94,
    minRadius: 2.5,
    maxRadius: 5.1,
    maxAspect: 2.2,
    wobbleFrequency: 1 / 9,
    wobbleAmount: 0.3,
  }),
  Object.freeze({
    resource: ResourceType.Stone,
    cellSize: 27,
    chance: 0.94,
    minRadius: 2.2,
    maxRadius: 4.4,
    maxAspect: 2.5,
    wobbleFrequency: 1 / 8,
    wobbleAmount: 0.32,
  }),
]);

/* -------------------------------------------------------------------------- *
 * Where a resource is common, and where it is not
 * -------------------------------------------------------------------------- */

/**
 * The low-frequency field that decides how many deposits a region holds.
 *
 * This is C19 task 3's "separate low-frequency noise per resource type,
 * thresholded", in the place it does the most good. Without it every cell of
 * every grid is an independent coin flip, and the result — visible in the
 * first map this generator produced — is confetti: all four ores evenly
 * interleaved everywhere, so no direction is worth walking in and no piece of
 * ground is worth more than any other. Pillar 4 is "meaningful layout
 * decisions", and a uniform map has none to offer.
 *
 * With it, the map has iron country and copper country, and the good spots are
 * the seams between them. That is also what makes starting-area validation
 * worth having rather than a formality: a spawn that passes it is a spawn on
 * one of those seams.
 *
 * A region is about 200 tiles across — a few screens, and roughly the distance
 * C23's radar will show at once.
 */
const DENSITY_FREQUENCY = 1 / 200;
const DENSITY_OCTAVES = 2;

/** Below this the field is at its floor; above `DENSITY_HIGH` it is at full. */
const DENSITY_LOW = 0.36;
const DENSITY_HIGH = 0.68;

/**
 * How dense the poorest region is, as a fraction of the richest.
 *
 * Not zero. A region with *no* iron at all is indistinguishable from a bug
 * while the player is standing in it, and it makes a long walk end in nothing,
 * which is the least interesting way a factory game can spend five minutes.
 * A tenth is scarce enough to be worth leaving and not so scarce that leaving
 * is compulsory.
 */
const DENSITY_FLOOR = 0.22;

/**
 * How far from the origin a patch has to be to be fully grown. C19 task 4.
 *
 * Expansion has to pay, or the map is decoration. A deposit this far out is
 * twice as rich per tile and about two thirds again as wide as one at the
 * spawn, which is roughly three times the ore in one place — enough that
 * moving a factory outward is worth the belt run, and not so much that the
 * starting area becomes a trap the player has to leave immediately.
 *
 * A thousand tiles is about four minutes of walking at §15's 4 tiles/s, and
 * C23's radar is what makes that trip a decision rather than a wander.
 */
const SCALE_RANGE = 1024;

/** How much wider a patch at `SCALE_RANGE` is than one at the origin. */
const RADIUS_GROWTH = 0.4;

/**
 * How much of a region's deposit *count* is traded away for that extra size.
 *
 * Distant deposits are bigger and richer (C19 task 4) but rarer, so the total
 * ore under a distant square mile is about what it is at home while being
 * concentrated into a third as many places. That is the shape that makes
 * expansion a decision: the far patch is worth a long belt run precisely
 * because there is not another one behind it.
 */
const CHANCE_FALLOFF = 0.7;

/**
 * How much richer a patch at `SCALE_RANGE` is than one at the origin.
 *
 * Capped at exactly 1 — a doubling — because C09 fixed the four ore-pile
 * fullness buckets to an *absolute* scale against `NOMINAL_RESOURCE_AMOUNT`
 * and asked C19 to revisit that "if patch richness ends up varying by more
 * than about 2x". With `PEAK_MAX` at 1 the richest tile in the world holds
 * exactly two nominal tiles, which sits on that line rather than over it: a
 * far patch reads as full until it is half mined, and no closer patch is
 * misread at all. Going further would mean a second `Uint16Array` per world
 * chunk recording each tile's original amount, which is 2 KB per world chunk
 * and a field in every save to answer a question only ever asked about a
 * pixel. C20 owns this trade; C19 stays inside C09's stated tolerance.
 */
const RICHNESS_GROWTH = 1;

/** The range a patch's own richness multiplier is drawn from, before distance. */
const PEAK_MIN = 0.72;
const PEAK_MAX = 1;

/**
 * What a patch tile holds at its outermost ring. A tenth of a full tile.
 *
 * Inherited from C09's stub, with its reasoning: a tile inside a patch outline
 * with nothing on it reads as a rendering bug, and it would make the miner's
 * "needs at least one resource tile" rule depend on where the ellipse's edge
 * happened to land.
 */
const RIM_AMOUNT = Math.round(NOMINAL_RESOURCE_AMOUNT / 10);

/** Salt keeping the patch grids off the elevation field's stream. */
const PATCH_SALT = 0x5eed1f0f | 0;

/**
 * One deposit, resolved from its grid cell.
 *
 * `ux, uy` is the unit vector along the long axis; `ra` and `rb` are the radii
 * along and across it. The bounding box is precomputed because chunk
 * generation tests every tile of it and a rejected patch should cost an
 * integer comparison rather than an ellipse.
 */
interface PatchSite {
  readonly resource: ResourceType;
  readonly kind: PatchKind;
  readonly x: number;
  readonly y: number;
  readonly ux: number;
  readonly uy: number;
  readonly ra: number;
  readonly rb: number;
  readonly peak: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/**
 * The deposit in one cell of one resource's patch grid, or `null` for none.
 *
 * Every number comes off one throwaway `Rng` seeded from the cell's
 * coordinates, **drawn in a fixed order**. The order is the thing: adding a
 * draw in the middle of this function shifts every later draw and changes
 * every patch in the world, which is precisely what `GENERATOR_VERSION` is for.
 */
function patchSite(
  seed: number,
  kind: PatchKind,
  gx: number,
  gy: number,
  density: number,
): PatchSite | null {
  const rng = new Rng(hash3(seed ^ PATCH_SALT, gx, gy, kind.resource));

  // Jittered within the cell, so the grid is never visible as a grid. Drawn
  // before the presence test even though a missing deposit has no position:
  // the test needs to know how far out the cell is, and a stream whose draws
  // depend on the answer to one of its own draws is a stream that cannot be
  // reordered without changing every map.
  const x = (gx + rng.next()) * kind.cellSize;
  const y = (gy + rng.next()) * kind.cellSize;

  // Distance-based scaling (C19 task 4), measured at the centre so a deposit
  // has one richness rather than a gradient across it.
  const growth = Math.min(1, Math.sqrt(x * x + y * y) / SCALE_RANGE);

  if (rng.next() >= kind.chance * density * (1 - CHANCE_FALLOFF * growth)) return null;

  const radius =
    (kind.minRadius + (kind.maxRadius - kind.minRadius) * rng.next()) * (1 + RADIUS_GROWTH * growth);

  // Area is held constant as aspect varies: one axis grows by √aspect exactly
  // as much as the other shrinks, so a stretched patch is thin rather than big.
  const aspect = 1 + (kind.maxAspect - 1) * rng.next();
  const stretch = Math.sqrt(aspect);
  const ra = radius * stretch;
  const rb = radius / stretch;

  const { ux, uy } = unitDirection(rng);

  const richness = PEAK_MIN + (PEAK_MAX - PEAK_MIN) * rng.next();
  const peak = Math.round(NOMINAL_RESOURCE_AMOUNT * richness * (1 + RICHNESS_GROWTH * growth));

  // The bound has to cover the edge at its furthest wander outward.
  const reach = Math.max(ra, rb) * (1 + kind.wobbleAmount);

  return {
    resource: kind.resource,
    kind,
    x,
    y,
    ux,
    uy,
    ra,
    rb,
    peak,
    minX: Math.floor(x - reach),
    maxX: Math.ceil(x + reach),
    minY: Math.floor(y - reach),
    maxY: Math.ceil(y + reach),
  };
}

/**
 * The density field, remapped into the multiplier `patchSite` applies.
 *
 * A ramp rather than a hard threshold: a step would draw a visible line across
 * the map where deposits stop, and the edge of an ore region should be a place
 * where they thin out.
 */
function densityMultiplier(sample: number): number {
  const t = Math.min(1, Math.max(0, (sample - DENSITY_LOW) / (DENSITY_HIGH - DENSITY_LOW)));
  return DENSITY_FLOOR + (1 - DENSITY_FLOOR) * t;
}

/**
 * A unit vector, drawn from two coordinates in a square and normalised.
 *
 * Not `Math.cos(angle)`: `Math.cos` is not exactly specified by IEEE-754, so
 * two engines may disagree in the last bit and hand two players subtly
 * different patch outlines from the same seed (see `noise.ts`). `Math.sqrt`
 * is exact, which makes normalising a square draw the deterministic way to
 * get a direction.
 *
 * The cost is a slight bias toward the diagonals, because a square has more
 * area in its corners than a circle does. It is invisible under an edge wobble
 * of 30% and not worth a rejection loop to remove.
 */
function unitDirection(rng: Rng): { readonly ux: number; readonly uy: number } {
  const dx = rng.next() * 2 - 1;
  const dy = rng.next() * 2 - 1;
  const length = Math.sqrt(dx * dx + dy * dy);
  // Both draws landing on exactly 0.5 is a 2^-64 event, but a zero-length
  // direction would divide by zero and put NaN into the world (§6 R7).
  if (!(length > 1e-9)) return { ux: 1, uy: 0 };
  return { ux: dx / length, uy: dy / length };
}

/* -------------------------------------------------------------------------- *
 * The generator
 * -------------------------------------------------------------------------- */

/**
 * Read a claim slot that is provably in range.
 *
 * Same bargain as `World.at`: `noUncheckedIndexedAccess` types the read as
 * possibly `undefined` and `no-non-null-assertion` is a lint error, so the
 * impossible branch is written out and throws rather than defaulting. A
 * silent `0` here would let every out-of-range stamp win its claim.
 */
function claimAt(array: Float64Array, index: number): number {
  const value = array[index];
  if (value === undefined) {
    throw new RangeError(`WorldGenerator: local index ${index} is outside [0, ${CHUNK_AREA}).`);
  }
  return value;
}

/**
 * The world generator for one seed.
 *
 * A class rather than a closure because it owns three pieces of reusable
 * scratch — the noise fields' lattice memo, and the two per-chunk claim
 * buffers — and holding them means a 1,600-chunk world allocates six buffers
 * rather than 4,800. None of it is state in the §10 sense: no field can change
 * what `generate(cx, cy)` returns.
 */
class WorldGenerator {
  private readonly seed: number;
  private readonly elevation: NoiseField;
  private readonly moisture: NoiseField;
  /** One edge-wobble field per resource, indexed by `ResourceType`. */
  private readonly wobble: readonly (NoiseField | null)[];
  /** One regional-density field per resource, indexed by `ResourceType`. */
  private readonly density: readonly (NoiseField | null)[];

  /**
   * Which claim currently owns each tile of the chunk being generated.
   *
   * Patches are stamped one at a time over their own bounding box rather than
   * every patch being tested against every tile, so two overlapping deposits
   * need somewhere to argue. The tile goes to whichever claim reaches further
   * in from its own edge — the deposit the tile is more deeply inside — which
   * is both the visually right answer and one that does not depend on the
   * order the sites were visited.
   */
  private readonly claimDepth = new Float64Array(CHUNK_AREA);

  constructor(seed: number) {
    this.seed = seed | 0;
    this.elevation = new NoiseField(this.seed, {
      frequency: ELEVATION_FREQUENCY,
      octaves: ELEVATION_OCTAVES,
    });
    // A different salt, or elevation and moisture would be the same field and
    // every dry place would be high ground.
    this.moisture = new NoiseField((this.seed ^ 0x4d01573e) | 0, {
      frequency: MOISTURE_FREQUENCY,
      octaves: MOISTURE_OCTAVES,
    });

    // Dense and pre-filled, never sparse: a hole would read as `undefined`
    // rather than as the `null` the lookup below checks for.
    const wobble: (NoiseField | null)[] = new Array<NoiseField | null>(RESOURCE_TYPE_COUNT).fill(null);
    const density: (NoiseField | null)[] = new Array<NoiseField | null>(RESOURCE_TYPE_COUNT).fill(null);
    for (const kind of PATCH_KINDS) {
      wobble[kind.resource] = new NoiseField((this.seed ^ Math.imul(kind.resource, 0x2545f491)) | 0, {
        frequency: kind.wobbleFrequency,
        octaves: 2,
      });
      density[kind.resource] = new NoiseField((this.seed ^ Math.imul(kind.resource, 0x7feb352d)) | 0, {
        frequency: DENSITY_FREQUENCY,
        octaves: DENSITY_OCTAVES,
      });
    }
    this.wobble = wobble;
    this.density = density;
  }

  generate = (cx: number, cy: number): WorldChunk => {
    const chunk = createChunk(cx, cy);
    const originX = cx * CHUNK_SIZE;
    const originY = cy * CHUNK_SIZE;

    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      const y = originY + ly;
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        chunk.terrain[localIndex(lx, ly)] = this.terrainAt(originX + lx, y);
      }
    }

    this.claimDepth.fill(0);
    for (const kind of PATCH_KINDS) {
      this.stampPatches(chunk, kind, originX, originY);
    }

    return chunk;
  };

  /** The terrain type at a tile. The whole of C19 task 2. */
  private terrainAt(x: number, y: number): TileType {
    const elevation = this.elevation.sample(x, y);
    if (elevation < WATER_LEVEL) return TileType.Water;
    if (elevation < SHORE_LEVEL) return TileType.Sand;
    if (elevation > STONE_LEVEL) return TileType.Stone;
    return this.moisture.sample(x, y) < DRY_LEVEL ? TileType.Dirt : TileType.Grass;
  }

  /**
   * Stamp every deposit of one resource that reaches into this world chunk.
   *
   * The cell range is the chunk's tile range widened by the largest a deposit
   * of this kind can be, because a patch centred in the next cell over still
   * reaches in. Getting that margin wrong is the one bug in this file that
   * would be invisible in a test of a single chunk and obvious on a map: ore
   * sliced off at a world-chunk boundary.
   */
  private stampPatches(chunk: WorldChunk, kind: PatchKind, originX: number, originY: number): void {
    const reach = kind.maxRadius * (1 + RADIUS_GROWTH) * Math.sqrt(kind.maxAspect) * (1 + kind.wobbleAmount);
    const minGx = Math.floor((originX - reach) / kind.cellSize);
    const maxGx = Math.floor((originX + CHUNK_SIZE - 1 + reach) / kind.cellSize);
    const minGy = Math.floor((originY - reach) / kind.cellSize);
    const maxGy = Math.floor((originY + CHUNK_SIZE - 1 + reach) / kind.cellSize);

    const field = this.wobble[kind.resource] ?? null;
    const density = this.density[kind.resource] ?? null;
    if (field === null || density === null) {
      throw new Error(`WorldGenerator: no noise fields for resource ${kind.resource}.`);
    }

    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        // Sampled at the cell's nominal centre, not at the jittered deposit:
        // the deposit's position is drawn from a stream this decision comes
        // before, and a region's density must not depend on where inside its
        // cell a deposit happened to land.
        const regional = densityMultiplier(
          density.sample((gx + 0.5) * kind.cellSize, (gy + 0.5) * kind.cellSize),
        );
        const site = patchSite(this.seed, kind, gx, gy, regional);
        if (site === null) continue;
        this.stampSite(chunk, site, field, originX, originY);
      }
    }
  }

  /** Write one deposit into the tiles of this world chunk it covers. */
  private stampSite(
    chunk: WorldChunk,
    site: PatchSite,
    wobble: NoiseField,
    originX: number,
    originY: number,
  ): void {
    const fromX = Math.max(site.minX, originX);
    const toX = Math.min(site.maxX, originX + CHUNK_SIZE - 1);
    const fromY = Math.max(site.minY, originY);
    const toY = Math.min(site.maxY, originY + CHUNK_SIZE - 1);
    if (toX < fromX || toY < fromY) return;

    for (let y = fromY; y <= toY; y++) {
      for (let x = fromX; x <= toX; x++) {
        const index = localIndex(x - originX, y - originY);

        // Ore under water is ore nothing can ever mine, and it would make
        // "this patch is 40 tiles" a lie the moment a lake crossed it.
        if (chunk.terrain[index] === TileType.Water) continue;

        const dx = x - site.x;
        const dy = y - site.y;
        // Along and across the patch's long axis. Written as a dot product
        // rather than a rotation so no angle is ever taken.
        const along = (dx * site.ux + dy * site.uy) / site.ra;
        const across = (dy * site.ux - dx * site.uy) / site.rb;
        const distance = Math.sqrt(along * along + across * across);

        // The low-frequency per-resource noise C19 task 3 asks for, as the
        // thing that stops a deposit from reading as an ellipse.
        const edge = 1 + site.kind.wobbleAmount * (wobble.sample(x, y) * 2 - 1);
        if (!(distance < edge)) continue;

        const depth = 1 - distance / edge;
        if (!(depth > claimAt(this.claimDepth, index))) continue;

        this.claimDepth[index] = depth;
        chunk.resource[index] = site.resource;
        chunk.resourceAmount[index] = Math.max(RIM_AMOUNT, Math.round(site.peak * depth));
      }
    }
  }
}

/**
 * The generator for a seed. C19 task 1.
 *
 * `seed` is taken as a 32-bit integer, the same coercion `rng.ts` applies, so
 * "which world is this?" has one answer whatever the caller hands in.
 */
export function createWorldGenerator(seed: number): ChunkGenerator {
  return new WorldGenerator(seed).generate;
}

/**
 * Every resource the generator can actually place, in enum order.
 *
 * Read from the patch table rather than from the enum, so the test that
 * compares it against `RESOURCE_TYPES` fails the day a resource is added to
 * `resource.ts` and never given a way to appear on a map. C09 left that gap
 * open on purpose ("a test fails if C19 adds a resource §11 never gave a
 * tint"); this is the other half of it.
 */
export function generatedResources(): readonly ResourceType[] {
  return PATCH_KINDS.map((kind) => kind.resource);
}
