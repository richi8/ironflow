/**
 * Phase 9: exploration. See ironflow.md C23 tasks 3 and 5, and §8.
 *
 * Two producers, one set, and nothing in the simulation reads it back:
 *
 * ```text
 *   the player   the world chunks around wherever they are standing
 *   a radar      one world chunk of its coverage per sweep step
 * ```
 *
 * ## Why it is a phase of its own, and why it is ninth
 *
 * §8's phase list is a contract and inserting into it renumbers everything
 * below, so this is **appended**: the only existing phase whose number moved
 * is cleanup, which stays last because it has to. Appending is also the right
 * answer on the merits. The player's reveal has to follow the player's
 * *movement*, or the map would lag a tick behind the legs; a radar built this
 * frame should sweep on the tick it was built, exactly as a generator supplies
 * on the tick it was placed (C21). Running after phase 8 gives both.
 *
 * It could not be folded into phase 8 — that phase is the player, and a radar
 * is a building — and it could not be folded into phase 4, because production
 * runs before the player has moved. A ninth phase is what the two producers
 * actually need.
 *
 * ## What it does *not* do
 *
 * **No alert.** A radar with no power is `no_power` in the inspector, which is
 * the same sentence C21's rule already puts on a lab, and `setStatus` raises
 * the one alert a building standing in open ground deserves. Beyond that,
 * nothing here is a stall the player must act on: a radar that has swept its
 * whole coverage is *finished*, not stuck, and a toast saying so would fire
 * once a minute for the rest of the game.
 */

import type { AlertLog } from '../alerts.js';
import type { EntityStore } from '../entities/entity-store.js';
import { MachineStatus } from '../entities/machine-status.js';
import { asRadar, type RadarEntity } from '../entities/radar-entity.js';
import type { PlayerState } from '../player/player-state.js';
import type { BuildingRegistry, RadarConfig } from '../registries/building-registry.js';
import { CHUNK_MAX, CHUNK_MIN, toChunkCoord } from '../world/chunk.js';
import type { World } from '../world/world.js';

import { PowerGate, type PowerSystem } from './power-system.js';

/**
 * How far around themselves the player reveals, in world chunks.
 *
 * One, so the 3x3 block of world chunks they stand in the middle of is
 * explored: 96 tiles across, which is a little more than a screen at the
 * default zoom and a little less than one zoomed out. A **balance number**,
 * and the one that decides how much of the map is free. Zero would make the
 * explored region a one-world-chunk-wide trail with square corners — the
 * player's own path drawn as a staircase, which reads as a bug rather than as
 * a map.
 */
export const PLAYER_REVEAL_CHUNKS = 1;

export interface ExplorationSystemOptions {
  readonly world: World;
  readonly entities: EntityStore;
  readonly buildings: BuildingRegistry;
  readonly player: PlayerState;
  readonly power: PowerSystem;
  readonly alerts: AlertLog;
}

export class ExplorationSystem {
  private readonly world: World;
  private readonly entities: EntityStore;
  private readonly buildings: BuildingRegistry;
  private readonly player: PlayerState;
  private readonly power: PowerSystem;
  private readonly alerts: AlertLog;

  /**
   * The world chunk the player was in last tick, so a standing player costs
   * nothing.
   *
   * Derived and deliberately *not* authoritative: the sentinel below makes the
   * first tick of a loaded game reveal unconditionally, which is idempotent
   * and is what keeps this cache from being a thing a save has to carry.
   */
  private lastPlayerCx = Number.NaN;
  private lastPlayerCy = Number.NaN;

  constructor(options: ExplorationSystemOptions) {
    this.world = options.world;
    this.entities = options.entities;
    this.buildings = options.buildings;
    this.player = options.player;
    this.power = options.power;
    this.alerts = options.alerts;
  }

  /** Phase 9. The player first, then every radar, in entity-type order (§6 R4). */
  tick(): void {
    this.revealAroundPlayer();

    for (const type of this.buildings.radarTypes()) {
      const config = this.buildings.radarFor(type);
      if (config === null) continue;
      const radars = this.entities.byType<RadarEntity>(type);
      for (let i = 0; i < radars.length; i++) {
        const entity = radars[i];
        if (entity === undefined) continue;
        const radar = asRadar(entity, this.buildings);
        if (radar !== null) this.sweep(radar, config);
      }
    }
  }

  /**
   * Reveal the world chunks around the player, if they have moved into a new
   * one since the last tick.
   *
   * The guard is not an optimisation so much as an honesty check: a player
   * standing still is not exploring, and `revealSquare` over nine world chunks
   * every tick for an hour is nine hundred thousand `Set` probes that can
   * never find anything new.
   */
  private revealAroundPlayer(): void {
    const cx = toChunkCoord(this.player.tileX);
    const cy = toChunkCoord(this.player.tileY);
    if (cx === this.lastPlayerCx && cy === this.lastPlayerCy) return;
    this.lastPlayerCx = cx;
    this.lastPlayerCy = cy;
    this.world.explored.revealSquare(cx, cy, PLAYER_REVEAL_CHUNKS);
  }

  /**
   * One radar, one tick: spend a tick of the sweep step, and reveal one world
   * chunk when it completes.
   *
   * Power is checked first, for the reason `research-system.ts` gives: a
   * building with none does nothing at all, and phase 2 has already settled
   * the ratio for the whole tick (§8). An under-supplied radar sweeps on the
   * ticks its share buys it, so half the power is half the sweep rate rather
   * than none of it — which is what `PowerGate.Throttled` means everywhere
   * else in the game.
   */
  private sweep(radar: RadarEntity, config: RadarConfig): void {
    let working = MachineStatus.Running;
    const power = this.power.gate(radar);
    if (power === PowerGate.Unpowered) {
      this.setStatus(radar, MachineStatus.NoPower);
      return;
    }
    if (power === PowerGate.Starved) return;
    if (power === PowerGate.Throttled) working = MachineStatus.LowPower;

    this.setStatus(radar, working);

    radar.sweepTicks += 1;
    if (radar.sweepTicks < config.sweepTicks) return;
    radar.sweepTicks = 0;

    const side = 2 * config.chunkRadius + 1;
    // Row-major over the coverage square, from its north-west corner: a fixed
    // order that depends on nothing but the radar's own position, so two runs
    // of the same factory reveal the same world chunk on the same tick (§6 R4).
    const index = radar.cursor % config.coverage;
    const cx = toChunkCoord(radar.x) - config.chunkRadius + (index % side);
    const cy = toChunkCoord(radar.y) - config.chunkRadius + Math.floor(index / side);
    // The cursor wraps rather than stopping, which is C23 task 3's "low-rate
    // refresh": a finished radar keeps sweeping its coverage for nothing.
    radar.cursor = (index + 1) % config.coverage;

    // A radar at the very edge of the world sweeps past it. Skipped rather
    // than clamped, for `revealSquare`'s reason: the edge is not explorable
    // ground, and clamping would re-reveal the same rim chunk all sweep.
    if (cx < CHUNK_MIN || cx > CHUNK_MAX || cy < CHUNK_MIN || cy > CHUNK_MAX) return;
    this.world.explored.reveal(cx, cy);
  }

  private setStatus(radar: RadarEntity, status: MachineStatus): void {
    if (radar.status === status) return;
    radar.status = status;
    // C21's rule, one building over: a radar standing in open ground will not
    // connect itself, and nothing about it will change until the player runs a
    // pole. Every other status a radar can hold clears itself.
    if (status === MachineStatus.NoPower) {
      this.alerts.push({ type: 'no_power_network', entityId: radar.id, x: radar.x, y: radar.y });
    }
  }
}
