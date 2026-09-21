import type { Simulation } from '../../src/game/simulation.js';

/**
 * A canonical form for authoritative state, and a hash over it. C18 task 5.
 *
 * §6's contract is "same seed + same initial state + same command sequence +
 * same tick count ⇒ **byte-identical** authoritative state". A test can only
 * check that if it can turn a world into one comparable value, and the value
 * has to be *canonical*: two worlds that are the same must hash the same even
 * when they arrived by different routes.
 *
 * Three things make it canonical, and each of them is a bug this file exists
 * to catch rather than a nicety:
 *
 * ```text
 * object keys are sorted        JSON.stringify writes keys in INSERTION order,
 *                               so an entity built field-by-field in a
 *                               different sequence would hash differently
 *                               while being the same entity
 * containers are walked in a    §6 R4: a Map iterates by insertion, which
 * coordinate or id order        differs between a live session and a reload
 * -0 is written as "-0"         §6 R7's quiet one. JSON normalises it to 0, so
 *                               a hash built on JSON.stringify would be blind
 *                               to exactly the value the rule forbids
 * ```
 *
 * ## Why this is a test fixture and not `src/game/save/`
 *
 * C24 owns the real serializer, and §14's save is a *different* document: it
 * writes world deltas rather than whole world chunks, it carries a schema
 * version, and it has migrations. This walks the live state instead, which is
 * what a determinism test wants — a save that forgot a field would hash the
 * same before and after, and the bug would be invisible in exactly the test
 * written to find it. When C24 lands, the round-trip test (§6 R8) compares a
 * loaded world against this hash, and the two checks stay independent.
 *
 * The roots are listed explicitly below rather than discovered, so adding a
 * piece of authoritative state without adding it here is a visible omission in
 * one place instead of a silent one everywhere.
 */

/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over a string, as eight lowercase hex digits.
 *
 * Chosen over anything stronger for the reason §3 gives about dependencies:
 * this is a *comparison* of two states produced seconds apart in one process,
 * not a defence against a forged one. Twelve lines, no dependency, and a
 * collision would have to be engineered.
 */
export function fnv1a(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Write a value in a form where equal states produce equal text.
 *
 * Deliberately *not* `JSON.stringify` with a replacer: a replacer cannot
 * reorder keys, cannot see `-0`, and silently drops `undefined` rather than
 * making it visible. Typed arrays are written as their contents, because that
 * is what a world chunk is.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  if (typeof value === 'number') {
    // The one case JSON gets wrong in a way §6 R7 cares about, plus the two it
    // turns into `null`. All three are written so the hash can see them.
    if (Object.is(value, -0)) return '-0';
    if (Number.isNaN(value)) return 'NaN';
    if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
    return String(value);
  }

  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);

  if (ArrayBuffer.isView(value)) {
    return `[${Array.from(value as unknown as ArrayLike<number>).join(',')}]`;
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    // Sorted, which is the entire point — see the file header.
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
  }

  // A function, a symbol or a bigint in authoritative state is a defect, not a
  // value to hash around. `entities/entity.ts` refuses all three on write; this
  // makes one that slipped in elsewhere loud rather than silently stringified.
  throw new TypeError(`canonicalize: ${typeof value} is not authoritative state (§6, C05 task 1).`);
}

/**
 * Every piece of authoritative state, in a fixed shape. See §10's left column.
 *
 * The world is the world chunks that **exist**, not the ones a rectangle would
 * generate: asking about terrain must not create it, or the act of hashing
 * would change what is hashed.
 */
export function canonicalState(simulation: Simulation): Record<string, unknown> {
  const entities: unknown[] = [];
  // `forEach` walks the store's dense, id-ordered array (§6 R4).
  simulation.entities.forEach((entity) => entities.push(entity));

  const chunks: unknown[] = [];
  simulation.world.forEachLoadedChunk((chunk) => {
    chunks.push({
      cx: chunk.cx,
      cy: chunk.cy,
      // `revision` is deliberately absent: it is the renderer's cache signal,
      // derived and never persisted (see `chunk.ts`). `dirty` is present
      // because §14 decides what is written from it.
      dirty: chunk.dirty,
      terrain: chunk.terrain,
      resource: chunk.resource,
      resourceAmount: chunk.resourceAmount,
    });
  });

  return {
    tick: simulation.getTick(),
    seed: simulation.seed,
    // §6 R2: the stream position is authoritative state. Nothing draws from it
    // yet, and it is here from C18 so that the day C19 does, this test is
    // already watching it.
    rngState: simulation.rng.state,
    // §6 R5: ids are monotonic and never reused, so the counter is state. Two
    // factories that look identical but would hand out different next ids are
    // not identical.
    nextEntityId: simulation.entities.nextId,
    entities,
    player: simulation.player.toJSON(),
    // §10: "research state and unlocked technologies" is authoritative. The
    // *unlock tables* are not and are deliberately absent — they are a pure
    // function of this (`research/unlocks.ts`), and hashing both would hide a
    // rebuild that had gone wrong behind the state it was derived from.
    research: simulation.research.toJSON(),
    world: chunks,
  };
}

/** The hash §6's contract is checked with. */
export function hashState(simulation: Simulation): string {
  return fnv1a(canonicalize(canonicalState(simulation)));
}

/**
 * The same state with entity **ids removed and entities keyed by tile**.
 *
 * Build-order independence cannot be asked of `hashState`, and the reason is
 * not a weakness in the test — it is §6 R5. Ids are monotonic and never
 * reused, so laying the same factory in a different order genuinely produces a
 * different set of ids, and a hash that included them would be reporting that
 * difference rather than the one being asked about. What must match is what a
 * player could see: the same buildings, on the same tiles, holding the same
 * things, having made the same number of them.
 *
 * Keyed by the north-west tile because that is an entity's identity in the
 * world (C05), and sorted, so the comparison is between two *sets* of
 * buildings rather than between two traversal orders.
 */
export function canonicalLayout(simulation: Simulation): Record<string, unknown> {
  const state = canonicalState(simulation);
  const entities = state['entities'] as readonly Record<string, unknown>[];

  const byTile: Record<string, unknown> = {};
  for (const entity of entities) {
    const { id: _id, ...rest } = entity;
    byTile[`${String(entity['x'])},${String(entity['y'])}`] = rest;
  }

  return {
    tick: state['tick'],
    seed: state['seed'],
    rngState: state['rngState'],
    // `nextEntityId` stays: two factories of the same size must have handed
    // out the same *number* of ids however they were ordered, and a layout
    // that quietly leaked one would otherwise pass.
    nextEntityId: state['nextEntityId'],
    entities: byTile,
    player: state['player'],
    research: state['research'],
    world: state['world'],
  };
}

/** The hash build-order independence is checked with. See `canonicalLayout`. */
export function hashLayout(simulation: Simulation): string {
  return fnv1a(canonicalize(canonicalLayout(simulation)));
}

/**
 * Visit every number in a state tree, with the path that reached it.
 *
 * What the §6 R7 acceptance criterion ("every numeric field of a serialized
 * state is finite") is checked with. The path is built as it descends so a
 * failure names the field rather than the tree.
 */
export function forEachNumber(
  value: unknown,
  visit: (value: number, path: string) => void,
  path = '$',
): void {
  if (typeof value === 'number') {
    visit(value, path);
    return;
  }
  if (value === null || typeof value !== 'object') return;

  if (ArrayBuffer.isView(value)) {
    const array = value as unknown as ArrayLike<number>;
    for (let i = 0; i < array.length; i++) {
      const entry = array[i];
      if (entry !== undefined) visit(entry, `${path}[${i}]`);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) forEachNumber(value[i], visit, `${path}[${i}]`);
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) forEachNumber(record[key], visit, `${path}.${key}`);
}
