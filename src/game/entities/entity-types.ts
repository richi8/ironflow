/**
 * What kind of thing an entity is. See ironflow.md C05 task 1 and §15.
 *
 * A numeric enum rather than a string union, because this value is written
 * into every entity in the save file and compared once per entity per tick by
 * `byType`. The numbers are **persisted** (§14), so — exactly as with
 * `TileType` — an existing number may never be reassigned; a new kind of
 * entity takes the next free one.
 *
 * The list mirrors §15's building table. It is complete on day one for the
 * same reason the command union is (§7): a type that grows a member per chunk
 * is a type every save migration has to re-learn. The *definitions* — size,
 * cost, recipe, sprite — are not here; they are content, they live in
 * `data/buildings.ts`, and C06's registry is what ties a definition to one of
 * these numbers.
 */

export enum EntityType {
  Miner = 0,
  Belt = 1,
  Splitter = 2,
  Inserter = 3,
  Chest = 4,
  Furnace = 5,
  Assembler = 6,
  Generator = 7,
  PowerPole = 8,
  Lab = 9,
  Radar = 10,
  /**
   * C21. The eleven above are §15's building table, written out on day one so
   * that no save migration ever has to learn a new number. This is the twelfth,
   * and it is appended rather than inserted for exactly that reason: §15's
   * table is the *materials* of the game and C21 adds a machine it did not
   * list — the furnace's powered twin, which is the whole of task 6's "fuel
   * logistics vs. power infrastructure" choice. See C21's deviations.
   */
  ElectricFurnace = 11,
  /**
   * C22. The tier-2 miner and assembler `mining_2` and `construction_1`
   * unlock, appended for the reason the electric furnace was: an existing
   * number may never move, so a new kind of building takes the next free one.
   *
   * §15's tree names two more tier-2 buildings — the fast belt and the fast
   * inserter — and they are **not** here. Both are drawn by the procedural
   * atlas as a lane of chevrons and an arm, neither of which has a way to say
   * which tier it is, so shipping them would put two buildings on the map that
   * the player cannot tell apart. They belong to the chunk that gives the
   * renderer that vocabulary. See C22's deviations.
   */
  Miner2 = 12,
  Assembler2 = 13,
}

/**
 * Indexed by `EntityType`. Frozen, and used for debug readouts and failure
 * messages only — never for lookup by name, and never shown to a player. The
 * player-facing name is `BuildingDefinition.name` (C06), which is content and
 * will one day be translated.
 */
const ENTITY_TYPE_NAMES: readonly string[] = Object.freeze([
  'miner',
  'belt',
  'splitter',
  'inserter',
  'chest',
  'furnace',
  'assembler',
  'generator',
  'power_pole',
  'lab',
  'radar',
  'electric_furnace',
  'miner_2',
  'assembler_2',
]);

/** How many entity types exist. Kept in step with the table, not hand-written. */
export const ENTITY_TYPE_COUNT = ENTITY_TYPE_NAMES.length;

/**
 * Is `value` a number the `type` field may legitimately hold?
 *
 * The guard exists for the two places a number arrives from outside the type
 * system: a loaded save (C24) and an imported one (C26). Inside the
 * simulation it is a cheap assertion that a `byType` bucket index is real.
 */
export function isEntityType(value: number): value is EntityType {
  return Number.isInteger(value) && value >= 0 && value < ENTITY_TYPE_COUNT;
}

/** Debug name of an entity type. Throws on a value outside the enum. */
export function entityTypeName(type: EntityType): string {
  const name = ENTITY_TYPE_NAMES[type];
  if (name === undefined) {
    throw new RangeError(`entityTypeName: ${type} is not an EntityType.`);
  }
  return name;
}
