/**
 * Entities as the renderer needs to see them. See C06 and ironflow.md §4.
 *
 * The simulation stores an id, a type, a tile and a rotation (C05). A draw call
 * needs a sprite, a footprint in tiles and a layer. Something has to translate,
 * and it is not allowed to be the simulation — `game/` may not know what a
 * sprite is — so it lives on this side of the boundary, reads authoritative
 * state without touching it, and writes nothing back.
 *
 * **C07's `GameController` takes this over**, at which point it becomes one of
 * the view models §4 describes rather than a function the composition root
 * calls. It is here and not there because C06 is the chunk that first has real
 * entities to draw, and `debug/demo-entities.ts` — which did this for hand-made
 * ones — is deleted by this chunk.
 */

import { BELT_TILE_UNITS, type BeltEntity } from '../game/entities/belt-entity.js';
import type { EntityStore } from '../game/entities/entity-store.js';
import { NO_ENTITY, footprintExtent } from '../game/entities/entity.js';
import { EntityType } from '../game/entities/entity-types.js';
import type { BuildingDefinition, BuildingRegistry } from '../game/registries/building-registry.js';
import type { ItemRegistry } from '../game/registries/item-registry.js';
import { DIRECTION_OFFSETS, type Rotation } from '../game/world/coordinates.js';

import type { PlayerView } from '../game/views/player-view.js';

import { RenderLayer, type PlayerRenderView, type RenderEntity } from './render-state.js';
import {
  BELT_CHEVRON_PHASES,
  beltSprite,
  itemSprite,
  playerSprite,
  type SpriteId,
} from './sprite-atlas.js';

/**
 * Which layer a kind of building draws in.
 *
 * Belts lie flat and everything else stands up — `RenderLayer` exists so that a
 * belt passing through a building's depth row goes under it (§5), and so that
 * an item on a belt goes over it. The test is **content**, not an id: a
 * building is a belt because its definition says how fast it carries things
 * (§19 rule 17), which is the same test `building-init.ts` makes.
 */
function layerFor(definition: BuildingDefinition): RenderLayer {
  return definition.belt === undefined ? RenderLayer.Building : RenderLayer.Belt;
}

/**
 * What one placed building looks like, given how it is turned.
 *
 * Every building but the belt has one picture, and a belt has one per
 * direction — which is the grammar an image atlas addresses a cell with, so
 * C29's swap changes nothing above this line. Exported because the **ghost**
 * needs the same answer: a belt held over the cursor must show the direction
 * it would be laid in, and the composition root is where a content id becomes
 * a sprite id (§4).
 */
export function buildingSprite(definition: BuildingDefinition, rotation: Rotation, phase = 0): SpriteId {
  return definition.belt === undefined ? (definition.sprite as SpriteId) : beltSprite(rotation, phase);
}

/**
 * Which chevron frame a belt of this speed is on, `seconds` into the session.
 *
 * Wall-clock, and legitimately so: §6 puts renderer animation phase on the
 * list of things that may read a clock freely, because nothing here is
 * authoritative and no system can see it. It is a function of the belt's
 * *content* speed, so a fast belt's chevrons run twice as fast without
 * anything here knowing that a second tier exists.
 */
export function beltPhase(tilesPerSecond: number, seconds: number): number {
  const step = Math.floor(seconds * tilesPerSecond * BELT_CHEVRON_PHASES);
  return ((step % BELT_CHEVRON_PHASES) + BELT_CHEVRON_PHASES) % BELT_CHEVRON_PHASES;
}

/**
 * Rebuild the drawable list from the store.
 *
 * Allocates a fresh array and one object per entity, every frame. That is the
 * right shape for a few dozen buildings and the wrong one for §12's twenty
 * thousand; C28 measures it and C29 is where it becomes incremental, keyed on
 * entity id, as `render-state.ts` describes.
 *
 * `seconds` is elapsed wall time, and drives nothing but the belt chevrons.
 */
export function describeEntities(
  store: EntityStore,
  buildings: BuildingRegistry,
  seconds = 0,
): RenderEntity[] {
  const out: RenderEntity[] = [];
  store.forEach((entity) => {
    const definition = buildings.forEntityType(entity.type);
    const extent = footprintExtent(definition.size, entity.rotation);
    const phase = definition.belt === undefined ? 0 : beltPhase(definition.belt.tilesPerSecond, seconds);
    out.push({
      id: entity.id,
      x: entity.x,
      y: entity.y,
      width: extent.width,
      height: extent.height,
      sprite: buildingSprite(definition, entity.rotation, phase),
      layer: layerFor(definition),
    });
  });
  return out;
}

/**
 * How much of a row an item is nudged by its position along its belt.
 *
 * Two items on one tile must overlap in the order they sit in, and an item
 * must still draw after the belt under it and before anything a row in front.
 * `depthKey` gives a row eight layer-slots, so any nudge under an eighth of a
 * row is safe; a tenth of the half-row an item can be offset by is well inside
 * that and is plenty to separate four items.
 */
const ITEM_DEPTH_NUDGE = 0.1;

/**
 * Every item riding a belt, as drawables. See §9 and C13 task 8.
 *
 * Items are **not entities** (§9): they have no id, they are not in the store,
 * and they are not in the list the picker searches. What they have is a belt,
 * a fixed-point position along it, and an item id — so this is where those
 * three become a place on screen and a picture.
 *
 * The position is the fixed-point one read straight out of the simulation,
 * interpolated across the tile: `pos / 256` of the way from the belt's entry
 * edge to its exit edge. There is deliberately **no interpolation between
 * ticks** on top of that. An item advances a fifteenth of a tile per tick at
 * tier 1, which is already smooth, and extrapolating forward by the frame's
 * `alpha` would make every *blocked* item jitter forward and snap back — the
 * one place on a belt a player is actually looking.
 */
export function describeBeltItems(store: EntityStore, items: ItemRegistry): RenderEntity[] {
  const out: RenderEntity[] = [];

  for (const belt of store.byType<BeltEntity>(EntityType.Belt)) {
    const step = DIRECTION_OFFSETS[belt.rotation];
    if (step === undefined) continue;
    const depthAxis = step.x + step.y;

    for (const item of belt.items) {
      if (!items.isItemId(item.itemId)) continue;
      const along = item.pos / BELT_TILE_UNITS - 0.5;
      // The anchor a drawable carries is its footprint's north-west corner and
      // the layer adds half the footprint back, so half a tile comes off here
      // — the same round trip the player's drawable makes.
      out.push({
        id: NO_ENTITY,
        x: belt.x + step.x * along,
        y: belt.y + step.y * along,
        width: 1,
        height: 1,
        sprite: itemSprite(items.byId(item.itemId).id),
        layer: RenderLayer.ItemOnBelt,
        depthRow: belt.x + belt.y + ITEM_DEPTH_NUDGE * depthAxis * along,
      });
    }
  }

  return out;
}

/**
 * The player's view model as something the renderer can draw.
 *
 * The same translation `describeEntities` performs, for the same reason: the
 * controller answers where the player is and what they are doing, and naming
 * the picture is this side of §4. Two facts become one sprite id here —
 * activity and facing — which is the grammar an image atlas addresses a cell
 * with, so C29's swap changes nothing above this line.
 */
export function describePlayer(view: PlayerView): PlayerRenderView {
  return {
    x: view.x,
    y: view.y,
    sprite: playerSprite(view.activity, view.facing),
    buildRange: view.buildRange,
    mining: view.mining,
  };
}
