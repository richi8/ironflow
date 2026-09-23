/**
 * Every migration this build has, oldest first. See ironflow.md C27.
 *
 * ```text
 *   SAVE_VERSION = 3        MIGRATIONS = [v1 -> v2, v2 -> v3]
 * ```
 *
 * v2 (2026-09-23) added the player's hotbar layout to the metadata, and v3
 * (the same day) gave the player's bag positions. The
 * registry is not decoration: `save-migrator.ts` checks that the chain reaches
 * `SAVE_VERSION`, and `tests/integration/save-fixtures.test.ts` checks that
 * every version from 1 up has a committed fixture — so the day `SAVE_VERSION`
 * becomes 2 with nothing here, the suite says so.
 *
 * ## Adding one
 *
 * Four steps, and the fixture is the one that is easy to skip and expensive to
 * have skipped:
 *
 * ```text
 * 1  npm run save:fixture          before changing anything — this freezes a
 *                                  save of the schema you are about to leave
 * 2  bump SAVE_VERSION in save-format.ts, and make the schema change
 * 3  write v<N>-to-v<N+1>.ts beside this file, and export it from the list
 * 4  npm run save:fixture          again, so the new version has one too
 * ```
 *
 * A migration is a pure function handed **untrusted** data — it runs before
 * the validator, which is the only order that makes sense (see
 * `save-migrator.ts`) — so it reads what it needs defensively, changes only
 * what it came for, and never assumes a field is there.
 *
 * ## The two content-drift cases, decided in advance
 *
 * C27 task 3 names them, and both have one right answer that is worth having
 * written down before somebody is mid-change:
 *
 * **An item or building id was renamed or removed.** The save carries its own
 * `state.itemIdMap` (§14), so a *rename* is a key rewrite in that table and
 * nothing else: every belt slot, buffer and inventory row goes on holding the
 * same number. A **removal** is two jobs, and doing only the first is the bug:
 * strip every stack and every reference to that id from the state, *and leave
 * its number in the table* under a name nothing matches — `ItemRegistry`
 * reserves every number the table mentions, and a freed number is one a future
 * item would inherit along with the old item's stock. A removed **building**
 * is the same shape one level up: drop those entities, and never reuse the
 * `EntityType` number (`entity-types.ts` promises that already).
 *
 * **`GENERATOR_VERSION` changed.** The save stores deltas against generated
 * terrain (§14), so a changed generator moves the ground under a factory. Two
 * ways out, chosen per change and written down in the migration that makes it:
 *
 * ```text
 * pin      keep the old generator in the codebase and select it by version.
 *          `DeserializeOptions.worldGenerator` exists for exactly this. The
 *          factory stands on the terrain it was built on, for ever.
 * bake     walk the old generator once at migration time and write the
 *          differences into chunk deltas. Correct, and expensive in both
 *          bytes and time — a last resort for a generator that cannot be kept.
 * ```
 *
 * Neither is free, which is the point of `generatorVersion` being in the file:
 * a worldgen change is a decision about every save ever written, and this is
 * where somebody has to make it.
 */

import type { Migration } from '../save-migrator.js';

import { v1ToV2 } from './v1-to-v2.js';
import { v2ToV3 } from './v2-to-v3.js';

/** Oldest first, contiguous, ending at `SAVE_VERSION`. */
export const MIGRATIONS: readonly Migration[] = Object.freeze([v1ToV2, v2ToV3]);
