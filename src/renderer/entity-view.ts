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

import type { EntityStore } from '../game/entities/entity-store.js';
import { footprintExtent } from '../game/entities/entity.js';
import { EntityType } from '../game/entities/entity-types.js';
import type { BuildingRegistry } from '../game/registries/building-registry.js';

import { RenderLayer, type RenderEntity } from './render-state.js';
import type { SpriteId } from './sprite-atlas.js';

/**
 * Which layer a kind of entity draws in.
 *
 * Belts lie flat and everything else stands up, which is the whole of the
 * rule in C06 — `RenderLayer` exists so that a belt passing through a
 * building's depth row goes under it (§5). C13 is where belts become real and
 * where items on them get `RenderLayer.ItemOnBelt`.
 */
function layerFor(type: EntityType): RenderLayer {
  return type === EntityType.Belt ? RenderLayer.Belt : RenderLayer.Building;
}

/**
 * Rebuild the drawable list from the store.
 *
 * Allocates a fresh array and one object per entity, every frame. That is the
 * right shape for a few dozen buildings and the wrong one for §12's twenty
 * thousand; C28 measures it and C29 is where it becomes incremental, keyed on
 * entity id, as `render-state.ts` describes.
 */
export function describeEntities(store: EntityStore, buildings: BuildingRegistry): RenderEntity[] {
  const out: RenderEntity[] = [];
  store.forEach((entity) => {
    const definition = buildings.forEntityType(entity.type);
    const extent = footprintExtent(definition.size, entity.rotation);
    out.push({
      id: entity.id,
      x: entity.x,
      y: entity.y,
      width: extent.width,
      height: extent.height,
      sprite: definition.sprite as SpriteId,
      layer: layerFor(entity.type),
    });
  });
  return out;
}
