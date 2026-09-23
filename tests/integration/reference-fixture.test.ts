import { describe, expect, it } from 'vitest';

import { takeCensus } from '../../src/debug/census.js';

import { loadReferenceFactory } from '../bench/reference-fixture.js';

/**
 * §12's reference factory, as committed. C28 task 3 and its acceptance
 * criterion: "the reference fixture loads and runs headlessly."
 *
 * This is in `npm test`, not in the perf suite, because nothing in it is a
 * timing: it is a check that the file is still the factory §12 describes and
 * still a save this build can open. It is also the test that goes red first
 * when the save schema or the world generator changes under the fixture —
 * the fix is `npm run bench:fixture`, then `npm run perf:baseline`, because a
 * regenerated factory is a new benchmark.
 */

describe('the reference factory fixture', () => {
  it('is §12’s composition', async () => {
    const simulation = await loadReferenceFactory();
    const census = takeCensus(simulation);
    let misc = 0;
    simulation.entities.forEach((entity) => {
      const id = simulation.buildings.forEntityType(entity.type).id;
      if (id === 'chest' || id === 'power_pole' || id === 'generator') misc += 1;
    });

    expect({
      entities: census.entities,
      belts: census.belts,
      inserters: census.inserters,
      machines: census.machines,
      misc,
    }).toEqual({ entities: 20_000, belts: 12_000, inserters: 3_000, machines: 2_500, misc: 2_500 });
    // "~ 8,000 items in flight on belts."
    expect(census.beltItems).toBeGreaterThan(7_000);
    expect(census.beltItems).toBeLessThan(9_000);
    // "World explored: 40 x 40 world chunks."
    expect(simulation.world.explored.size).toBeGreaterThanOrEqual(1_600);
  });

  // Twenty thousand entities for half a minute of game time is a few seconds
  // of work, and more beside the rest of the suite; the default five-second
  // limit is sized for a unit test.
  it('runs headlessly, and is still a factory half a minute later', { timeout: 60_000 }, async () => {
    const simulation = await loadReferenceFactory();
    const before = takeCensus(simulation);
    for (let tick = 0; tick < 900; tick++) simulation.tick();
    const after = takeCensus(simulation);

    // Steady state rather than draining or filling: the benchmark measures a
    // factory at work, not one winding down or backing up.
    expect(after.entities).toBe(before.entities);
    expect(Math.abs(after.beltItems - before.beltItems) / before.beltItems).toBeLessThan(0.1);
  });
});
