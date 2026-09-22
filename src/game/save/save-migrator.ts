/**
 * Old saves keep working. See ironflow.md C27 and §14.
 *
 * ```text
 *   parsed JSON ──> migrateSave ──> validateSaveFile ──> deserialize
 *      v1                v1→v2→v3        the current         a world
 *                                        schema, checked
 * ```
 *
 * A save file carries a schema version (§14), and `SAVE_VERSION` is bumped by
 * any breaking change to `SerializedGameState`. This is what stands between
 * those two facts and a player's factory: a chain of pure `vN → vN+1`
 * functions, applied in order, each one the smallest rewrite that makes an
 * older document into a slightly newer one.
 *
 * ## Why migration runs before validation
 *
 * `save-validator.ts` knows exactly one schema: the current one. Handing it a
 * v1 document in a v3 build would be asking it to judge a file by rules that
 * did not exist when the file was written — every honest v1 save would be
 * "corrupt". So the order is migrate, then validate, and the consequence is
 * the rule every migration is written under:
 *
 * > **A migration is handed untrusted data and must not assume its shape.**
 *
 * It reads what it needs defensively, changes what it came to change, and
 * leaves everything else alone. Nothing it produces is believed either: the
 * validator runs over the *result*, so a migration that mangles a save is
 * caught at the same door a hostile file is, and the player is told the save
 * could not be read rather than handed a broken world.
 *
 * ## Why the chain sets the version, and a migration does not
 *
 * Each step's output version is `from + 1` by definition, so the chain writes
 * it. A migration that had to remember would eventually be a migration that
 * forgot, and a document whose version is one behind its shape is the one bug
 * in this file that would be invisible until the *next* migration ran on it.
 *
 * ## What this is not
 *
 * Not a downgrade path — C27 puts that out of scope, and a save from a newer
 * build is refused with a message rather than guessed at. Not a validator:
 * see above. And not a place for content knowledge — which item was renamed
 * to what belongs in the migration that renamed it, under
 * `save/migrations/`.
 */

import { SAVE_VERSION } from './save-format.js';
import { MIGRATIONS } from './migrations/index.js';

/**
 * A save as it arrives: parsed JSON, with a version read off it and nothing
 * else believed.
 *
 * Deliberately not `SaveFile`. A v1 document in a v3 build is *not* a
 * `SaveFile` — that type describes the current schema — and typing it as one
 * would let a migration reach for a field that will not exist for another two
 * versions, with the compiler agreeing.
 */
export type SaveDocument = Readonly<Record<string, unknown>>;

/** One step. Pure, total, and responsible for exactly one version bump. */
export interface Migration {
  /** The version this reads. The chain checks that these are contiguous. */
  readonly from: number;
  /** Always `from + 1`. Written out so a registry reads as a chain. */
  readonly to: number;
  /**
   * One line, in the past tense, naming what changed — it is what a failure
   * message says and what the next reader of the registry has to go on.
   */
  readonly describe: string;
  /** The rewrite. Given untrusted data; the result is validated afterwards. */
  migrate(save: SaveDocument): SaveDocument;
}

/** Why a save could not be brought up to date. */
export class SaveMigrationError extends Error {
  /** The version the file claims. `null` when it does not claim a usable one. */
  readonly from: number | null;
  /** The version this build reads. */
  readonly to: number;

  constructor(message: string, from: number | null, to: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SaveMigrationError';
    this.from = from;
    this.to = to;
  }
}

/**
 * Check that a set of migrations is a chain, not a pile. C27 task 1.
 *
 * Run over `MIGRATIONS` the first time anything migrates, so a registry with
 * a gap, a duplicate or a step that skips a version fails the first test that
 * touches it rather than the first player who has an old save. Every one of
 * those three is a mistake somebody makes exactly once, at two in the morning,
 * while adding the second migration.
 */
export function assertMigrationChain(migrations: readonly Migration[], target = SAVE_VERSION): void {
  let expected: number | null = null;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.from) || migration.from < 1) {
      throw new SaveMigrationError(`A migration reads version ${migration.from}, which is not one.`, null, target);
    }
    if (migration.to !== migration.from + 1) {
      throw new SaveMigrationError(
        `The migration from v${migration.from} claims to produce v${migration.to}; a step is always one version.`,
        migration.from,
        target,
      );
    }
    if (expected !== null && migration.from !== expected) {
      throw new SaveMigrationError(
        `The migrations jump from v${expected} to v${migration.from}; the chain must be contiguous.`,
        migration.from,
        target,
      );
    }
    expected = migration.to;
  }

  if (expected !== null && expected > target) {
    throw new SaveMigrationError(
      `The migrations end at v${expected}, above this build's v${target}.`,
      null,
      target,
    );
  }
  // The other end of the same check: a build whose schema is v3 and whose
  // chain stops at v2 cannot open a v1 save, and would say so by failing to
  // find a step halfway through a player's load.
  if (target > 1 && (migrations.length === 0 || expected !== target)) {
    throw new SaveMigrationError(
      `This build reads v${target} and its migrations reach v${expected ?? 1}; every version needs a step.`,
      null,
      target,
    );
  }
}

/**
 * Bring a parsed save up to the current schema. C27 tasks 1 and 4.
 *
 * Returns the document unchanged when it is already current, which is the
 * ordinary case and the reason this costs nothing in a normal load. A save
 * from the future is refused here as well as in `save-codec.ts`, because this
 * is the function whose *contract* that is.
 *
 * `migrations` is a parameter so a test can apply a chain of its own rather
 * than waiting for the game to have three schema versions. Nothing else ever
 * passes it.
 */
export function migrateSave(
  parsed: unknown,
  migrations: readonly Migration[] = MIGRATIONS,
  target: number = SAVE_VERSION,
): SaveDocument {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SaveMigrationError('That is not a save file.', null, target);
  }

  const document = parsed as SaveDocument;
  const version = document['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new SaveMigrationError('That save has no usable schema version.', null, target);
  }
  if (version > target) {
    // C27 task 4. Guessing at a schema nobody has written yet is how a save
    // from tomorrow's build becomes a world with today's bugs in it.
    throw new SaveMigrationError(
      `That save is schema version ${version}; this build reads ${target}. Update IronFlow to open it.`,
      version,
      target,
    );
  }
  if (version === target) return document;

  assertMigrationChain(migrations, target);
  const steps = new Map(migrations.map((migration) => [migration.from, migration]));

  let current = document;
  for (let at = version; at < target; at++) {
    const step = steps.get(at);
    if (step === undefined) {
      throw new SaveMigrationError(
        `That save is schema version ${at} and this build has no migration from it.`,
        version,
        target,
      );
    }

    let next: unknown;
    try {
      next = step.migrate(current);
    } catch (cause) {
      throw new SaveMigrationError(
        `That save could not be updated from v${step.from} to v${step.to} (${step.describe}).`,
        version,
        target,
        { cause },
      );
    }
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      throw new SaveMigrationError(
        `The v${step.from} migration produced something that is not a save.`,
        version,
        target,
      );
    }
    // The chain owns the version; see the file header.
    current = { ...(next as SaveDocument), version: step.to };
  }
  return current;
}
