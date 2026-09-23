import { asBelt } from '../game/entities/belt-entity.js';
import type { Simulation } from '../game/simulation.js';

/**
 * What the world is made of, in §12's categories. For the F3 overlay (C28).
 *
 * A tick's cost is a function of these numbers, so a profile without them is
 * a number with no denominator: "belts took 1.1 ms" means one thing on 12,000
 * belt tiles and another on 200. They are counted by walking the store, at the
 * overlay's ten repaints a second and only while it is open — a few hundred
 * microseconds on the reference factory, and nothing at all otherwise.
 *
 * Categories are decided by the building registry, never by entity type, for
 * the reason `asMachine` gives: a second tier of anything is content, and it
 * should land in the right row without this file hearing about it.
 */
export interface Census {
  readonly entities: number;
  /** Belt tiles — plain belts; splitters and underground mouths are not tiles of a lane. */
  readonly belts: number;
  /** Items riding those belt tiles. */
  readonly beltItems: number;
  /** §12's "machines": anything that mines or runs a recipe. */
  readonly machines: number;
  readonly inserters: number;
}

export function takeCensus(simulation: Simulation): Census {
  const buildings = simulation.buildings;
  let belts = 0;
  let beltItems = 0;
  let machines = 0;
  let inserters = 0;
  simulation.entities.forEach((entity) => {
    const belt = asBelt(entity);
    if (belt !== null) {
      belts += 1;
      beltItems += belt.items.length;
    } else if (buildings.miningFor(entity.type) !== null || buildings.productionFor(entity.type) !== null) {
      machines += 1;
    } else if (buildings.inserterFor(entity.type) !== null) {
      inserters += 1;
    }
  });
  return { entities: simulation.entities.size, belts, beltItems, machines, inserters };
}
