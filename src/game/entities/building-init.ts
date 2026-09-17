/**
 * What a freshly placed building starts out holding. See ironflow.md C11.
 *
 * `EntityStore.create` takes whatever fields it is given (C05) and
 * `BuildSystem` decides *whether* a building may stand somewhere (C06).
 * Neither of them knows that a miner has a progress counter, and neither
 * should: one is storage and the other is placement rules. This is the third
 * job — turning a definition into the initial state of one instance — and it
 * is the file C13's belts, C14's inserters, C15's furnaces and C17's
 * splitters add their own line to.
 *
 * The branch is on **content**, never on an id or an entity type:
 * `definition.mining` is what makes something a miner, `definition.belt` a belt,
 * `definition.splitter` a splitter, `definition.inserter` an inserter,
 * `definition.storage` a container and
 * `definition.production` a machine that runs recipes, so
 * the day C21 adds an electric miner, nothing here changes. That is the same rule `build-system.ts`
 * states in its header, kept true by giving the type-specific part its own
 * place to live rather than by care.
 */

import type { BuildingDefinition } from '../registries/building-registry.js';
import type { Rotation } from '../world/coordinates.js';

import { newBelt } from './belt-entity.js';
import { newChest } from './chest-entity.js';
import type { EntityInit } from './entity.js';
import { newInserter } from './inserter-entity.js';
import { newMachine } from './machine-entity.js';
import { newMiner } from './miner-entity.js';
import { newSplitter } from './splitter-entity.js';

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
  if (definition.belt !== undefined) return newBelt(x, y, rotation);
  if (definition.splitter !== undefined) return newSplitter(x, y, rotation);
  if (definition.inserter !== undefined) return newInserter(x, y, rotation);
  if (definition.storage !== undefined) return newChest(x, y, rotation);
  if (definition.production !== undefined) return newMachine(definition.entityType, x, y, rotation);
  return { type: definition.entityType, x, y, rotation };
}
