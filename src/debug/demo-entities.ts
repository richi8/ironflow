/**
 * Hand-placed entities so C03's depth sorting can be checked by eye.
 *
 * **Scaffolding.** C06 places real buildings from `data/buildings.ts` and
 * deletes this file. It exists because two of C03's acceptance criteria are
 * "entities render in correct front-to-back order" and "a building never draws
 * over a building nearer the camera", and neither can be looked at in a world
 * with nothing in it.
 *
 * The arrangement is chosen to break a naive sort rather than to look nice:
 *
 * - buildings in a diagonal line, so a wrong sign in the depth axis is
 *   immediately obvious;
 * - a 3×3 building beside a 1×1 one that shares part of its depth row, which
 *   is the multi-tile "sort by the maximum corner" rule (§5);
 * - two buildings on the same tile-sum with different layers, which only the
 *   layer bias separates;
 * - a belt running through the middle, which must pass *under* the buildings
 *   it shares a depth row with;
 * - a 1×2 splitter facing east, which occupies two tiles side by side rather
 *   than end to end — the rotated-footprint rule, visible in the running game
 *   rather than only in a test.
 *
 * Since C05 the entities live in the real `EntityStore`, so what is drawn here
 * is the same authoritative state a system would iterate. The two tables below
 * are what C06's `BuildingDefinition` replaces: sizes come from §15, and the
 * sprite ids are the procedural atlas's placeholder grammar.
 *
 * It lives in `debug/` because `game/` may not know what a sprite is (§4).
 */

import type { EntityStore, FootprintLookup } from '../game/entities/entity-store.js';
import { footprintExtent, type Entity, type Footprint } from '../game/entities/entity.js';
import { ENTITY_TYPE_COUNT, EntityType } from '../game/entities/entity-types.js';
import { EAST, SOUTH, type Rotation } from '../game/world/coordinates.js';
import { RenderLayer, type RenderEntity } from '../renderer/render-state.js';
import { BELT_SPRITES, type SpriteId } from '../renderer/sprite-atlas.js';

/** Footprint per entity type, straight from §15's building table. */
const FOOTPRINTS: readonly Footprint[] = Object.freeze([
  Object.freeze({ width: 2, height: 2 }), // miner
  Object.freeze({ width: 1, height: 1 }), // belt
  Object.freeze({ width: 1, height: 2 }), // splitter
  Object.freeze({ width: 1, height: 1 }), // inserter
  Object.freeze({ width: 1, height: 1 }), // chest
  Object.freeze({ width: 2, height: 2 }), // furnace
  Object.freeze({ width: 3, height: 3 }), // assembler
  Object.freeze({ width: 3, height: 3 }), // generator
  Object.freeze({ width: 1, height: 1 }), // power_pole
  Object.freeze({ width: 3, height: 3 }), // lab
  Object.freeze({ width: 2, height: 2 }), // radar
]);

/**
 * What the store is told about footprints until C06's registry exists.
 *
 * Pure, as `FootprintLookup` requires: the same type always answers the same
 * size, so a removal frees exactly the tiles the placement claimed.
 */
export const DEMO_FOOTPRINTS: FootprintLookup = (type) => {
  const footprint = FOOTPRINTS[type];
  if (footprint === undefined) {
    throw new RangeError(`demo-entities: no footprint for entity type ${type}.`);
  }
  return footprint;
};

/** Placeholder appearance per entity type: §11's category colour plus a code. */
interface DemoLook {
  readonly category: string;
  readonly code: string;
  /** Height in `RISE_UNIT`s — what makes a tall building able to hide a short one. */
  readonly rise: number;
}

const LOOKS: readonly DemoLook[] = Object.freeze([
  Object.freeze({ category: 'extraction', code: 'MI', rise: 2 }), // miner
  Object.freeze({ category: 'logistics', code: 'BE', rise: 1 }), // belt — unused; belts draw from BELT_SPRITES
  Object.freeze({ category: 'logistics', code: 'SP', rise: 1 }), // splitter
  Object.freeze({ category: 'logistics', code: 'IN', rise: 1 }), // inserter
  Object.freeze({ category: 'storage', code: 'CH', rise: 1 }), // chest
  Object.freeze({ category: 'production', code: 'FU', rise: 2 }), // furnace
  Object.freeze({ category: 'production', code: 'AS', rise: 2 }), // assembler
  Object.freeze({ category: 'power', code: 'GE', rise: 3 }), // generator
  Object.freeze({ category: 'power', code: 'PO', rise: 3 }), // power_pole
  Object.freeze({ category: 'research', code: 'LA', rise: 2 }), // lab
  Object.freeze({ category: 'research', code: 'RA', rise: 2 }), // radar
]);

/** Both tables cover every type, so a new one cannot be half-described. */
if (FOOTPRINTS.length !== ENTITY_TYPE_COUNT || LOOKS.length !== ENTITY_TYPE_COUNT) {
  throw new Error('demo-entities: the footprint and look tables must cover every EntityType.');
}

/** One placement in the demo scene. Order matters: it decides the entity ids. */
interface Placement {
  readonly type: EntityType;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

const SCENE: readonly Placement[] = Object.freeze([
  { type: EntityType.Radar, x: 0, y: 0, rotation: 0 },
  { type: EntityType.Miner, x: 2, y: 2, rotation: 0 },
  { type: EntityType.Inserter, x: 7, y: 4, rotation: SOUTH },
  { type: EntityType.Furnace, x: 5, y: 5, rotation: 0 },
  { type: EntityType.Generator, x: 8, y: 8, rotation: 0 },
  // Its maximum corner is (13, 5), which sums to 18 — exactly the belt tile at
  // (11, 7). Only the layer bias puts the assembler in front of that belt.
  { type: EntityType.Assembler, x: 11, y: 3, rotation: 0 },
  // The chest and the pole share a tile-sum of 14 and a layer. Nothing
  // separates them but the entity-id tie-break, so the pole — created second,
  // and therefore higher-numbered — draws in front on every frame of every run.
  { type: EntityType.Chest, x: 14, y: 0, rotation: 0 },
  { type: EntityType.PowerPole, x: 13, y: 1, rotation: 0 },
  { type: EntityType.Lab, x: 4, y: 12, rotation: 0 },
  // 1×2 turned east, so it covers (15, 9) and (16, 9) rather than (15, 10).
  { type: EntityType.Splitter, x: 15, y: 9, rotation: EAST },
]);

/** Fill an empty store with the scene above. */
export function seedDemoEntities(store: EntityStore): void {
  for (const placement of SCENE) {
    store.create(placement);
  }
  // A belt running east through the buildings' depth rows.
  for (let x = 0; x < 16; x++) {
    store.create({ type: EntityType.Belt, x, y: 7, rotation: EAST });
  }
}

/**
 * Describe the store's contents for the renderer.
 *
 * This is the job C07's `GameController` takes over and does properly: the
 * simulation holds entities, the renderer needs sprites, and the mapping
 * between them belongs to neither. Rebuilt every frame, because a view model
 * that can go stale is a view model that will.
 */
export function toRenderEntities(store: EntityStore): RenderEntity[] {
  const out: RenderEntity[] = [];
  store.forEach((entity) => out.push(describe(entity)));
  return out;
}

function describe(entity: Entity): RenderEntity {
  const extent = footprintExtent(DEMO_FOOTPRINTS(entity.type), entity.rotation);
  return {
    id: entity.id,
    x: entity.x,
    y: entity.y,
    width: extent.width,
    height: extent.height,
    sprite: spriteFor(entity, extent.width, extent.height),
    layer: entity.type === EntityType.Belt ? RenderLayer.Belt : RenderLayer.Building,
  };
}

function spriteFor(entity: Entity, width: number, height: number): SpriteId {
  if (entity.type === EntityType.Belt) {
    return BELT_SPRITES[entity.rotation] ?? BELT_SPRITES[0] ?? 'belt:0';
  }
  const look = LOOKS[entity.type];
  if (look === undefined) {
    throw new RangeError(`demo-entities: no placeholder look for entity type ${entity.type}.`);
  }
  return `building:${look.category}:${look.code}:${width}x${height}:${look.rise}`;
}
