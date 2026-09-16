/**
 * What a freshly placed building starts out holding. See ironflow.md C11.
 *
 * `EntityStore.create` takes whatever fields it is given (C05) and
 * `BuildSystem` decides *whether* a building may stand somewhere (C06).
 * Neither of them knows that a miner has a progress counter, and neither
 * should: one is storage and the other is placement rules. This is the third
 * job — turning a definition into the initial state of one instance — and it
 * is the file C13's belts and C15's furnaces add their own line to.
 *
 * The branch is on **content**, never on an id or an entity type:
 * `definition.mining` is what makes something a miner, so the day C21 adds an
 * electric one, nothing here changes. That is the same rule `build-system.ts`
 * states in its header, kept true by giving the type-specific part its own
 * place to live rather than by care.
 */

import type { BuildingDefinition } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';

import type { EntityInit } from './entity.js';
import { newMiner } from './miner-entity.js';

/**
 * The entity a placement should create, ready for `EntityStore.create`.
 *
 * `(x, y)` is the footprint's north-west tile and `rotation` must already be
 * normalised against the definition (`BuildingRegistry.normalizeRotation`) —
 * this function stores what it is handed.
 */
export function initialBuildingState(
  definition: BuildingDefinition,
  x: number,
  y: number,
  rotation: Rotation,
): EntityInit {
  if (definition.mining !== undefined) return newMiner(x, y, rotation);
  return { type: definition.entityType, x, y, rotation };
}
