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

import { BELT_TILE_UNITS, type BeltItem, type BeltEntity } from '../game/entities/belt-entity.js';
import type { EntityStore } from '../game/entities/entity-store.js';
import { NO_ENTITY, footprintExtent, type Entity } from '../game/entities/entity.js';
import { EntityType } from '../game/entities/entity-types.js';
import { asInserter, inserterArmPosition, type InserterEntity } from '../game/entities/inserter-entity.js';
import {
  SPLITTER_LANES,
  splitterTile,
  type SplitterEntity,
  type SplitterSide,
} from '../game/entities/splitter-entity.js';
import type {
  BuildingDefinition,
  BuildingRegistry,
  InserterConfig,
} from '../game/registries/building-registry.js';
import { NO_ITEM, type ItemRegistry } from '../game/registries/item-registry.js';
import type { RecipeRegistry } from '../game/registries/recipe-registry.js';
import {
  asUnderground,
  isUndergroundEntrance,
  undergroundLaneUnits,
  type UndergroundBeltEntity,
} from '../game/entities/underground-belt-entity.js';
import { asChest } from '../game/entities/chest-entity.js';
import { asMachine } from '../game/entities/machine-entity.js';
import { asMiner } from '../game/entities/miner-entity.js';
import { resourceItemId } from '../game/world/resource.js';
import { DIRECTION_OFFSETS, type Rotation, type TileBounds } from '../game/world/coordinates.js';
import { MachineStatus } from '../game/entities/machine-status.js';

import type { PlayerView } from '../game/views/player-view.js';

import type { EntityIndex } from './entity-index.js';
import type { LevelSpec } from './image-atlas.js';

import {
  RenderLayer,
  type MachineAnnotation,
  type PlayerRenderView,
  type RenderEntity,
} from './render-state.js';
import {
  ACTIVITY_FRAMES,
  BELT_CHEVRON_PHASES,
  INSERTER_SWING_STEPS,
  PLAYER_ACTIVITIES,
  beltSprite,
  inserterSprite,
  itemSprite,
  machineFrameSprite,
  playerSprite,
  spriteLift,
  splitterSprite,
  undergroundSprite,
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
  // A splitter lies as flat as the belt it sits in, and for the same reason:
  // a belt line running past a building must go under it, and the items on
  // that line over it (C17).
  // C23's underground mouth joins them: a tunnel lies in the ground, and a
  // building standing over the run has to draw in front of both ends of it.
  if (
    definition.belt !== undefined ||
    definition.splitter !== undefined ||
    definition.underground !== undefined
  ) {
    return RenderLayer.Belt;
  }
  // An inserter's arm reaches over the tiles either side of it, so it draws
  // after everything else in its own depth row — including an item sitting on
  // the belt it is reaching into.
  if (definition.inserter !== undefined) return RenderLayer.InserterArm;
  return RenderLayer.Building;
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
  if (definition.belt !== undefined) return beltSprite(rotation, phase);
  if (definition.splitter !== undefined) return splitterSprite(rotation, phase);
  // An inserter at rest, which is what a ghost is: the arm is over the source
  // side and the hand is empty. A *placed* one is drawn from its own state —
  // see `inserterSpriteFor`, which this is deliberately not, because a ghost
  // has a rotation and no cycle to be partway through.
  if (definition.inserter !== undefined) return inserterSprite(rotation, 0, false);
  // A ghost is always drawn as an entrance: it has a rotation and no partner,
  // and a lone mouth *is* an entrance (see `underground-belt-entity.ts`). What
  // it becomes on the click is decided by the build system, and the tick that
  // decides it is the tick the placed sprite is first drawn from.
  if (definition.underground !== undefined) return undergroundSprite(rotation, true);
  return definition.sprite as SpriteId;
}

/**
 * Which arm position a placed inserter is drawn in. C14 task 7.
 *
 * The interpolation is render-side, as the task asks, but the *quantity* it
 * interpolates is simulation state: `inserterArmPosition` turns a state and a
 * tick count into "how far across, 0 to 1", and this is the step that turns
 * that into one of the atlas's seventeen arm positions. Rounded rather than
 * floored so the two ends of the sweep are reached, and reached symmetrically.
 */
function inserterSpriteFor(inserter: InserterEntity, config: InserterConfig): SpriteId {
  const swing = Math.round(inserterArmPosition(inserter, config) * INSERTER_SWING_STEPS);
  return inserterSprite(inserter.rotation, swing, inserter.heldItem !== NO_ITEM);
}

/**
 * How fast this building's chevrons run, or null if it has none (C17).
 *
 * A belt and a splitter answer the same way because a splitter's lane runs at
 * the belt's speed — an item does not change pace crossing into one — and
 * asking content rather than the entity type means C22's fast splitter
 * animates correctly without this file hearing about it.
 */
function carrierSpeed(definition: BuildingDefinition): number | null {
  return (
    definition.belt?.tilesPerSecond ?? definition.splitter?.tilesPerSecond ?? definition.underground?.tilesPerSecond ?? null
  );
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
 * What one placed entity looks like right now.
 *
 * Every building but the inserter is a picture of its *definition* and its
 * rotation — which is what `buildingSprite` answers, and why the ghost can use
 * the same function. An inserter is the first whose appearance depends on what
 * it is doing, so it is the one that has to be handed the entity.
 */
function spriteFor(
  entity: Entity,
  definition: BuildingDefinition,
  buildings: BuildingRegistry,
  store: EntityStore,
  phase: number,
): SpriteId {
  const inserter = definition.inserter === undefined ? null : asInserter(entity);
  const config = inserter === null ? null : buildings.inserterFor(entity.type);
  if (inserter !== null && config !== null) return inserterSpriteFor(inserter, config);
  // The second building whose appearance depends on what it is doing rather
  // than only on how it is turned: which end of a run a mouth is depends on
  // where its partner stands, which is a fact about the pair (C23).
  const mouth = asUnderground(entity, buildings);
  if (mouth !== null) {
    return undergroundSprite(mouth.rotation, isUndergroundEntrance(mouth, partnerOf(mouth, store)));
  }
  return buildingSprite(definition, entity.rotation, phase);
}

/** The other mouth of a run, or undefined for a lone one. See C23. */
function partnerOf(mouth: { readonly link: number }, store: EntityStore): Entity | undefined {
  return mouth.link === NO_ENTITY ? undefined : store.get(mouth.link);
}

/**
 * Frames a second of a working machine's cycle. Presentation only (§6).
 *
 * Six: slow enough that a drill reads as a stroke rather than a blur, fast
 * enough that a furnace's glow reads as fire.
 */
const MACHINE_FPS = 6;

/**
 * Which frame a working machine is on, `seconds` into the session: 1 to 3,
 * looping. Frame 0 is at rest and is never returned here.
 */
export function activityFrame(seconds: number, fps = MACHINE_FPS): number {
  const step = Math.floor(seconds * fps) % (ACTIVITY_FRAMES - 1);
  return 1 + (step < 0 ? step + ACTIVITY_FRAMES - 1 : step);
}

/**
 * Is this building doing its job right now? C29 art task 3.
 *
 * Read off the status every machine already stores (C11) — `Running`, or
 * `LowPower`, which is running slowly. Anything without a status, and every
 * stalled reason, is at rest: a machine that is not working should *look*
 * stopped, which is pillar 3 before the player has opened the inspector.
 */
function isWorking(entity: Entity): boolean {
  const status = (entity as { readonly status?: unknown }).status;
  return status === MachineStatus.Running || status === MachineStatus.LowPower;
}

/**
 * Which slice of the world to describe, and whether to animate it (C29).
 *
 * `within` limits the walk to what is near the screen, through the renderer's
 * spatial index; without it every entity is described, which is what the
 * tests and anything else that wants the whole world get. `animate` false
 * draws everything at rest — belts still, machines unlit, the player in frame
 * 0 — which is what C29 art task 4 asks for below `DETAIL_ZOOM`.
 */
export interface DescribeOptions {
  readonly within?: { readonly index: EntityIndex; readonly bounds: TileBounds };
  readonly animate?: boolean;
}

/**
 * Build the drawable list from the store.
 *
 * Allocates a fresh array and one object per entity described, every frame.
 * Since C29 the composition root passes `within`, so that is one per entity
 * *near the screen* — the 2 ms this cost on §12's reference factory at any
 * zoom was the largest single term in a frame that drew one building.
 *
 * `seconds` is elapsed wall time, and drives nothing but animation.
 */
export function describeEntities(
  store: EntityStore,
  buildings: BuildingRegistry,
  seconds = 0,
  options: DescribeOptions = {},
): RenderEntity[] {
  const out: RenderEntity[] = [];
  const animate = options.animate ?? true;
  const frame = animate ? activityFrame(seconds) : 0;
  const visit = (entity: Entity): void => {
    const definition = buildings.forEntityType(entity.type);
    const extent = footprintExtent(definition.size, entity.rotation);
    const speed = carrierSpeed(definition);
    const phase = speed === null || !animate ? 0 : beltPhase(speed, seconds);
    let sprite = spriteFor(entity, definition, buildings, store, phase);
    // An inserter shows what it is doing through its arm, which is state,
    // not animation; everything else with a status gets the activity cycle.
    if (frame !== 0 && definition.inserter === undefined && isWorking(entity)) {
      sprite = machineFrameSprite(sprite, frame);
    }
    out.push({
      id: entity.id,
      x: entity.x,
      y: entity.y,
      width: extent.width,
      height: extent.height,
      sprite,
      layer: layerFor(definition),
    });
  };
  if (options.within === undefined) store.forEach(visit);
  else options.within.index.forEachIn(store, buildings, options.within.bounds, visit);
  return out;
}

/**
 * How much of a row an item is nudged by its position along its belt.
 *
 * Two items on one tile must overlap in the order they sit in. Since C27A the
 * depth axis is `y`, so a belt running east or west gives its items no row of
 * their own to sort by and they would all tie on the entity id — which every
 * item shares, because an item is not an entity and has no id. This nudge is
 * what separates them: it runs along the flow, so the item nearer the end of
 * the belt is painted last whichever way the belt points.
 *
 * `depthKey` gives a row eight layer-slots, so any nudge under an eighth of a
 * row is safe; a tenth of the half-row an item can be offset by is well inside
 * that and is plenty to separate four items.
 */
const ITEM_DEPTH_NUDGE = 0.1;

/**
 * Every item riding a belt or a splitter, as drawables. See §9, C13 task 8
 * and C17 task 4.
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
export function describeBeltItems(
  store: EntityStore,
  buildings: BuildingRegistry,
  items: ItemRegistry,
  options: Pick<DescribeOptions, 'within'> = {},
): RenderEntity[] {
  const out: RenderEntity[] = [];
  if (options.within !== undefined) {
    describeItemsWithin(out, store, buildings, items, options.within.index, options.within.bounds);
    return out;
  }

  for (const belt of store.byType<BeltEntity>(EntityType.Belt)) {
    describeLane(out, belt.items, belt.x, belt.y, belt.rotation, items);
  }

  // An underground run's items are drawn along the whole of it, and the middle
  // of the run is deliberately **not** drawn: a tunnel is underground, and the
  // only reason a player sees anything at all is so that a mouth swallowing an
  // item and the same item appearing at the far end read as one event rather
  // than as a disappearance (C23). `describeRun` is where that cut is made.
  for (const mouth of store.byType<UndergroundBeltEntity>(EntityType.UndergroundBelt)) {
    const partner = partnerOf(mouth, store);
    if (!isUndergroundEntrance(mouth, partner)) continue;
    describeRun(out, mouth, partner, items);
  }

  // A splitter's two lanes are drawn exactly as a belt's, each centred on its
  // own footprint tile — which is what makes the line read as continuous
  // across it (C17 task 4). The tile comes from the same content footprint the
  // simulation walks, so the picture and the geometry cannot disagree.
  for (const splitter of store.byType<SplitterEntity>(EntityType.Splitter)) {
    const size = buildings.forEntityType(splitter.type).size;
    for (let side = 0; side < SPLITTER_LANES; side++) {
      const lane = splitter.lanes[side as SplitterSide];
      if (lane === undefined) continue;
      const tile = splitterTile(splitter, size, side as SplitterSide);
      describeLane(out, lane, tile.x, tile.y, splitter.rotation, items);
    }
  }

  return out;
}

/**
 * The same items as `describeBeltItems`, for the carriers near the screen only.
 *
 * One subtlety, and it is the tunnel's: a run's items are all held by its
 * entrance, so an exit in view whose entrance is not must still describe the
 * run — or items would pop out of a mouth that is visibly empty. A run whose
 * two mouths are both in view is described once, by its entrance.
 */
function describeItemsWithin(
  out: RenderEntity[],
  store: EntityStore,
  buildings: BuildingRegistry,
  items: ItemRegistry,
  index: EntityIndex,
  bounds: TileBounds,
): void {
  index.forEachIn(store, buildings, bounds, (entity) => {
    switch (entity.type) {
      case EntityType.Belt: {
        const belt = entity as BeltEntity;
        describeLane(out, belt.items, belt.x, belt.y, belt.rotation, items);
        return;
      }
      case EntityType.UndergroundBelt: {
        const mouth = entity as UndergroundBeltEntity;
        const partner = partnerOf(mouth, store);
        if (isUndergroundEntrance(mouth, partner)) {
          describeRun(out, mouth, partner, items);
          return;
        }
        if (partner === undefined || inBounds(partner, bounds)) return;
        const entrance = partner as UndergroundBeltEntity;
        describeRun(out, entrance, mouth, items);
        return;
      }
      case EntityType.Splitter: {
        const splitter = entity as SplitterEntity;
        const size = buildings.forEntityType(splitter.type).size;
        for (let side = 0; side < SPLITTER_LANES; side++) {
          const lane = splitter.lanes[side as SplitterSide];
          if (lane === undefined) continue;
          const tile = splitterTile(splitter, size, side as SplitterSide);
          describeLane(out, lane, tile.x, tile.y, splitter.rotation, items);
        }
        return;
      }
      default:
        return;
    }
  });
}

/** Is a one-tile entity's tile inside `bounds`? Underground mouths are 1x1. */
function inBounds(entity: Entity, bounds: TileBounds): boolean {
  return entity.x >= bounds.minX && entity.x <= bounds.maxX && entity.y >= bounds.minY && entity.y <= bounds.maxY;
}

/**
 * The items on one underground run, hiding the ones that are under the ground.
 *
 * The lane runs `(span + 1)` tiles from the entrance's entry edge to the
 * exit's far edge, so an item's position along it is a position along a line
 * of tiles rather than across one. Everything more than a tile inside either
 * mouth is skipped: that is what makes the building look like a tunnel and not
 * like a very long belt with no plate under it.
 */
function describeRun(
  out: RenderEntity[],
  mouth: UndergroundBeltEntity,
  partner: Entity | undefined,
  items: ItemRegistry,
): void {
  const step = DIRECTION_OFFSETS[mouth.rotation];
  if (step === undefined) return;
  const laneUnits = undergroundLaneUnits(mouth, partner);
  const tiles = laneUnits / BELT_TILE_UNITS;
  const depthAxis = step.x + step.y;

  for (const item of mouth.items) {
    if (!items.isItemId(item.itemId)) continue;
    const tile = Math.floor(item.pos / BELT_TILE_UNITS);
    // Visible only in the two mouths. A run of span 0 is one tile and both
    // tests name it, which is correct: a lone mouth is an ordinary belt tile.
    if (tile !== 0 && tile !== tiles - 1) continue;

    const along = item.pos / BELT_TILE_UNITS - 0.5;
    out.push({
      id: NO_ENTITY,
      x: mouth.x + step.x * along,
      y: mouth.y + step.y * along,
      width: 1,
      height: 1,
      sprite: itemSprite(items.byId(item.itemId).id),
      layer: RenderLayer.ItemOnBelt,
      depthRow: mouth.y + step.y * along + ITEM_DEPTH_NUDGE * depthAxis * along,
    });
  }
}

/** Every item in one lane, as drawables centred on the tile that carries it. */
function describeLane(
  out: RenderEntity[],
  lane: readonly BeltItem[],
  tileX: number,
  tileY: number,
  rotation: Rotation,
  items: ItemRegistry,
): void {
  const step = DIRECTION_OFFSETS[rotation];
  if (step === undefined) return;
  const depthAxis = step.x + step.y;

  for (const item of lane) {
    if (!items.isItemId(item.itemId)) continue;
    const along = item.pos / BELT_TILE_UNITS - 0.5;
    // The anchor a drawable carries is its footprint's north-west corner and
    // the layer adds half the footprint back, so half a tile comes off here
    // — the same round trip the player's drawable makes.
    out.push({
      id: NO_ENTITY,
      x: tileX + step.x * along,
      y: tileY + step.y * along,
      width: 1,
      height: 1,
      sprite: itemSprite(items.byId(item.itemId).id),
      layer: RenderLayer.ItemOnBelt,
      depthRow: tileY + step.y * along + ITEM_DEPTH_NUDGE * depthAxis * along,
    });
  }
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
export function describePlayer(view: PlayerView, seconds = 0, animate = true): PlayerRenderView {
  return {
    x: view.x,
    y: view.y,
    sprite: playerSprite(view.activity, view.facing, animate ? playerFrame(view.activity, seconds) : 0),
    buildRange: view.buildRange,
    mining: view.mining,
  };
}

/**
 * Frames a second per player activity: a slow breath, a walking stride, a
 * pick swing. Presentation only (§6).
 */
const PLAYER_FPS: Readonly<Record<PlayerView['activity'], number>> = Object.freeze({ idle: 2, walk: 8, work: 6 });

/** Which frame of its four the player's activity is on, `seconds` in. */
export function playerFrame(activity: PlayerView['activity'], seconds: number): number {
  const step = Math.floor(seconds * PLAYER_FPS[activity]) % ACTIVITY_FRAMES;
  return step < 0 ? step + ACTIVITY_FRAMES : step;
}

/** The plain levels' and the detailed levels' scales. See `image-atlas.ts`. */
const PLAIN_SCALES: readonly number[] = Object.freeze([0.25, 0.5, 1]);
const DETAILED_SCALES: readonly number[] = Object.freeze([0.5, 1, 2]);

/**
 * Every sprite the entity layer can ask for, per atlas level (C29 art task 2).
 *
 * Here because this is the file that turns content into sprite ids (§4): the
 * atlas cannot know that a belt is four rotations of eight phases, or that a
 * building's picture is its content `sprite` plus three working frames. A
 * detailed level has every animation frame; a plain level only the frames at
 * rest, because below `DETAIL_ZOOM` nothing animates. Terrain is not listed:
 * the terrain layer caches it per world chunk and painting it is not a cost.
 *
 * An id this misses is not an error — the atlas paints it live — only slower.
 */
export function atlasLevels(buildings: BuildingRegistry, items: ItemRegistry): LevelSpec[] {
  const plain: SpriteId[] = [];
  const detailed: SpriteId[] = [];
  const both = (id: SpriteId): void => {
    plain.push(id);
    detailed.push(id);
  };
  const rotations: readonly Rotation[] = [0, 1, 2, 3];

  for (const definition of buildings.all()) {
    for (const rotation of rotations) {
      if (definition.belt !== undefined || definition.splitter !== undefined) {
        const sprite = definition.belt !== undefined ? beltSprite : splitterSprite;
        plain.push(sprite(rotation, 0));
        for (let phase = 0; phase < BELT_CHEVRON_PHASES; phase++) detailed.push(sprite(rotation, phase));
      } else if (definition.inserter !== undefined) {
        for (let swing = 0; swing <= INSERTER_SWING_STEPS; swing++) {
          both(inserterSprite(rotation, swing, false));
          both(inserterSprite(rotation, swing, true));
        }
      } else if (definition.underground !== undefined) {
        both(undergroundSprite(rotation, true));
        both(undergroundSprite(rotation, false));
      }
    }
    if (definition.belt === undefined && definition.splitter === undefined && definition.inserter === undefined && definition.underground === undefined) {
      const base = definition.sprite as SpriteId;
      plain.push(base);
      for (let frame = 0; frame < ACTIVITY_FRAMES; frame++) detailed.push(machineFrameSprite(base, frame));
    }
  }

  for (const item of items.all()) both(item.sprite as SpriteId);

  for (const activity of PLAYER_ACTIVITIES) {
    for (const facing of rotations) {
      plain.push(playerSprite(activity, facing, 0));
      for (let frame = 0; frame < ACTIVITY_FRAMES; frame++) detailed.push(playerSprite(activity, facing, frame));
    }
  }

  return [
    ...PLAIN_SCALES.map((scale) => ({ scale, detail: false, ids: plain })),
    ...DETAILED_SCALES.map((scale) => ({ scale, detail: true, ids: detailed })),
  ];
}

/**
 * What every machine in the world is making, for C20's alt-mode overlay.
 *
 * ```text
 *   miner      the ore under it                   resourceType
 *   furnace    the recipe it is running           recipe -> outputs[0]
 *   assembler  the recipe it was told to run      recipe -> outputs[0]
 *   chest      the item it holds most of          contents
 *   belt       nothing
 * ```
 *
 * Four rules and one omission. Belts are left out because there are hundreds
 * of them, they are a tile each, and what they carry is already drawn *on*
 * them — a badge over every belt tile would bury the machines the mode exists
 * to label. Splitters are left out for the same reason.
 *
 * ## Why it reads the entities rather than the view models
 *
 * `GameController` builds a `MachineView` per machine on demand, and forty of
 * them a frame is forty frozen objects with recipe lists in them. This is the
 * same walk `describeEntities` already makes, one tile lookup deeper, and it
 * produces the two numbers a badge needs. §4 is satisfied the way
 * `describeEntities` satisfies it: the renderer may *read* `game/`, and what
 * it may not do is let `game/` know what a sprite is.
 *
 * Called only while the mode is on, so a player who never presses Alt pays
 * nothing for it.
 */
export function describeAnnotations(
  store: EntityStore,
  buildings: BuildingRegistry,
  recipes: RecipeRegistry,
  items: ItemRegistry,
): MachineAnnotation[] {
  const out: MachineAnnotation[] = [];

  store.forEach((entity) => {
    const badge = annotationItem(entity, buildings, recipes, items);
    if (badge === null) return;

    const definition = buildings.forEntityType(entity.type);
    const extent = footprintExtent(definition.size, entity.rotation);
    out.push({
      x: entity.x,
      y: entity.y,
      width: extent.width,
      height: extent.height,
      sprite: itemSprite(badge.itemId),
      count: badge.count,
      // Measured from the machine's own sprite, which is the one standing up.
      lift: spriteLift(spriteFor(entity, definition, buildings, store, 0)),
    });
  });

  return out;
}

/** The item a machine's badge names, and how many of it, or null for no badge. */
function annotationItem(
  entity: Entity,
  buildings: BuildingRegistry,
  recipes: RecipeRegistry,
  items: ItemRegistry,
): { readonly itemId: string; readonly count: number | null } | null {
  const miner = asMiner(entity);
  if (miner !== null) {
    const itemId = resourceItemId(miner.resourceType);
    return itemId === null ? null : { itemId, count: miner.outputCount };
  }

  const machine = asMachine(entity, buildings);
  if (machine !== null) {
    if (!recipes.isRecipeId(machine.recipe)) return null;
    const product = recipes.byId(machine.recipe).outputs[0];
    if (product === undefined) return null;
    return { itemId: items.byId(product.itemId).id, count: null };
  }

  const chest = asChest(entity);
  if (chest !== null) {
    // The one it holds most of, and ties go to the lower item id so the badge
    // does not flicker between two equal stacks as they fill.
    // Totalled per item first: since chests became grids, one item can be
    // several stacks.
    const totals = new Map<number, number>();
    for (const entry of chest.contents) totals.set(entry[1], (totals.get(entry[1]) ?? 0) + entry[2]);
    let best: readonly [number, number] | null = null;
    for (const entry of [...totals].sort((a, b) => a[0] - b[0])) {
      if (best === null || entry[1] > best[1]) best = entry;
    }
    if (best === null || !items.isItemId(best[0])) return null;
    return { itemId: items.byId(best[0]).id, count: best[1] };
  }

  return null;
}
