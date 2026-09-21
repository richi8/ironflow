# IronFlow — Implementation Plan

**A seeded, replayable 2D isometric factory-automation game for the browser.**
Vite + pure TypeScript + Canvas 2D + IndexedDB. No engine, no UI framework.

| | |
|---|---|
| **Status** | **C23 complete — the factory now has somewhere to go.** A radar turns 300 kW into map, the map panel draws what has been explored and jumps the camera to it, and the underground belt gets a line past whatever is in the way. Iron in the starting area is measured at a median 2.6 hours of a reference factory, which is the 2–4 band C23 asked for — no generator change was needed, and §15 now says so. Milestone C is done and every building §15 names exists. Next: C24 — save state model & serializer. |
| **Revision** | 2 |
| **Canonical art** | `ironflow.png` (key art / logo), `ironflow_visual_reference.png` (asset & UI reference sheet) |
| **First action** | Chunk **C24 — Save state model & serializer** |

---

## How to read this document

The document has three parts. They serve different moments.

```text
Part I   — Contracts        Read once, fully, before writing any code.
                            These are invariants. Breaking one is a defect,
                            not a style choice.

Part II  — Build chunks     Read one chunk at a time, immediately before
                            implementing it. C00 -> C30, in order.

Part III — Reference        Consult on demand: balance numbers, performance
                            budgets, determinism hazards, risks, done-criteria.
```

**Terminology used throughout:**

| Term | Meaning |
|---|---|
| *tile space* | Integer grid coordinates the simulation thinks in. `(x, y)`, `+X` right, `+Y` down. |
| *screen space* | Pixels. Only the renderer and input layer know it exists. |
| *tick* | One fixed simulation step. 30 per simulated second. Always an integer count. |
| *authoritative state* | State that is simulated and persisted. |
| *derived state* | State recomputed from authoritative state. Never persisted. |
| *chunk* (world) | A 32×32 tile block of world storage. |
| *chunk* (build) | A unit of implementation work in Part II. Prefixed `C00`–`C30` to avoid confusion. |

Build chunks are always written `C07`, world chunks always "world chunk".

---
---

# PART I — CONTRACTS

These are binding. Part II implements them; Part III measures them.

---

## §1 Identity and pillars

IronFlow is an original factory-builder. It is not a Factorio clone and does not
need Factorio's feature count to be good.

**Pillars, in priority order.** When two pillars conflict, the lower number wins.

1. **A satisfying automation loop.** Building a thing that produces without you is the core verb.
2. **Replayability from the world, not from content volume.** A new seed must produce a genuinely different run.
3. **Legible mechanics.** The player can always see why something is stalled.
4. **Meaningful layout decisions.** Space, throughput and routing are the real puzzle.
5. **Deterministic, stable simulation.** Same seed + same commands = same world, forever.
6. **Performance at real factory sizes.** See §12 for the numbers.
7. **Portable persistence.** A factory survives a browser reinstall and moves between machines.
8. **Visual polish.** Last, but the art direction in §11 is decided, not open.

**The governing metric:**

> Maximize **interesting player decisions per unit of implementation complexity.**

Do not measure progress in lines of code, classes, buildings or systems.
Measure it by: *Can the player automate something new? Does the next unlock
create a new problem rather than a bigger number? Does a new seed force a
different factory?*

---

## §2 v1 scope

### In scope

```text
single player                    procedural seeded world
isometric 2D grid world          resource patches and depletion
manual gathering (early game)    mining
belts, splitters, inserters      furnaces, assemblers
data-driven items and recipes    research / progression
basic power (connected-component networks)
exploration and expansion        save / load via IndexedDB
export / import save files       save migrations
deterministic simulation         custom Canvas 2D renderer
```

### Out of scope for v1

Do not implement without an explicit instruction. Each has a reason, because
"not yet" and "not ever" are different answers.

| Excluded | Reason |
|---|---|
| Multiplayer, networking, backend, accounts, cloud saves | Requires a server and a rollback/lockstep model. The determinism contract (§6) deliberately keeps the door open. |
| Fluids, pipes, tanks, chem plants | A real fluid solver is a project of its own. The art sheet includes these assets — they are post-v1 art, not v1 scope. |
| Oil and uranium | Depend on fluids and on a much longer tech tree. |
| Trains | Needs pathing, scheduling and a second logistics paradigm. |
| Circuit networks | Enormous UI and simulation surface for a niche audience. |
| Robots / logistics bots | Trivialises the belt layout puzzle, which is pillar 4. |
| Blueprints | Only valuable once layouts are large enough to be worth copying. |
| Modding API, content marketplace | Requires a frozen public API. Nothing is frozen yet. |
| Enemies | **Gated, not excluded.** See C31 in the appendix — implement only if the go/no-go test passes. |

**Rule:** an excluded feature must not shape the implementation. Do not add an
abstraction "so we can add trains later."

---

## §3 Technology

### Required

```text
TypeScript   (strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes)
Vite         (build and dev server only)
Canvas 2D    (renderer)
DOM + CSS    (all UI)
IndexedDB    (persistence)
Vitest       (tests, node environment for simulation)
```

### Deliberately avoided

```text
React / Vue / Svelte / Angular      game engines (Phaser, PixiJS, Excalibur)
ECS frameworks                      physics engines
Redux / MobX / Zustand / signals    Tailwind / component libraries
lodash / immer / rxjs               a hand-rolled reactivity system
```

**Vite is a build tool. It must never appear in the architecture.** No
`import.meta.glob` for game data, no Vite-specific module tricks in `src/game/`.
The simulation must be runnable by `vitest` in a plain Node process with no
bundler, no DOM and no Canvas.

### Dependency policy

A third-party runtime dependency is acceptable only when all four hold:

1. It solves a problem that is genuinely hard (not merely tedious).
2. It has no DOM dependency if used in `src/game/`.
3. It is smaller than the code it replaces.
4. Its absence would cost more than a day.

Applied to likely candidates: a noise library — **no**, write ~60 lines of
value/simplex noise seeded by the game PRNG. A PRNG — **no**, write ~20 lines
(§6). An IndexedDB wrapper — **no**, ~120 lines of promisified requests. A
pathfinder — only if C31 (enemies) is greenlit.

### Later option

`WebGL2`. The `Renderer` interface (§8, C03) exists so this is a replacement,
not a rewrite. Do not build WebGL scaffolding before C29.

---

## §4 Architecture

```text
                        Browser
                           |
        +------------------+------------------+
        |                  |                  |
       UI              Renderer             Input
        |                  |                  |
        +------------------+------------------+
                           |
                    GameController          <- facade: commands in, views out
                           |
                         Game               <- orchestration only
                           |
                      Simulation            <- authoritative state + systems
                           |
        +----------+-------+-------+----------+
        |          |               |          |
      World    EntityStore      Systems    Registries
                                              |
                                        (items, buildings,
                                         recipes, tech)
                           |
                     Persistence            <- plain-object serialization
```

### Directory layout

Create files when a build chunk needs them. Do not scaffold the whole tree in C00.

```text
src/
  main.ts                      # composition root; the only file wiring everything

  game/
    game.ts                    # orchestration
    game-loop.ts               # rAF + fixed-timestep accumulator
    game-controller.ts         # facade for UI: commands in, view models out
    simulation.ts              # tick(), owns state, runs systems in phase order
    simulation-clock.ts
    rng.ts                     # seeded PRNG

    world/
      coordinates.ts           # tile space types + helpers (NO screen space)
      tile.ts
      chunk.ts
      world.ts
      world-generator.ts

    entities/
      entity.ts                # plain serializable shapes
      entity-store.ts
      entity-types.ts

    registries/
      item-registry.ts
      building-registry.ts
      recipe-registry.ts
      technology-registry.ts

    data/                      # pure content data, no logic
      items.ts
      buildings.ts
      recipes.ts
      technologies.ts

    systems/
      mining-system.ts
      production-system.ts
      belt-system.ts
      inserter-system.ts
      power-system.ts
      research-system.ts

    items/inventory.ts
    player/player-state.ts

    commands/
      command.ts               # discriminated union of every command
      command-processor.ts

    views/                     # read-only view models produced for the UI
      building-view.ts
      hud-view.ts

    save/
      save-format.ts           # versioned interfaces
      save-serializer.ts
      save-validator.ts
      save-migrator.ts

  renderer/
    renderer.ts                # interface
    canvas-renderer.ts
    projection.ts              # THE ONLY file that converts tile <-> screen
    camera.ts
    sprite-atlas.ts
    palette.ts                 # TS mirror of styles/tokens.css (§11)
    layers/                    # terrain, entities, overlays, ghost
    render-state.ts

  input/
    input-manager.ts
    mouse-input.ts
    keyboard-input.ts
    keybindings.ts

  ui/
    ui.ts
    hud.ts  build-menu.ts  inspector.ts  inventory-panel.ts
    research-panel.ts  save-menu.ts  notifications.ts  toolbar.ts

  persistence/
    save-repository.ts
    indexeddb-save-repository.ts
    memory-save-repository.ts  # test double
    export-import.ts

  platform/                    # browser adapters behind interfaces game/ defines
    browser-clock.ts           # FrameScheduler: rAF + performance.now
    canvas-surface.ts          # canvas sizing, devicePixelRatio, ResizeObserver

  debug/
    debug-overlay.ts
    profiler.ts

  styles/
    tokens.css                 # design tokens from §11
    main.css

tests/
  unit/
  integration/
  determinism/
  fixtures/
```

### Dependency rules

These are enforceable and must be enforced (see C00, lint boundaries).

| Layer | May import | Must never import |
|---|---|---|
| `game/**` | `game/**` only | DOM, Canvas, Vite, `renderer/**`, `ui/**`, `input/**`, `persistence/**` |
| `renderer/**` | `game/**` types, `render-state` | `ui/**`, anything that mutates simulation state |
| `input/**` | `game/**` command types | `renderer/**` internals, simulation state |
| `ui/**` | `game/game-controller`, view models | simulation internals, `renderer/**` |
| `persistence/**` | `game/save/**` types | simulation systems, DOM rendering |
| `platform/**` | `game/**` interfaces | simulation state, `ui/**`, `renderer/**` internals |
| `main.ts` | everything | — |

**Corollaries:**

- The renderer reads simulation state and **never writes to it**. If the renderer
  needs to remember something (animation phase, interpolation), it stores it in
  its own structures keyed by entity id.
- The UI never mutates a machine, inventory, belt or research state. It issues a
  command (§7) and re-reads a view model.
- Persistence serializes plain data. **Never persist a class instance**, never
  rely on `constructor.name`, never use `JSON.stringify` on an object graph with
  cycles or `Map`/`Set` values.

### A concrete test for "is this in the right place?"

> Could this code run in a Node process with `globalThis.document` deleted?
> If yes, it may live in `game/`. If no, it may not.

C00 adds a test that imports the entire `game/` barrel with `document`, `window`
and `HTMLCanvasElement` undefined. It must pass at every commit.

---

## §5 The projection contract

**Decided: the simulation is projection-agnostic; the renderer is isometric.**

This resolves the contradiction between the previous revision's "top-down
grid" and `ironflow_visual_reference.png`'s "2D / ISOMETRIC".

```text
SIMULATION            integer tile coordinates only
                      (x, y), +X right, +Y down
                      knows nothing about pixels, diamonds or depth
                          |
                          | projection.ts  <-- the only bridge
                          v
RENDERER              screen pixels, isometric diamonds, depth-sorted
INPUT                 screenToTile() inverse of the same transform
```

### The transform

Tiles are 2:1 diamonds.

```text
TILE_W = 64        // full diamond width in px at zoom 1
TILE_H = 32        // full diamond height in px at zoom 1

tileToScreen(x, y):
    sx = (x - y) * (TILE_W / 2)
    sy = (x + y) * (TILE_H / 2)

screenToTile(sx, sy):
    tx = (sx / (TILE_W / 2) + sy / (TILE_H / 2)) / 2
    ty = (sy / (TILE_H / 2) - sx / (TILE_W / 2)) / 2
    // floor() for the containing tile
```

`projection.ts` exposes exactly these two functions plus the constants. Nothing
else in the codebase may contain `TILE_W`, `/ 2`-style projection math, or the
words "iso"/"diamond". If a second file needs to project, it imports this one.

**Implementation note (C01).** Two things this section left implicit, now fixed
by the shipped code and pinned by tests:

- **`tileToScreen(x, y)` returns the diamond's top vertex, not its centre.**
  Tile `(x, y)` covers the unit square `[x, x+1] x [y, y+1]` in tile space, so
  its diamond's centre is `TILE_H / 2` *below* the returned point. This is
  forced by the transform as written — it is what makes `floor(screenToTile(p))`
  the tile containing `p` — but C03 has to know it to anchor a sprite, so it is
  written down rather than rediscovered.
- **Flooring lives on the camera, not here.** `projection.ts` really does expose
  only the two functions; `Camera.screenToTile` applies `Math.floor` to a
  `screenToWorld` result. `Math.floor` is not projection arithmetic, and keeping
  it out preserves "exactly these two functions" literally.

**Implementation note (C04).** Hazard 2 is implemented, in
`renderer/picker.ts`. `Camera.screenToTile` still answers with the ground tile
and is still the right answer for cull bounds and for terrain; `ScenePicker`
is the one to ask whenever the answer has to match what the player can see. It
lives in the renderer because the answer depends on how tall a sprite is drawn
and §4 forbids `input/**` from knowing that.

The rule itself is now enforced rather than merely stated:
`tests/unit/projection-boundary.test.ts` scans every file under `src/` except
`projection.ts` and fails on `TILE_W`/`TILE_H`, on the words "isometric" or
"diamond" in code, and on the two transforms written out by hand. A file that
one day genuinely needs a tile dimension is added to its allow-list with a
note, which makes the leak a decision instead of an accident.

### Depth sorting

Painter's algorithm on a stable key.

```text
depth = (x + y) * LARGE + layerBias * SMALL + entityId
```

- `x + y` is the isometric depth axis: larger draws later (in front).
- `layerBias` orders things that share a tile: terrain < resource < belt <
  building < item-on-belt < inserter-arm < overlay.
- `entityId` breaks remaining ties **deterministically** — never leave tie-break
  to array order.

Multi-tile buildings sort by their **maximum** `(x + y)` corner and are drawn
with a bottom-center anchor at the projected center of their footprint.

### Known hazards (see also §16 risk register)

1. **Tall sprites overlapping.** A 3-tile-tall power plant will occlude tiles
   behind it. This is correct isometric behaviour, but the ghost preview and
   the hover highlight must still be visible — draw both in the overlay layer,
   after everything.
2. **Picking a tile under a tall building.** `screenToTile` returns the *ground*
   tile. Entity picking must additionally test entity sprite bounds in reverse
   depth order and prefer the topmost hit. Implement in C04; the naive
   ground-tile version is acceptable until C06.
3. **Zoom and fractional pixels.** Round the final translate to whole device
   pixels before drawing terrain, or diamond seams appear. Keep the camera
   position itself fractional.

### What this does *not* mean

The simulation must **never** gain an "isometric" concept. Belt directions are
`N/E/S/W` in tile space. Adjacency is `x±1, y±1`. If a system ever needs to
know how something looks, that system is in the wrong layer.

---

## §6 The determinism contract

> Same seed + same initial state + same command sequence + same tick count
> ⇒ **byte-identical authoritative state.**

This is not an aspiration. It is a tested invariant from C18 onward, and it is
what makes reproducible bugs, benchmarks, regression tests, balance testing and
any future replay or multiplayer possible.

### Rules

**R1 — No ambient nondeterminism in `game/`.**
Banned: `Math.random`, `Date.now`, `performance.now`, `crypto.getRandomValues`,
`navigator.*`, `Intl.*`, locale-sensitive sorting. C00 adds a lint rule.

**R2 — All randomness comes from the seeded PRNG.**

```ts
// game/rng.ts — mulberry32; 32-bit, fast, adequate for worldgen and jitter
export function createRng(seed: number) {
  let s = seed >>> 0;
  return function next(): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

The RNG **stream position is authoritative state** and must be serialized.
Worldgen uses a *separate, positionally-derived* stream — `hash(seed, cx, cy)` —
so that generating world chunks in a different order still yields the same world.
Never let worldgen consume the simulation stream.

**Implementation note (C18).** The snippet above returns a *closure*, and a
closure hides `s` — which is precisely the value the next sentence requires to
be serialized. `game/rng.ts` therefore ships the same arithmetic on a class:
`Rng` exposes `state` (the 32-bit word, which *is* the stream position, because
mulberry32 keeps nothing else) and `Rng.fromState` resumes from it.
`createRng(seed)` is kept, over the same object, for a caller that wants
numbers and has no state to persist. Two other things the snippet leaves
implicit are now fixed: a seed is normalised through `toUint32`, which
**throws** on `NaN` and `Infinity` rather than letting `>>> 0` turn two
different worlds into seed 0; and `nextInt(bound)` multiplies rather than takes
a modulus, because a modulus over a non-power-of-two bound is biased toward the
low values in a way a worldgen balance pass would chase for a day.

**Nothing draws from the stream yet.** Every decision in the simulation as of
C18 is a round-robin or a counter, deliberately. The *seed* is real state from
C18 — `Simulation.seed`, chosen in `main.ts`, folded into the determinism hash
— so that the day C19's generator draws from a stream, the tests are already
watching it.

**R3 — Progress is counted in integer ticks, never accumulated floats.**

```ts
// WRONG — drifts, and drifts differently after a save/load
machine.progress += dt;
if (machine.progress >= recipe.duration) { ... }

// RIGHT — exact, serializes losslessly, compares exactly
machine.progressTicks += 1;
if (machine.progressTicks >= recipe.durationTicks) { ... }
```

All durations in `data/` are authored in seconds for readability and converted
to ticks **once** at registry-build time, using `Math.round(seconds * TPS)`.
Belt item positions are the one exception (§9) and use fixed-point integers.

**R4 — Iteration order must be explicit and stable.**
`Map` and `Set` iterate in *insertion* order. After a save/load the insertion
order differs from the live session, so **iterating a `Map` inside a simulation
system silently breaks determinism across a reload.** Systems iterate a
dense, id-ordered array maintained by the `EntityStore`.

**R5 — Entity ids are monotonic and never reused.** A recycled id changes
ordering. Ids are `number`, allocated from a counter that is itself serialized.

**R6 — Contention is resolved by id, not by encounter order.**
Two inserters reaching for the same item, two machines pulling the last ore:
lowest entity id wins. Document it, test it.

**R7 — No NaN, no Infinity, and no `-0`.** Every division guards its
denominator. A determinism test asserts every numeric field in a serialized save
is finite.

`-0` was added to this rule in C01, after `rotateOffset` produced it for a zero
component. It is the quietest of the three: `-0 === 0` is true, so it is
invisible to every ordinary comparison, but `Object.is` and `deepEqual` treat it
as distinct while `JSON.stringify` silently normalises it to `0`. A `-0` written
into authoritative state therefore survives a save round trip as a *different*
value and fails R8 — months after the code that created it was written. Write
negation as `0 - v` rather than `-v` wherever the operand may be zero.

**R8 — Save round-trip is a determinism test.**

```text
run N ticks -> state A
run N/2 ticks -> save -> load -> run N/2 ticks -> state B
assert deepEqual(A, B)
```

This catches the entire class of "we forgot to serialize that" bugs, which are
otherwise found by players three weeks later.

### Deliberately non-deterministic (and therefore never in `game/`)

Renderer interpolation, animation phase, particle effects, audio, tooltip text,
UI throttling. All of these may read the clock freely.

---

## §7 Commands

Every player action becomes a command. Nothing mutates authoritative state
except a system running inside `Simulation.tick()`.

```text
DOM event -> InputManager -> Command -> queue -> tick phase 1 -> validate -> apply
```

```ts
export type Command =
  | { type: 'build';      buildingId: string; x: number; y: number; rotation: Rotation }
  | { type: 'remove';     x: number; y: number }
  | { type: 'rotate';     entityId: EntityId }
  | { type: 'setRecipe';  entityId: EntityId; recipeId: string | null }
  | { type: 'insertItems'; entityId: EntityId; itemId: string; amount: number }
  | { type: 'takeItems';  entityId: EntityId; itemId: string; amount: number }
  | { type: 'startResearch'; technologyId: string }
  | { type: 'cancelResearch'; technologyId: string }   // added in C22
  | { type: 'craftItem';  recipeId: string; count: number }   // added in C21A
  | { type: 'cancelCraft'; index: number }                    // added in C21A
  | { type: 'movePlayer'; dx: number; dy: number }
  | { type: 'mineTile';   x: number; y: number }
  | { type: 'stopMining' };                      // added in C10, see below
```

**Implementation note (C22).** `cancelResearch` is the member this union did
not predict, for the reason `stopMining` was C10's: `startResearch` puts a
technology in a *queue*, and a queue a player can add to and never remove from
punishes a misclick for the next ten minutes. Encoding the release as "start it
again to cancel it" would make one button mean two things.

It is the one command in the game that **cannot fail for a reason the player
would have to undo**: the units already researched stay recorded against the
technology, and a lab holding a part-finished unit keeps it, because a unit of
research work belongs to no particular technology. Cancelling a technology that
other queued technologies depend on takes them with it, since a queue with an
unreachable entry in the middle is a stall nothing would explain.

The refusals are `unknown_technology`, `already_researched`, `already_queued`,
`missing_prerequisites` and `research_queue_full` for `startResearch`, and
`unknown_technology` or `nothing_queued` for `cancelResearch`. C22 also adds
**`locked`** to the vocabulary, which is not a research command's refusal at
all: it is what `build`, `craftItem` and `setRecipe` answer when research has
not revealed what they name. One reason for a building and a recipe alike,
because the player does the same thing about either — and *which* technology is
printed beside the thing itself in the build menu and the research panel, where
it can be read without a toast going past.

**Implementation note (C21A).** `craftItem` and `cancelCraft` are the two
members hand-crafting needed, and they are owned by
`game/systems/crafting-system.ts`. The thing worth writing down is **when the
ingredients move**: `craftItem` takes the whole order's bill out of the bag on
the tick it is applied, not as each item comes up. That is what makes an order
in the queue an order that will finish — no stalled state to explain (pillar
3) — and it is why `cancelCraft` exists at all, since a refund is then the
only way back. The refusals are `unknown_recipe`, `not_craftable` (§15 says
that one needs a machine), `unaffordable` and `craft_queue_full`; `cancelCraft`
answers `nothing_queued`, or `inventory_full` when the refund will not fit,
because a cancel that voided four gears would be worse than the queue.

**Implementation note (C16).** `setRecipe` joined them there. It is the player
reaching into a machine — it hands the ingredients of the old recipe back
(C16 task 2) and it needs the same reach the other two need — rather than
anything `production-system.ts` does, which is run every machine every tick
with no idea where anybody is standing. It is refused with `unknown_recipe`
for an id no recipe has and `not_accepted` for a building that cannot run one.

**Implementation note (C12).** `takeItems` and `insertItems` are owned by
`game/systems/hand-system.ts` — the player reaching into a machine, in phase 1
because somebody clicked, as against C14's inserter, which is a building
running in phase 6. Taking is real; **inserting is validated and refused**,
because a miner's buffer is an output and nothing else in the game has an input
buffer until C15's furnace. See C12's deviations. **C15 implemented it**: the
refusal now comes from the building — a miner has no input port, a furnace
refuses what no smelting recipe wants — rather than being a standing answer.

**Implementation note (C10).** Two refinements, both forced by the fact that
commands arrive at *frame* rate and take effect at *tick* rate.

- **`stopMining` was added.** This union was written out complete on day one
  and this is the one member it did not predict. `mineTile` starts a *held*
  action — C10 task 4 says "hold left-click" — and a held action needs a
  release. Encoding release as the *absence* of a command would mean the
  simulation inferring it from how long it had been since the last `mineTile`,
  which makes mining depend on how often the input layer happens to send one,
  which is frame rate.
- **`movePlayer` sets a direction that persists across ticks**, rather than
  moving the player one step. Only the *sign* of each component is read: the
  command carries a direction and never a distance, because speed belongs to
  the simulation. A 144 Hz browser enqueues the same vector about five times
  per tick and a 20 Hz one leaves a third of the ticks with none; under
  "one command, one step" the first would walk five times as fast and the
  second two thirds as fast. Under "one tick, one step" both are identical,
  which is C10's fourth acceptance criterion.

### Rules

- Commands are **plain serializable data**. No functions, no entity references,
  no DOM objects. This is what makes replay and future multiplayer possible.
- Commands are **validated inside the simulation**, not by the UI. The UI may
  *additionally* pre-check to grey out a button, but the simulation is the
  authority and must reject invalid commands without throwing.
- A rejected command returns a typed reason (`'occupied' | 'unaffordable' |
  'out_of_range' | 'unknown_recipe' | ...`) which the controller turns into a
  notification. Never fail silently — invisible rejection is the single most
  common "the game feels broken" bug in this genre.
- Commands are applied in **queue order at the start of a tick**, never mid-tick.
- The command queue is drained fully each tick, with a per-tick cap (1024) to
  bound worst-case latency from held-down build-drag.
- **The queue itself is capped too (C04).** The per-tick cap bounds a tick's
  work but not memory: a producer faster than the drain grows the queue without
  limit, and the failure mode is a tab that slows down over minutes with
  nothing to point at. `MAX_PENDING_COMMANDS` is four ticks' worth, and
  overflow is a visible `'queue_full'` rejection rather than a silent drop.

---

## §8 Game loop and simulation phases

### Loop

```text
requestAnimationFrame(now)
  |
  +-- frameDt = min(now - last, MAX_FRAME_MS)     <- clamp! see below
  +-- accumulator += frameDt
  |
  +-- steps = 0
  |   while accumulator >= SIM_MS and steps < MAX_STEPS_PER_FRAME:
  |       simulation.tick()
  |       accumulator -= SIM_MS
  |       steps += 1
  |
  +-- if steps === MAX_STEPS_PER_FRAME: accumulator = 0   <- shed debt
  |
  +-- alpha = accumulator / SIM_MS
  +-- renderer.render(state, camera, alpha)
```

```ts
export const TPS = 30;
export const SIM_MS = 1000 / TPS;          // 33.333…
export const MAX_FRAME_MS = 250;           // never process >0.25s of real time
export const MAX_STEPS_PER_FRAME = 5;      // spiral-of-death guard
```

**Why the clamps matter.** `requestAnimationFrame` stops in a background tab.
Return after five minutes and an unclamped accumulator asks for 9,000 ticks in
one frame: the tab freezes, then the watchdog kills it. IronFlow's answer is
explicit and player-visible: **the game does not run in a background tab.** Time
away costs nothing and produces nothing. If offline progress is ever wanted it
must be a deliberate, separately-designed feature — never an accident of the
accumulator.

Also handle `visibilitychange` by resetting `last` on resume, and pause the loop
outright when a modal save/load dialog is open.

**Implementation note (C22).** Phase 7 exists. It walks the labs, spends one
science item per **research unit**, and applies a completed technology's
unlocks *inside the phase* — which is what makes "completing a technology
immediately makes its unlocks buildable" a property of the phase order rather
than of a callback: phase 8 and the next tick's phase 1 both see the new
tables. The head of the queue is re-read per lab rather than once for the
phase, so a lab that finishes a technology is seen by the labs walked after it
and the next technology starts on the same tick.

**Implementation note (C21A).** Phase 8 has a second system in it. Hand-crafting
(`crafting-system.ts`) runs **before** movement and manual mining, and the
order is visible to the player: a craft that completes this tick is in the bag
before a step of walking or a swing of the pick is judged against it, so a
player mining beside a finishing craft sees the two in the order they happened
rather than in the order the systems were written.

**Implementation note (C21).** Phase 2 exists. It resolves the pole graph, sums
each network's demand and supply, and divides — in that order, and before any
consumer is visited, which is what makes "every machine in the tick sees one
satisfaction ratio" a property of the phase order rather than of each system's
care. Phases 3 onward ask `PowerSystem.gate(entity)` and get one of five
answers; a building the content table gave no power rating always gets `Free`,
so a system consults it unconditionally rather than testing first whether the
thing it is holding is electric.

**Implementation note (C07).** "Pause the loop" is now a real control, and it is
not `stop()`. `GameLoop.setPaused` keeps drawing and stops ticking: a stopped
loop draws nothing, so the canvas freezes and the camera dies with it, whereas a
paused game is one the player can still pan around. A paused frame rebases the
clock rather than advancing it, so a five-minute pause runs exactly zero
catch-up ticks — the same answer this section gives for a backgrounded tab, for
the same reason. C25's modal save dialog uses this; C07's HUD gives it a button
and `P` a keybinding.

**Implementation note (C00).** The accumulator sketched above is a float in
milliseconds. The shipped `SimulationClock` counts in integer units of
`microseconds x TPS`, where one tick costs exactly 1,000,000, because 1000/30 is
not representable in binary floating point and the error compounds — a float
accumulator loses a tick over ten seconds, and loses a *different* number
depending on frame spacing. It also sheds debt only when a full tick of debt
actually remains, rather than unconditionally on hitting the step cap, so a
frame that consumed exactly its budget keeps its legitimate sub-tick remainder
for interpolation. Both are refinements of this section, not departures from it.

**Simulation rate and render rate are independent.** Production speed must never
depend on FPS. A test at C18 runs 1,000 ticks with three different frame
patterns and asserts identical output.

### Phase order

Every tick runs these phases in this exact order. The order is documented, and
changing it is a deliberate act with a changelog entry.

```text
1.  commands          drain queue, validate, apply
2.  power             compute network supply/demand -> satisfaction ratio
3.  mining            miners extract from resource tiles into their buffers
4.  production        furnaces/assemblers advance progress, consume, produce
5.  belts             move items along belts, hand off between belts
6.  inserters         transfer items between belts / machines / chests
7.  research          consume science, advance progress, apply unlocks
8.  player            movement, manual mining, hand-crafting
9.  exploration       the player and every radar reveal world chunks    (C23)
10. cleanup           process removals, compact stores, emit events
```

**Implementation note (C23).** Phase 9 is the first phase *added* to this list
since it was written, and it is **appended** rather than inserted: cleanup is
the only phase whose number moved, and it stays last because it has to. This
is the changelog entry the paragraph above asks for.

Appending is also what the phase needs on the merits. Its two producers want
opposite ends of the tick — the player's reveal has to follow the player's
*movement* or the map lags a tick behind the legs, and a radar built this frame
should sweep on the tick it was built, exactly as C21's generator supplies on
the tick it was placed. Running after phase 8 gives both. It could not be
folded into phase 8, which is the player and not a building, nor into phase 4,
which runs before the player has moved.

Nothing in the simulation reads the explored set back. It is authoritative
(§10) and persisted (§14) because nothing else records it — a world chunk the
player crossed and one they never approached are byte-identical — and its only
consumer is the map panel's view model.

**Why this order.** Power resolves first so every machine in the tick sees the
same satisfaction ratio. Mining before production so a freshly-mined ore can be
consumed the same tick it lands. Belts before inserters so an inserter picks up
from a belt's *settled* position, which makes throughput predictable instead of
oscillating with array order. Cleanup last so no system ever observes a
half-removed entity.

### Intra-phase ordering (the part usually forgotten)

- **Belts** update **downstream-first**: the tile nearest the output end moves
  first, then the one behind it. Updating upstream-first makes items compress
  by one slot per tick and changes effective belt speed.
- **Belt networks** (once C29 introduces them) are ordered by the entity id of
  their head segment.
- **Machines, inserters, miners** iterate the `EntityStore`'s id-ordered dense
  array. Never a `Map`, never `Object.values`.
- **Events** emitted during a tick are queued and dispatched in `cleanup`,
  never mid-phase — a listener that mutates state mid-phase is a determinism bug.

---

## §9 Belt model

Decided up front because it ripples through inserters, throughput, balance and
the renderer.

### v1 decisions

| Decision | Value | Rationale |
|---|---|---|
| Lanes | **One lane per belt** | Two lanes double the simulation cost and the UI complexity for a decision most players make by reflex. Splitters and routing carry the layout puzzle instead. |
| Item spacing | 4 slots per tile | Dense enough to look like flow, cheap enough to simulate. |
| Position encoding | fixed-point integer, 0…255 across a tile | Exact, serializable, determinism-safe (§6 R3). |
| Item representation | `{ itemId: number; pos: number }` in a per-tile ring | Belt items are **not** entities. Do not give them ids, do not put them in the `EntityStore`. |
| Curves | Belt direction is per-tile; a curve is inferred by the renderer from neighbours | Simulation stays direction-only; the art sheet's curve sprite is a render concern. |
| Underground belts | Tech unlock, C23 | High layout-decision value per unit of complexity. A pair of entities with a validated span. |

### Throughput

```text
belt tier 1:  2.0 tiles/s  x  4 items/tile  =  8.0 items/s
belt tier 2:  4.0 tiles/s  x  4 items/tile  = 16.0 items/s
```

These numbers are the anchor for all machine rates in §15. Change them and the
whole content bible must be re-derived.

**Implementation note (C23).** The row above says "C22" and it was C23's; more
usefully, it says "a pair of entities with a validated span" and that turned
out to be three decisions rather than one.

- **A run is one lane, as long as the run.** The entrance owns
  `(span + 1) * BELT_TILE_UNITS` of fixed-point positions and an item leaves
  when it passes the end of them, so transit time is distance over speed with
  nothing added and nothing saved: **a buried run is exactly as fast as the
  surface belt it replaces**, and holds exactly as many items. The obvious
  alternative — the entrance holding one tile's lane and the item reappearing
  at the exit — would make a six-tile run five tiles faster than the belt
  beside it, and burying a line would become a *throughput* upgrade rather than
  a routing choice. That is the one thing this building must not be.
- **Which mouth is which is geometry, not a field.** Both mouths store `link`
  and neither stores a role; the entrance is the one whose partner lies ahead
  of it along its own rotation. A stored flag is a second copy of a fact that
  two positions already carry. A mouth with no partner is an entrance with a
  span of zero, so it behaves as an ordinary belt tile — pairing is a run
  getting *longer*, and there is no inert state to explain (pillar 3).
- **The span is validated against the run the player is finishing.** See C23's
  decisions for the rule and for the one arbitrary number in it.

`laneAccept` and `laneEntryPosition` gained an optional lane length for this,
which is the only change C23 made to C13's belt code.

**Implementation note (C13).** 256 units per tile over 30 ticks is 17.07 units
per tick, and §6 R3 says that stores as the integer 17. A tier-1 belt therefore
runs at 1.992 tiles/s and carries **7.97 items/s**, which is the 0.42% that
C13's acceptance criterion allows ±1% for. The alternative — a sub-tile scale
picked to divide the tick rate evenly, such as C10's 240 subtiles — was
considered and rejected: it would put a number with no justification of its own
in the table above to hide a rounding error 0.4% wide, and every rate in §15 is
authored to a coarser resolution than that. `BeltConfig` in
`registries/building-registry.ts` carries the same note beside the arithmetic.

### Required behaviours

insertion, movement, blocking (an item stops behind a stationary item),
end-of-belt output, belt-to-belt handoff, direction change, splitter round-robin,
and **backpressure that propagates**: a full chest must eventually stall the
miner. Backpressure that does not propagate is the bug that makes a factory game
feel fake.

---

## §10 Authoritative vs derived state

| Authoritative — simulated and persisted | Derived — recomputed, never persisted |
|---|---|
| world seed, RNG stream position | terrain tiles outside modified world chunks |
| tick counter | production rate per minute |
| entity positions, types, rotations | power satisfaction percentage |
| inventory contents | visible world chunk list |
| machine recipe, progress ticks, buffers | render batches, depth-sorted draw list |
| belt item contents and positions | tooltip and inspector text |
| resource tile remaining amounts | selected-building panel contents |
| research state and unlocked technologies | spatial index / occupancy grid |
| *(C22: the queue, the completed set, and part-finished units)* | *(C22: which buildings and recipes are unlocked — a pure function of the left column, `research/unlocks.ts`)* |
| *(C23: the explored world-chunk set — `world/explored.ts`)* | *(C23: the map panel's downsampled cells, cached on `WorldChunk.revision`)* |
| player position and inventory | belt network topology |
| next entity id | reachability and connectivity graphs |

Two consequences:

1. **Persist the left column only.** Everything on the right is rebuilt in a
   `rebuildDerived()` pass after load. A bug where derived state is persisted
   shows up as a save that loads into a subtly wrong world.
2. **`rebuildDerived()` must be idempotent and must be exercised in tests.**
   The determinism round-trip test (§6 R8) covers it.

---

## §11 Visual direction

Both reference images in this repository are canonical. Read them before C03.

`ironflow_visual_reference.png` specifies: **clean, readable, stylized;
contrast / functional / modern**, 2D isometric sci-fi. It also enumerates the
v1 asset list and the eight HUD icons. Treat it as the art spec.

### Design tokens

Author these once in `styles/tokens.css` and use them everywhere — UI **and**
canvas. The renderer reads them from a TS constant mirror so canvas and DOM
never drift. That mirror is `renderer/palette.ts` (added in C03), and
`tests/unit/sprite-atlas.test.ts` parses this stylesheet and fails on any
disagreement between the two in either direction.

```css
:root {
  /* surfaces — deep navy, matching the reference sheet background */
  --if-bg-deep:    #0b111c;
  --if-bg:         #131c2b;
  --if-panel:      #1b2536;
  --if-panel-high: #24334a;
  --if-stroke:     #2c3a52;

  /* text */
  --if-text:       #dbe4f0;
  --if-text-muted: #8a9ab0;
  --if-text-dim:   #5d6b80;

  /* brand — orange is the action/energy colour, blue is structure */
  --if-accent:      #f2681f;
  --if-accent-high: #ff8a3d;
  --if-accent-dim:  #a8481a;
  --if-blue:        #3d7ebd;
  --if-blue-high:   #5aa3e0;

  /* status */
  --if-ok:      #3fbf7f;
  --if-warn:    #e8b13a;
  --if-danger:  #e0523f;
  --if-ghost-valid:   rgba(63, 191, 127, 0.45);
  --if-ghost-invalid: rgba(224, 82, 63, 0.45);

  /* terrain */
  --if-terrain-grass: #4a6b3a;
  --if-terrain-dirt:  #6b5540;
  --if-terrain-sand:  #b09361;
  --if-terrain-stone: #55606e;
  --if-terrain-water: #23516e;

  /* resource tint — matches the reference sheet node colours.
     C20 retuned iron and stone: at #7d94ad and #9aa3ad they were four points
     apart in hue, and iron ore on stone terrain (#55606e) was near-invisible
     on a generated map. Iron went warmer and lighter, stone went to a warm
     grey, so the two read apart at a glance. C19 noticed it; this is the
     balance pass owning it. */
  --if-iron:   #8fa6c6;
  --if-copper: #c96a3a;
  --if-coal:   #2b3242;
  --if-stone:  #b9b2a2;

  /* smelted and assembled goods (C15, C16) — an item whose id strips to a
     token above is drawn in that colour, so only the ones that are nobody's
     ore are listed. */
  --if-steel:   #b8c4d0;
  --if-brick:   #a8543a;
  --if-gear:    #8b96a4;
  --if-circuit: #3f8f6a;

  /* building items (C20). §15's building recipes make a building into a thing
     that rides a belt, so each one needs a colour of its own: a single shared
     "machine grey" would make a mixed line unreadable. The token *is* the
     item id, exactly as a resource's is, so adding a building adds a colour
     here and nothing anywhere else. */
  --if-miner:     #e0913f;
  --if-belt:      #4f7fa8;
  --if-splitter:  #6b8fd4;
  --if-inserter:  #7a6ec4;
  --if-chest:     #8a7250;
  --if-furnace:   #c25a4a;
  --if-assembler: #46a88f;

  --if-radius: 4px;
  --if-font: ui-monospace, 'SF Mono', 'JetBrains Mono', monospace;
}
```

Type is monospace throughout — the reference sheet's labels are, and it suits an
industrial readout aesthetic. Numbers must be tabular-aligned in the HUD.

### Placeholder-first art pipeline

There are no sprites in this repository and there will not be for a long time.
Do not let art block mechanics.

```text
C03  procedurally drawn placeholders
     - terrain: flat-shaded diamonds from the token palette
     - buildings: extruded diamond prism, category colour, 2-letter code
     - belts: directional chevrons; inserters: a line + a dot
     Everything is drawn by code. Zero image assets.
        |
C29  atlas-backed sprites
     - SpriteAtlas interface introduced in C03 with a procedural
       implementation, swapped for an image-backed one here.
     - Renderer code does not change.
```

`SpriteAtlas` is declared in C03 precisely so C29 is a swap. This is the one
"future-proofing" abstraction the plan permits, because it is one interface with
two real implementations, not speculation.

### HUD icon set

The reference sheet defines eight: **resource, building, power, research,
inventory, alert, map, pause**. Draw them as inline SVG in `ui/`, one file, with
`currentColor`. No icon font, no sprite sheet for UI.

---

## §12 Performance budgets

The previous revision said "good performance at reasonably large factory sizes",
which is not a target anyone can fail. These are the targets. They are measured
by the profiler built in C28 and asserted by benchmarks.

### Reference factory

The benchmark scenario, built as a save fixture in C28:

```text
20,000 entities total
  12,000 belt tiles
   3,000 inserters
   2,500 machines (miners, furnaces, assemblers)
   2,500 misc (chests, poles, generators)
~ 8,000 items in flight on belts
world explored: 40 x 40 world chunks (1280 x 1280 tiles)
```

### Budgets

| Metric | Target | Hard fail |
|---|---|---|
| Simulation tick, mean | ≤ 8 ms | > 20 ms |
| Simulation tick, p99 | ≤ 16 ms | > 33 ms *(cannot keep 30 TPS)* |
| Render frame, mean @ 1080p | ≤ 8 ms | > 16 ms |
| Sustained FPS, reference factory | 60 | < 30 |
| Entities on screen at max zoom-out | ≥ 5,000 | — |
| JS heap, reference factory | ≤ 400 MB | > 800 MB |
| Save serialize | ≤ 300 ms | > 1 s |
| Save file size, reference factory | ≤ 2 MB gzipped | > 10 MB |
| Load + rebuildDerived | ≤ 1 s | > 3 s |
| Worldgen, 40×40 world chunks | ≤ 500 ms | > 2 s |
| Cold start to interactive | ≤ 1.5 s | > 4 s |
| GC pauses during steady play | none visible | any > 50 ms |

**Do not optimise toward these before C28 measures them.** They exist to define
"done", not to justify premature complexity. See §16 for the sanctioned
optimisation paths, which are to be walked only when the profiler says so.

---

## §13 UI architecture

### Structure

```text
GameUI
 +-- Toolbar        build categories, hotbar 1-9
 +-- HUD            resources, power, research progress, tick rate, alerts
 +-- BuildMenu      full building list, costs, locked/unlocked
 +-- Inspector      selected entity: status, progress, contents, rate
 +-- InventoryPanel player inventory
 +-- ResearchPanel  tech tree, current research, queue
 +-- SaveMenu       list, save, load, delete, export, import
 +-- Notifications  transient toasts, including command rejections
```

These are UI classes. They are not game entities and they do not appear in
`game/`.

### Rules

- **Build the DOM once.** Create elements in a `mount()`, keep references, and
  update by assigning `textContent` / toggling classes. Never rebuild a panel's
  subtree on update — that is what makes hand-written DOM UI feel bad.
- **Every panel has an explicit `update(view)` method** taking a read-only view
  model. No panel reaches into the simulation.

```ts
interface MachineView {
  readonly name: string;
  readonly status: 'running' | 'no_power' | 'no_input' | 'output_full' | 'no_recipe' | 'idle';
  readonly progress: number;          // 0..1, derived
  readonly inputs: readonly ItemStack[];
  readonly outputs: readonly ItemStack[];
  readonly ratePerMinute: number;
}
```

- **View models are frozen snapshots**, not live references. Handing the UI a
  live `Inventory` is the fastest way to end up with a UI that mutates the game.
- **Status must always explain a stall.** `'no_input'`, `'output_full'`,
  `'no_power'` — never a bare "idle". Pillar 3.

### Update budget

The world canvas renders every frame. The DOM does not.

| Element | Update rate |
|---|---|
| Inspector progress bars, live rates | 10 Hz |
| HUD counters (items, power, research) | 5 Hz |
| Build menu availability, tech tree | on change event only |
| Notifications | on event |
| Everything else | on open / on change |

Drive the throttled updates from one `setInterval`-free accumulator inside the
render loop, so the UI stops updating when the game is paused.

**Implementation note (C07).** Two accumulators, not one — `GameUI` runs a 5 Hz
`hud` lane and a 10 Hz `live` lane, both fed from the render loop and both
stopped while paused. Two consequences worth writing down:

- **The 10 Hz lane has a subscriber from the start.** This table names it for
  the inspector, which is C12's. Leaving it empty would be an abstraction with
  no implementation (rule 10), so it drove the thing in C07 that genuinely
  wants a sub-second timer: a toast counting down to its own removal. C12 put
  the inspector beside it, and added `selectionChanged` for the one thing the
  lane cannot do — open the panel on the frame of the click, and while paused.
- **A panel that must repaint while paused does it on an event.** The HUD is the
  only one: "paused" is what it has to say, and it cannot say it from a lane
  that pause has stopped. `pauseChanged` is that event, and it is why the word
  appears on a frame where both lanes are idle.

**Implementation note (C21A).** `InventoryPanel` is real, and it is the last
panel in the structure diagram above that had been listed and never built. It
follows this section's two rules the way `BuildMenu` does rather than the way
`Inspector` does: its grids are **fixed pools sized by the content table** — a
cell per registered item, a button per hand-craftable recipe — handed to
`mount()` in the first view. A cell whose count is zero is hidden, and the ore
that arrives a second later un-hides it; nothing is created or destroyed while
the game runs, which a `MutationObserver` in the tests asserts.

It rides the **5 Hz lane**, not the 10 Hz one, because what it shows is counts
and a queue — those change at the speed of a pick swing, not of a machine.
It also repaints **on the way open**, which is the same event-driven escape
the inspector uses for `selectionChanged`: a player who pauses to plan is
exactly the player who opens their bag, and both lanes are stopped then.

One thing it does that no other panel does: `InventoryView` carries the bag,
the craft options and the queue **in one snapshot**. They are one question
asked three ways and they have to agree — a craft button greyed out because
the bag is short, beside a bag row saying otherwise, would be two photographs
taken a frame apart.

**Implementation note (C22).** `ResearchPanel` is real, and it is the last
panel in the structure diagram above that had been listed and never built. It
follows `InventoryPanel`'s arrangement exactly — a card per technology and a
fixed pool of queue rows, both sized by the content table and handed to
`mount()` in the first view, with a `MutationObserver` in the tests asserting
that nothing is created or destroyed while the game runs — and it rides the
same 5 Hz lane, because what it shows is a unit count and a queue.

Two things about it are its own:

- **The tree is drawn as rows of tiers, not as a graph with edges.** Every
  technology carries `tier`, the longest path from a root, so a row per tier
  puts a node's prerequisites always in a row above it, and each card names
  them in words. Drawing the wires would mean absolute positioning and a
  second geometry to keep in step with a content table that is allowed to
  grow — for a tree five nodes deep. The chunk that makes the tree wide enough
  for the rows to stop reading is the chunk that earns an SVG.
- **A node whose prerequisite is merely *queued* is offered, not greyed.**
  `ResearchSystem.start` accepts one, because that is what makes the queue
  worth having; a panel that refused it would put the simulation's own rule
  out of reach of the UI. §7 lets a pre-check be stricter than the simulation
  nowhere — this is the pre-check agreeing with it exactly.

**Implementation note (C23).** `MapPanel` is the **eighth** panel, and the
first one §13's structure diagram above does not list — which is the honest
place for it, because the diagram is C07's list of what the UI was going to
need and a map was C23's idea of what C23 needed. It is also the only panel in
the game whose body is a `<canvas>`, for a reason that is about scale rather
than about taste: it draws a few hundred thousand cells, and a `<div>` each is
not a panel. Every other rule holds — it is handed a frozen view model, it
cannot reach the simulation, and it rides the 5 Hz lane with the bag and the
tech tree, because what it shows moves at the speed of a walk and of a radar
sweep.

Two things about it are its own:

- **Its colours come out of `tokens.css` at repaint**, through
  `getComputedStyle`, rather than out of a table. §4 forbids `ui/**` from
  importing `renderer/palette.ts`, and a third copy of §11's colours in `ui/`
  is exactly the duplication that stylesheet exists to prevent. The view model
  carries a **name** per cell — `'grass'`, `'iron'` — which is the §11 palette
  token `--if-<name>`, the one-word-three-uses arrangement
  `ResourceProperties.name` has documented since C09. A token that resolves to
  nothing falls back to a neutral grey rather than throwing, so the panel is
  still drawable and still clickable in a theme C30 has not written yet.
- **It stays usable without a 2D context.** Sizing the canvas and working out
  where the map sits on it happen *before* `getContext`, so a browser that has
  lost the context — or a headless test — gets a blank panel that still turns a
  click into the right tile. Drawing nothing is a blank map; forgetting the
  placement would be a map the player cannot use.

**A view model carries only what exists.** `HudView` had no research progress
from C07 to C22, because there was no research; a field that is always `null`
is a promise the view cannot keep, so the HUD drew the tile from §11's icon set
dimmed and the bar did not gain one in the middle later. C22 filled it in, and
the field is nullable for the *other* reason — nothing is queued — which is the
distinction `power` has drawn since C21. The tile is a button too: the tech
tree opens from the thing that says how research is going, exactly as the bag
opens from the thing that counts what is in it.

**C21 is what that looked like coming true.** `HudView.power` is nullable and
is *not* always null: it is null until the player's first pole, which is a real
state — there is no grid — rather than a system that does not exist. The tile
then reads the **worst** network's satisfaction, with supply, demand and the
network count in its tooltip, and takes the warning tone below 100%. The worst
rather than the total, because a factory-wide aggregate can read full while a
network on the far side of the map sits dark, and the one the player has to act
on is the short one. `MachineView.power` is the same rule one level down: null
for a building with no power role, and for one with a role it is what turns
`no_power` from a verdict into an explanation.

**Implementation note (C12).** The `MachineView` sketch above is not quite
what shipped, and the difference is this section's own rule about `HudView`
applied to machines: **a view model carries only what exists.** `progress` and
`ratePerMinute` are `number | null` — a chest is not 0% of the way through
something at 0 items a minute, it has no progress and no output, and a panel
handed zeroes draws a dead bar under every crate. The contents are
`MachineStack` rather than `ItemStack`, carrying a display name and a buffer
capacity, because §4 lets only the controller ask the item registry and because
"12/50" is what says `output_full` is coming before the machine stops.

**Implementation note (C11).** Two additions to the sketch above.

- **`status` gained `'no_resource'`**, and the union is no longer written out
  here or in the view: `game/entities/machine-status.ts` holds a numeric enum
  that machines store and a table of these names, and `MachineView['status']`
  is that table's type. Two hand-written lists of the same words is one list
  too many, and the one that drifts is the one the player reads.
- **"Systems emit events" is now real**, in the smallest form that has a
  producer and a consumer: `AlertLog`. A system records an `Alert` inside a
  tick, `GameController.pump()` collects it after the frame and emits a
  `'alert'` game event, and the toasts render it. C11's producer is a miner
  that has run out of ore; a machine that stops silently is the same bug as a
  command that fails silently (§7), one tick later.

Never write to the DOM inside a simulation phase. Systems emit events; the
controller batches them in `cleanup`; the UI consumes them at its own rate.

---

## §14 Persistence strategy

### The world-delta rule

A naive save serializes every generated world chunk. At 32×32 tiles, a
40×40-chunk world is 1.6 M tiles — tens of megabytes for a world that is 99%
exactly what the generator would produce anyway.

**Save the seed and the deltas.**

```text
persisted:      seed
                generator version
                per-world-chunk deltas:
                  - resource tiles whose remaining amount changed
                  - terrain tiles modified by the player (if ever mutable)
                set of world chunks the player has explored (for map/fog)
                all entities
                player, research, RNG position, tick

regenerated:    every unmodified terrain tile
                every untouched resource tile's initial amount
```

**Implementation note (C23).** The explored set is real, in
`game/world/explored.ts`, and it is a set of packed `chunkKey`s rather than a
flag on `WorldChunk`. A flag would be simpler and wrong in both directions:
reading a tile **generates** a world chunk, and the renderer reads every tile
it is about to draw, so a flag would be set by the act of looking at the map —
while a radar, which reveals ground nobody has visited, would have to generate
a hundred world chunks in order to mark them. Holding keys means revealing
ground costs one integer and brings no world chunk into existence.

`restore` validates every key it is handed, because this is one of the two
doors untrusted data comes through: a key outside the packable range would
alias a world chunk somewhere else entirely.

This keeps the reference factory's save inside the 2 MB budget and makes
`generatorVersion` a first-class concern: if worldgen changes, old saves must
either pin the old generator or be migrated. C27 handles this explicitly.

### Save file shape

```ts
interface SaveFile {
  readonly format: 'ironflow-save';
  readonly version: number;              // save schema version
  readonly metadata: SaveMetadata;       // name, createdAt, playtimeTicks, thumbnail?
  readonly state: SerializedGameState;
}
```

`version` is a plain integer, incremented on any breaking change to
`SerializedGameState`. Migrations are pure functions `vN -> vN+1`, chained, each
independently unit-tested against a stored fixture save (C27).

### Failure modes to handle explicitly

The previous revision did not mention any of these, and every one of them will
occur in the wild:

| Situation | Required behaviour |
|---|---|
| IndexedDB unavailable (private mode, blocked) | Detect at startup, tell the player clearly, keep the game playable with export/import only. Never crash, never silently lose a factory. |
| `QuotaExceededError` on save | Surface it, offer export-to-file, do not destroy the existing save by writing a truncated one. |
| Save written while a tick is in flight | Serialize only between ticks. The loop pauses during serialization. |
| Corrupt or truncated stored save | Validate on load; refuse and keep the corrupt blob for export rather than deleting it. |
| Imported file from a stranger | Full validation (C26). Never trust imported data. |
| Two tabs open on the same save | Detect via a BroadcastChannel lock; the second tab opens read-only or prompts. Do not let two tabs interleave writes. |
| Autosave | Every 3 minutes and on `visibilitychange` to hidden, into a rotating set of 3 autosave slots, never overwriting a manual save. |

---
---

# PART II — BUILD CHUNKS

Every chunk has the same shape. Do one at a time. The application must run at
the end of each.

```text
Goal            one sentence
Depends on      prior chunks
Deliverables    files created or changed
Tasks           the work
Acceptance      concrete, checkable criteria
Tests           what must be tested and where
Out of scope    what NOT to do here
```

Rule 10 of the previous revision required acceptance criteria for every chunk
and then supplied them for four. Every chunk below has them.

---

# Milestone A — Technical prototype

> **Result:** the player can pan and zoom around a large isometric world and
> place, rotate and remove buildings through a real UI.

---

## C00 — Project foundation & test harness

**Goal.** A runnable, strictly-typed, tested, lint-enforced skeleton with a
game loop drawing to a full-viewport canvas.

**Depends on.** Nothing.

**Deliverables.**
```text
package.json  tsconfig.json  vite.config.ts  vitest.config.ts  eslint.config.js
index.html  src/main.ts  src/styles/{tokens.css,main.css}
src/game/{game.ts,game-loop.ts,simulation.ts,simulation-clock.ts}
src/debug/debug-overlay.ts
tests/unit/game-loop.test.ts  tests/unit/no-dom-in-game.test.ts
```

**Tasks.**
1. `npm create vite@latest` — vanilla-ts template. Remove all template sample code.
2. `tsconfig.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`,
   `isolatedModules`, `target: ES2022`.
3. Install Vitest. Configure two projects: `node` environment for `game/**` tests,
   `jsdom` only for `ui/**` tests later.
4. ESLint with `no-restricted-imports` enforcing the §4 boundary table, and
   `no-restricted-globals` / `no-restricted-properties` banning `Math.random`,
   `Date.now`, `performance.now` inside `src/game/**` (§6 R1).
5. Scripts: `dev`, `build`, `preview`, `typecheck` (`tsc --noEmit`), `test`,
   `test:watch`, `lint`, `check` (typecheck + lint + test).
6. `index.html`: a single `<canvas id="game">` plus `<div id="ui">`. Full-viewport
   CSS reset, `overflow: hidden`, `touch-action: none`, dark background from tokens.
7. Canvas sizing that respects `devicePixelRatio` and a `ResizeObserver`.
8. `GameLoop` implementing §8 exactly, including `MAX_FRAME_MS`,
   `MAX_STEPS_PER_FRAME`, debt shedding and `visibilitychange` handling.
9. `Simulation` with a `tick()` that only increments `tickCount`, and a documented
   phase-order comment block matching §8.
10. `DebugOverlay`: FPS, tick count, ticks/frame, sim ms, render ms. Toggle with F3.
11. `main.ts` as the composition root — the only file that touches all layers.
12. `README.md`: how to run, the §4 dependency rules, the §6 determinism rules.

**Acceptance.**
- `npm run dev` serves a full-viewport dark canvas with a live debug overlay.
- `npm run build` succeeds with zero TypeScript errors.
- `npm run check` passes.
- The canvas is crisp on a HiDPI display and resizes without stretching.
- Tick count advances at 30/s ±1 over a 10-second observation.
- Backgrounding the tab for 60 s and returning does **not** produce a burst of
  catch-up ticks or a frozen frame.
- No runtime dependency other than Vite/Vitest/ESLint tooling.

**Tests.**
- `game-loop.test.ts`: with an injected fake clock — 100 ms of frames yields
  exactly 3 ticks; a 5-second frame yields exactly `MAX_STEPS_PER_FRAME` ticks and
  resets the accumulator; irregular frame times over 10 s yield the same tick
  count as regular ones.
- `no-dom-in-game.test.ts`: deletes `globalThis.document`, `globalThis.window`,
  `globalThis.HTMLCanvasElement`, then imports every module under `src/game/`.
  Must not throw. **This test runs from C00 to ship.**

**Out of scope.** World, entities, rendering beyond a cleared background, any
game content.

---

## C01 — Tile space, camera, isometric projection

**Goal.** One authoritative coordinate system and one authoritative transform.

**Depends on.** C00.

**Deliverables.**
```text
src/game/world/coordinates.ts    src/renderer/projection.ts
src/renderer/camera.ts           tests/unit/{coordinates,projection,camera}.test.ts
```

**Tasks.**
1. `coordinates.ts` — tile-space only, no pixels:
   ```ts
   export interface TileCoord { readonly x: number; readonly y: number; }
   export type Rotation = 0 | 1 | 2 | 3;              // N, E, S, W
   export const DIRECTION_OFFSETS: readonly TileCoord[];
   export function tileKey(x: number, y: number): number;   // packed, collision-free
   export function manhattan(a: TileCoord, b: TileCoord): number;
   export function rotateOffset(o: TileCoord, r: Rotation): TileCoord;
   ```
   `tileKey` packs two signed 16-bit coordinates into one number — used as the
   occupancy-map key. Document the coordinate range it supports (±32,768 tiles)
   and assert it in dev builds.
2. `projection.ts` — the §5 transform and nothing else. `TILE_W = 64`, `TILE_H = 32`.
3. `Camera`: `x`, `y` (tile-space, fractional), `zoom`. Methods `pan(dxPx, dyPx)`,
   `zoomAt(screenX, screenY, delta)`, `worldToScreen`, `screenToWorld`,
   `visibleTileBounds(viewportW, viewportH)`.
4. Cursor-anchored zoom: the tile under the cursor stays under the cursor.
5. Zoom clamped to `[0.25, 4]` in multiplicative steps; smooth-damped toward a
   target so the wheel feels good (renderer-side smoothing only — the camera is
   not simulation state).

**Acceptance.**
- Panning by dragging moves the world 1:1 with the cursor at every zoom level.
- Zooming at the cursor keeps the hovered tile pinned under the cursor within 1 px.
- `screenToTile(tileToScreen(t))` returns `t` for 10,000 random tiles at 5 zoom levels.
- `visibleTileBounds` never omits a tile that is partly on screen.
- No file outside `projection.ts` contains projection arithmetic (grep-checkable).

**Tests.** Round-trip property test; rotation-offset table test; `tileKey`
injectivity over the documented range including negatives; `zoomAt` invariant.

**Out of scope.** Drawing anything. Input handling (C04 wires the camera up).

**Implementation note (C01).** Four departures from the tasks above, each with a
reason:

1. **`tileKey` validates on every call, not only in dev builds.** Task 1 says
   "assert it in dev builds", but `game/**` may not import Vite (§4), so there
   is no build-mode flag to branch on and the honest choice is always or never.
   Always: an out-of-range or fractional coordinate does not throw, it collides
   with a *different* tile and corrupts the world silently. Four comparisons are
   noise next to the hash lookup they precede. §16 says profile before
   optimising, so gating this is C28's decision to make, not C01's.
2. **The packable range is `[-32768, 32767]`, not `±32,768`.** A signed 16-bit
   field is asymmetric. Exported as `TILE_MIN` / `TILE_MAX`; C02 should derive
   world-chunk limits from those constants rather than restate the number.
3. **The camera holds the viewport.** Task 3 writes
   `visibleTileBounds(viewportW, viewportH)`; the shipped camera takes
   `setViewport(w, h)` and `visibleTileBounds()` takes nothing. `zoomAt` and
   `screenToWorld` need the same two numbers, and four call sites each passing
   their own copy is four chances to pass a stale one after a resize.
   `CanvasSurface` already emits a resize notification and the camera is the one
   thing that needs to hear it.
4. **The zoom ease snaps on a derived threshold, not a constant.** An
   exponential ease never reaches its target, so it needs one; an arbitrary
   value is either a visible jump or a tail that keeps `isZooming()` true long
   after the motion has stopped. The camera snaps once the residual would move
   the furthest on-screen pixel less than half a pixel — `0.5 / viewport
   diagonal` in log-zoom space. On a 1080p viewport a wheel notch is visually
   finished in ~200 ms and formally settled in ~380 ms.

`Camera.screenToTile` was also added beyond the listed methods: it is
`floor(screenToWorld(...))`, it is the primitive the "hovered tile stays under
the cursor" criterion is stated in, and picking is unambiguously camera
business. It returns the **ground** tile; sprite-bounds picking is still C04
(§5 hazard 2).

**Amended by C02.** `TileBounds` was declared in `renderer/camera.ts` and now
lives in `game/world/coordinates.ts`, re-exported from the camera. It is a
tile-space value with no screen-space content, and `game/**` may not import
`renderer/**` (§4), so `World.forEachChunkInBounds` could not otherwise share
it. Two structurally identical declarations would let the renderer's cull
rectangle and the world's iteration rectangle drift apart on inclusivity
without producing a single type error.

**Noticed, not fixed.** `visibleTileBounds` returns the bounding box of a
rotated rectangle, so at minimum zoom on a 1080p screen it reports ~65,000 tiles
where ~32,000 are genuinely visible. That factor of two is inherent to returning
a rectangle and is correct-and-conservative, but C03 should not assume the
bounds are tight: either walk the diamond row by row or make per-tile work cheap
enough that 2x does not matter.

---

## C02 — World, world chunks, terrain

**Goal.** A sparse, unbounded world with lazily created 32×32 world chunks.

**Depends on.** C01.

**Deliverables.**
```text
src/game/world/{tile.ts,chunk.ts,world.ts}   tests/unit/world.test.ts
```

**Tasks.**
1. Tile types as a numeric enum: `Grass, Dirt, Sand, Stone, Water`. Water is
   impassable and unbuildable from the start — terrain that constrains layout is
   pillar 4.
2. ```ts
   const CHUNK_SIZE = 32;
   interface WorldChunk {
     readonly cx: number; readonly cy: number;
     readonly terrain: Uint8Array;        // CHUNK_SIZE^2
     readonly resource: Uint8Array;       // resource type id, 0 = none
     readonly resourceAmount: Uint16Array;// remaining
     dirty: boolean;                      // has diverged from generator output
   }
   ```
3. `World` with a `Map<number, WorldChunk>` keyed by packed chunk coordinate,
   lazy creation via an injected generator function, and `getTile`, `setTile`,
   `getResource`, `consumeResource`, `forEachChunkInBounds`.
4. Correct floor-division for negative coordinates — `Math.floor(x / 32)`, never
   `x / 32 | 0`, and `((x % 32) + 32) % 32` for the local index. This is the
   single most common bug in chunked worlds; unit-test it directly.
5. Mark a world chunk `dirty` the moment anything diverges from generator output.
   §14 depends on this flag.

**Acceptance.**
- Coordinates from −10,000 to +10,000 read and write correctly on both axes.
- World chunks are created only when touched; reading 1 tile creates exactly 1.
- A freshly generated world chunk has `dirty === false`; consuming one ore sets it.
- Memory for 1,600 world chunks stays under 20 MB.

**Tests.** Negative-coordinate indexing; lazy creation counting; dirty-flag
transitions; bounds iteration inclusivity.

**Out of scope.** Generation content (C19 — until then use a trivial checkerboard
or noise stub). Rendering.

**Implementation note (C02).** Six departures from the tasks above.

1. **`getResource` returns the resource *type*; `getResourceAmount` returns the
   remaining units.** Task 2 gives a world chunk two resource arrays and task 3
   names one accessor for them. Returning a `{type, amount}` object instead
   would allocate on a path the mining system hits every tick for every miner,
   so the accessor is split rather than boxed. `getResource` keeps the name of
   the field it reads.
2. **`setResource(x, y, type, amount)` exists**, though task 3 does not list it.
   `setTile` is listed and terrain is the *less* mutable of the two arrays; a
   resource layer writable only by the generator would have to be reopened by
   C09 and again by C24's save loader replaying deltas. It validates against the
   array widths, which is where a 70,000-unit patch would otherwise wrap to 4,464.
3. **Depletion leaves the resource type in place and drops the amount to zero.**
   The alternative — clearing the type at zero — makes a world-chunk delta lossy:
   §14 records changed *amounts*, and a restored zero would need a second field
   to say what kind of nothing it is. "Is this tile mineable?" is
   `getResourceAmount(x, y) > 0`, and that is the predicate C09's four ore-pile
   buckets and its "a depleted tile stops rendering" rule should be written
   against.
4. **`dirty` is set only on actual divergence.** Writing the terrain already
   present, or consuming zero, or consuming from an exhausted tile, changes
   nothing and dirties nothing. Task 5 says "the moment anything diverges", and
   a re-assertion is not a divergence — the looser reading would push the whole
   explored map into every save the first time any code re-asserted terrain in a
   loop.
5. **`peekChunk(cx, cy)` complements `getChunk`.** `getChunk` generates on first
   touch, which is the design; but the debug readout, the tests that count
   creations, and C24's serializer all need to ask what exists without bringing
   it into existence — a serializer that generated the explored map while trying
   to write it would be a memorably bad afternoon. **`forEachChunkInBounds`
   generates**, deliberately: viewport-driven lazy creation is how the map fills
   in, and C03 culling to `visibleTileBounds` is exactly the intended trigger.
6. **`world-generator.ts` ships now, with the checkerboard stub this chunk's
   "out of scope" note calls for.** It is already pure and positional in C19's
   sense, so C19 replaces a function rather than a contract. It outlines every
   world-chunk boundary in stone and anchors an 8-tile checkerboard to absolute
   coordinates, so the two things C02 must get right — no seams, and a negative
   half that is continuous rather than mirrored — are visible by eye the moment
   C03 draws anything. **C19 did replace it**, and the prediction held: the
   file's contents changed and `ChunkGenerator` did not. The checkerboard moved
   to `tests/fixtures/world-fixtures.ts`, where half the suite still wants a
   world it can state facts about.

`Simulation` now takes a `World` in its constructor and exposes it read-only,
per §4: every piece of authoritative state hangs off the simulation, and the
renderer and UI reach it through a view rather than holding their own reference.

**Noticed, not fixed.** C03 task 4 keys its terrain cache on `dirty`, but
`dirty` is a persistence flag (§14): it latches true on the first divergence and
never clears, so it answers "must this world chunk be saved?" and not "has this
world chunk changed since I last drew it?". C03 needs a separate signal — a
per-world-chunk revision counter, or cache invalidation at the mutation sites.
**Resolved in C03** with the former: `WorldChunk.revision`, bumped beside
`dirty` in `World.markChanged`. See the C03 implementation note.

---

## C03 — Canvas renderer & placeholder atlas

**Goal.** See the world. Isometric, depth-sorted, layered, and fast enough not
to matter yet.

**Depends on.** C01, C02.

**Deliverables.**
```text
src/renderer/{renderer.ts,canvas-renderer.ts,sprite-atlas.ts,render-state.ts}
src/renderer/layers/{terrain-layer.ts,entity-layer.ts,overlay-layer.ts}
```

**Tasks.**
1. ```ts
   export interface Renderer {
     resize(w: number, h: number, dpr: number): void;
     render(state: RenderState, camera: Camera, alpha: number): void;
     destroy(): void;
   }
   ```
2. `RenderState` is a **read-only view** of the simulation assembled by the
   controller — never the `Simulation` object itself.
3. ```ts
   export interface SpriteAtlas {
     draw(ctx: CanvasRenderingContext2D, id: SpriteId, sx: number, sy: number, zoom: number): void;
     readonly kind: 'procedural' | 'image';
   }
   ```
   Implement `ProceduralAtlas` per §11: flat diamonds for terrain, extruded
   prisms with a category colour and two-letter code for buildings, chevrons for
   belts. No image files.
4. **Terrain caching.** Pre-render each visible world chunk's terrain to an
   offscreen canvas keyed by `(cx, cy, zoomBucket)`; blit it. Invalidate on
   `dirty`. Cache at most ~64 world chunks, LRU. Without this, Canvas 2D
   fill-rate on 1,600 diamonds per frame becomes the first bottleneck.
5. Draw order: terrain layer → depth-sorted entity layer (§5) → overlay layer
   (hover, ghost, selection, alerts).
6. Cull to `camera.visibleTileBounds()` plus a margin equal to the tallest sprite.
7. `alpha` is available for interpolation but **must not be used for anything
   affecting simulation**.

**Acceptance.**
- The world renders as isometric diamonds with no seams at any zoom step.
- Panning at zoom 1 at 1080p holds 60 fps with terrain caching on.
- Entities render in correct front-to-back order; a building never draws over a
  building nearer the camera.
- Rendering nothing but terrain over a 1,600-world-chunk world costs < 4 ms/frame.
- `grep -r "getContext\|CanvasRenderingContext2D" src/game/` returns nothing.

**Tests.** Depth-key ordering is a total order and stable for equal `(x+y)`;
cache invalidation on dirty; cull-bounds include partially visible tiles.
Rendering output itself is verified by eye, not by test.

**Out of scope.** Sprites from image files, animation, lighting, WebGL.

**Implementation note (C03).** Ten departures from the tasks above.

1. **`WorldChunk.revision` was added to `game/`,** which is the fix C02's
   closing note asked for. `dirty` latches on the first divergence and never
   clears, so a cache keyed on it shows the world as it was at the *second*
   change, forever. `World.markChanged` now sets both flags at the one place
   every mutation already funnelled through, so a future mutation cannot set
   one and forget the other. It is never serialized, and nothing in `game/`
   reads it — a version stamp is the world's to issue and the renderer's to
   interpret.
2. **`renderer/palette.ts` exists, beyond the listed deliverables.** §11 says
   the renderer reads the design tokens "from a TS constant mirror" but does not
   say where that mirror lives, and three of the four new renderer files need
   it. `getComputedStyle` was the alternative and is worse: unavailable to a
   test, dependent on the stylesheet having loaded, and silently `''` when a
   token is renamed. `tests/unit/sprite-atlas.test.ts` parses `tokens.css` and
   fails on any disagreement in either direction, which is what makes the
   duplication safe.
3. **The atlas derives tile geometry from `tileToScreen`, not from `TILE_W`.**
   `tests/unit/projection-boundary.test.ts` invites exactly this file to import
   the constants and be added to its allow-list. Asking instead — the projection
   is linear, so `tileToScreen(1, 0)` and `tileToScreen(0, 1)` *are* its whole
   geometry — needs no exception at all, and the allow-list stays at one file.
   §5's rule is honoured more closely by not taking the exemption it offers.
4. **A `SpriteId` is a namespaced string, parsed once and memoised.** Task 3
   fixes `draw(ctx, id, sx, sy, zoom)`, which leaves the id as the only channel
   for anything else the sprite needs, so footprint and height ride on it:
   `building:power:PP:2x2:3`. That is how an image atlas addresses a cell
   anyway, so C29 maps the same strings rather than reintroducing parameters.
   An id that does not parse draws a magenta marker; a missing sprite is a
   content bug, and one that takes the frame down is a content bug you cannot
   see the rest of the screen to diagnose.
5. **`RenderEntity` has no `rotation` field.** Direction is part of the sprite
   id (`belt:1`), so a separate field would be a second source of truth for the
   same fact, and the one the atlas ignores.
6. **The terrain cache is bounded by pixels as well as entries.** "At most ~64
   world chunks" is the wrong bound alone: a world chunk's bitmap is 512x256 at
   minimum zoom and 2048x1024 at zoom 1, so 64 entries is 32 MB in one case and
   512 MB in the other. The count cap is kept as a coarse ceiling (96, since
   ~55 world chunks are genuinely visible at minimum zoom on a 1080p screen)
   with a 32M-pixel budget under it. Whichever binds first, binds.
7. **Above 8M pixels a world chunk is drawn directly rather than cached.** At
   zoom 2 a world-chunk bitmap is 4096x2048 and a 1080p viewport holds a quarter
   of one — 32 MB spent to avoid drawing the ~250 tiles actually on screen.
   Visible tile count scales with `1 / zoom^2`, which is why caching is
   necessary at the bottom of the zoom range and pointless at the top.
8. **At most eight bitmaps are built per frame**, with uncached world chunks
   drawn tile by tile *clipped to the visible bounds* in the meantime. Without
   the cap, arriving somewhere new at minimum zoom renders fifty-odd world
   chunks — 56,000 paths — in a single frame. With it, that cost is spread and
   the fallback is bounded by the viewport rather than by the 1,024 tiles a
   world chunk holds.
9. **The cull margin is a constant four tiles on all four sides**, not a
   per-sprite height. Task 6 says "a margin equal to the tallest sprite"; asking
   the atlas would mean a method on `SpriteAtlas` that only the culler uses, on
   an interface whose entire purpose is that C29 can replace the implementation
   — and a wrong answer from it is an invisible sprite, which is far harder to
   notice than a few extra tiles of work. §5 hazard 1 puts the tallest v1
   building at three tiles; four is that plus slack.
10. **`CanvasRenderer.resize` does not size the canvas.** `CanvasSurface`
    (C00) already owns the backing store and the device-pixel transform. The
    renderer keeps the numbers because clearing needs the extent and terrain
    blits need the ratio, but two owners of `canvas.width` is one too many.

**Two pieces of scaffolding ship with this chunk**, both marked in the source
and both deleted by the chunk that supersedes them. They are here because C03's
acceptance criteria are the first in the plan that must be *looked at*, and four
of the five cannot be looked at without them.

- **Temporary camera controls in `main.ts`** — pointer drag, wheel zoom, hover
  tracking. C04 owns input and replaces them. Moving the camera is not a
  command (§7): it changes no authoritative state, so nothing about the command
  pipeline is being pre-empted, and C00 already set the precedent of a direct
  listener in the composition root for F3. Without them "no seams at any zoom
  step" and "panning holds 60 fps" are criteria on a view that cannot move.
- **`debug/demo-entities.ts`** — eight hand-placed buildings and a belt, in the
  same spirit as C02's checkerboard generator. C05 and C06 delete it. The
  arrangement is chosen to break a naive sort rather than to look good: a
  diagonal of tall buildings, a 3x3 sharing a depth row with the belt running
  through it, and two buildings whose keys differ only in the entity id.

**Noticed, not fixed.**

- `EntityLayer` recomputes the depth key inside its sort comparator, so the key
  is computed `O(n log n)` times rather than `O(n)`. The fix — a parallel key
  array and an index sort — is a real optimisation with a real cost in clarity,
  and §16 says that decision belongs to C28's profiler.
- `visibleTileBounds` over-covers by up to a factor of two (C01's closing note),
  so `forEachChunkInBounds` generates roughly twice the world chunks strictly
  needed. At 4 KB per world chunk that is under a megabyte at minimum zoom, and
  the extras are almost always world chunks the player is about to pan into.
- Per-tile `worldToScreen` and `tileToScreen` calls each allocate a point.
  `projection.ts` already flags this as C29's to measure.

---

## C04 — Input & command pipeline

**Goal.** Browser events become validated commands. Nothing else.

**Depends on.** C01, C03.

**Deliverables.**
```text
src/input/{input-manager.ts,mouse-input.ts,keyboard-input.ts,keybindings.ts}
src/game/commands/{command.ts,command-processor.ts}
tests/unit/command-processor.test.ts
```

**Tasks.**
1. Define the full `Command` union from §7 up front, even for unimplemented
   commands — it is the contract between layers.
2. `CommandProcessor.enqueue(cmd)` / `drain(max)`. Validation lives with each
   system, dispatched from phase 1.
3. `InputManager`: pointer events (not mouse events — pen and touch for free),
   wheel with `ctrl` pinch-zoom detection, keyboard with a rebindable
   `keybindings.ts` map. Prevent context menu on the canvas.
4. Camera drag on middle-button or space-drag; left button is reserved for the
   game. Edge-scroll off by default.
5. Hover resolution: `screenToTile` for the ground tile, plus reverse-depth
   entity hit testing (§5 hazard 2).
6. Rejected commands produce a typed reason surfaced as a notification.

**Acceptance.**
- Hovering highlights exactly the tile under the cursor at every zoom level,
  including over tall buildings.
- Drag-panning and wheel-zoom feel smooth and are frame-rate independent.
- No DOM event handler mutates simulation state — every path goes through a command.
- A held-down build drag never enqueues more than 1024 commands per tick.
- Keybindings are data and can be remapped without touching handler code.

**Tests.** Command validation and rejection reasons; queue draining and the
per-tick cap; that a command object survives `structuredClone` (proving it is
plain data, which future replay and Web Worker support need).

**Out of scope.** Any command's actual effect. Touch gestures beyond pan/zoom.

**Implementation note (C04).** Nine departures from the tasks above.

1. **`renderer/picker.ts` exists, beyond the listed deliverables.** Task 5 asks
   for "reverse-depth entity hit testing", which needs to know how tall a
   sprite is drawn — and §4 forbids `input/**` from importing `renderer/**`.
   Putting the picker in the renderer, where sprite geometry already lives, and
   naming the interface in `input/` is the only arrangement that satisfies both.
   The alternative — teaching the input layer about rise units — would put a
   second copy of the sprite geometry one layer away from the first.
2. **The hit test is tile-space arithmetic, not polygon clipping.** A prism is
   its ground face swept up the screen, so a pixel is on it exactly when that
   pixel slid *down* the screen by somewhere between zero and the lift lands in
   the footprint — and sliding down the screen is a step along the `(1, 1)`
   tile diagonal. Picking is therefore a ray against an axis-aligned rectangle,
   which is exact at every zoom (both sides scale with it) and needs no
   projection arithmetic of its own. The surface the player sees is the **far**
   end of that ray, not the near one: §5 fixes that larger `x + y` draws in
   front, so larger is nearer the camera. Taking the near end looks correct on
   a 1x1 building and is silently wrong on every larger one — which is what the
   multi-tile test in `tests/unit/entity-picking.test.ts` caught.
3. **Validation is split in two, and only one half is C04's.** `command.ts`
   owns *shape* validation — integer tiles inside the packable range, positive
   amounts, non-empty registry ids — and it runs inside `enqueue`, so a
   malformed command never occupies a queue slot. §7's "validation lives with
   each system" is about the other half (`'occupied'`, `'unaffordable'`), which
   stays with the systems. The split is not tidiness: the input layer derives
   tile coordinates from floating-point screen arithmetic, and one `NaN` client
   coordinate would otherwise reach `tileKey`, which throws — turning a stray
   pointer event into a dead tick instead of a notification.
4. **`MAX_PENDING_COMMANDS` is a second cap, beyond §7's per-tick 1024.** The
   drain cap bounds a tick's work; it does not bound memory, and a producer
   faster than 1024 per tick grows the queue forever. Four ticks' worth is far
   past any real input burst, and overflow is a visible `'queue_full'`
   rejection rather than a silent drop. Recorded in §7's rules.
5. **`'not_implemented'` is a rejection reason, and left-click uses it.** C04
   ships the pipeline and none of the effects, so `Simulation.applyCommand`
   refuses everything with that reason. Left-click (and left-drag, one command
   per tile crossed) enqueues `mineTile`, which is what the left button does in
   this genre with no build tool held; C06 replaces it with the selected tool's
   command and C10 gives it an effect. Enqueuing it now is not implementing a
   future chunk — it is the only way to exercise input → command → tick →
   typed rejection → visible notice end to end, which is the whole chunk.
6. **Rejections are pulled, not pushed, and land in the F3 readout.** A
   callback from inside a tick into a toast would be a DOM write in a
   simulation phase, which §13 forbids; the processor records rejections and
   the composition root collects them after the frame. They are shown as a
   `reject` row rather than a toast because `ui/notifications.ts` is C07's
   deliverable and §19 rule 4 says not to build it early.
7. **`EntityId` is declared in `command.ts`.** §7's union names it and C05 owns
   it. C05 moves the declaration to `entities/entity.ts` and this file imports
   it from there; a chunk-shaped hole in the middle of the contract would be
   worse than one line that moves one chunk later.
8. **Edge-scrolling is not implemented at all**, rather than implemented and
   defaulted off — there is no options UI to turn it back on, and a setting
   nothing can reach is §19 rule 10 in miniature. Keyboard panning on the arrow
   keys was added instead, which is the same need with a control that exists.
   WASD is deliberately left unbound: it moves the *player* from C10, and a
   binding that has to be taken away later is worse than one never offered.
9. **Two files outside the chunk changed.** `eslint.config.js` gained the
   `src/input/**` boundary rule, because §4 says the dependency table "must be
   enforced" and the new layer was the only one with no rule behind it.
   `DebugOverlay.update` now takes a bag of label/value rows instead of
   positional strings: every chunk since C00 has added one, C04 adds two more,
   and an eighth positional string is a call site nobody can read.

**Noticed, not fixed.**

- `ScenePicker` scans the whole entity list per pick. That is the right shape
  at a pick a frame and the wrong one at §12's 20,000 entities; C06 gives the
  world an occupancy map and this becomes a lookup in the few tiles the ray
  crosses. No profile says it matters yet (§16).
- `RenderState.hover` is a single tile, so hovering a multi-tile building
  outlines the tile under the cursor rather than the whole footprint. The
  picker already knows which entity was hit; C06 is where the overlay gains a
  footprint to draw.
- Hover and selection are held by `InputManager` and read by the composition
  root. C07's `GameController` is where they belong once it exists.

---

## C05 — Entity store & the serializable entity shape

**Goal.** Stable ids, ordered iteration, and entity shapes that are already
serializable — so persistence in Milestone D is nearly free.

**Depends on.** C02.

**Deliverables.**
```text
src/game/entities/{entity.ts,entity-store.ts,entity-types.ts}
tests/unit/entity-store.test.ts
```

**Tasks.**
1. ```ts
   export type EntityId = number;
   export interface Entity {
     id: EntityId;
     type: EntityType;          // numeric enum
     x: number; y: number;      // top-left tile of the footprint
     rotation: Rotation;
   }
   ```
   Type-specific data lives in parallel interfaces (`MinerEntity extends Entity`,
   etc.) that remain **plain objects**. No classes, no methods, no getters, no
   `Map`/`Set` fields, no references to other entities — store `EntityId` instead.
   An entity must survive `structuredClone` and `JSON.parse(JSON.stringify(e))`
   unchanged. This is the whole trick that makes C24 cheap.
2. `EntityStore`:
   ```ts
   create<T>(init): T        get(id): Entity | undefined      has(id): boolean
   remove(id): void          forEach(fn): void                 // id-ordered, stable
   byType(type): readonly Entity[]                             // id-ordered
   at(x, y): Entity | undefined                                // occupancy lookup
   ```
   Backed by a dense id-ordered array plus a `Map` for id lookup and a
   `Map<tileKey, EntityId>` occupancy index. **Systems iterate the array**, never
   the maps (§6 R4).
3. Removal is deferred to the `cleanup` phase; `remove()` marks and queues.
4. Ids are monotonic and never reused (§6 R5). `nextEntityId` is serialized.
5. Multi-tile footprints register every occupied tile in the occupancy index.

**Acceptance.**
- 20,000 creates and 5,000 removes leave iteration order strictly id-ascending.
- `at()` is O(1) and correct for multi-tile buildings on every occupied tile.
- Removing an entity mid-tick does not change what other systems see that tick.
- Ids are never reused after removal.
- Every entity shape round-trips through `structuredClone` with `deepEqual`.

**Tests.** Iteration-order stability across interleaved create/remove; occupancy
correctness for 1×1, 2×2 and 3×2 footprints in all four rotations; deferred
removal semantics; the clone round-trip.

**Out of scope.** ECS. Component storage. Archetypes. Optimise after C28 says to.

**Decisions made while building this chunk.**

1. **Ids start at 1, and `0` means `NO_ENTITY`.** §6 R5 asks only that ids be
   monotonic and never reused; it says nothing about where they start. Giving
   up one id buys immunity from a whole family of bugs, because `if
   (belt.inputId)` reads correctly and silently skips entity 0. *Consequence
   outside this chunk:* `validateCommandShape` now rejects `entityId: 0` as
   malformed, where C04 accepted it. It shares `isEntityId` with the store, so
   the two can never disagree about what an id is.
2. **The five base entity fields are `readonly`.** `id`, `type`, `x`, `y` and
   `rotation` are the keys of the occupancy index. A system that assigned
   `entity.x = 5` would move a building and leave the index pointing at its old
   tiles — a corruption that surfaces much later as a building that cannot be
   removed standing on a tile that cannot be built on. Readonly means the only
   way to change one is through a store method that re-indexes; subtype fields
   (progress, buffers, item positions) stay mutable, which is what systems are
   for. C06 adds `setRotation` when the `rotate` command needs it; adding it
   here would have been §19 rule 4.
3. **Footprint size is not stored on the entity.** §10 puts content on the
   derived side: a miner is 2×2 because `data/buildings.ts` says so, and
   writing that into every miner would persist the same fact twenty thousand
   times and let a save disagree with the content it was made from. The store
   is instead constructed with a `FootprintLookup`, exactly as `World` is
   constructed with a `ChunkGenerator`, and C06's registry becomes its real
   implementation. Implementations must be **pure**: the store asks once at
   creation and again at removal, and a lookup that changed its mind between
   the two would free the wrong tiles.
4. **A rotated footprint keeps its north-west anchor and swaps its extent.** A
   3×2 at `(10, 4)` covers `x 10..12, y 4..5` facing north and `x 10..11,
   y 4..6` facing east. Rotating about the centre instead lands the corners of
   an even-by-odd footprint on half-tiles, and every rounding rule that fixes
   that is a rule the ghost preview, the occupancy index and the renderer must
   all agree on. This is C06 task 5's "footprint dimensions swap for odd
   rotations", stated as geometry; `forEachFootprintTile` takes loose
   coordinates so C06's ghost walks the same tiles the placement will claim.
5. **`create` asserts serializability on every entity.** The entity shape is
   what makes C24 cheap, and nothing about TypeScript stops a `Map` field from
   reaching a save. `assertSerializable` refuses `undefined` (dropped by
   `JSON.stringify`), non-finite numbers and `-0` (§6 R7), `Map`, `Set`, `Date`,
   typed arrays, class instances and reference cycles — every one of which
   survives `structuredClone` and is silently altered by a JSON round trip, so
   the save loads into a subtly different world. It runs always, for the same
   reason `tileKey` validates always: `game/` has no build-mode flag to branch
   on (§4), and the cost is a walk over an object that is being allocated
   anyway. C28's profiler is what would justify gating it (§16).
6. **`create` throws on an occupied tile** rather than returning `null`.
   Placement validation is C06's, and it tells the player `'occupied'` before
   ever calling the store; arriving here with a taken tile is a caller bug, and
   a store that quietly declined would leave a building the player paid for
   nowhere at all. Both the range check and the occupancy check run over the
   whole footprint before a single tile is claimed, so a rejected create leaves
   the store byte-identical — it does not even consume an id.
7. **`cleanup()` returns the removed ids; there is no event bus.** §8 phase 9
   says "process removals, compact stores, emit events", and an event system
   with one publisher and no subscribers would be §19 rule 10. An ascending
   array of ids is what C13's belts and C14's inserters will actually want.
8. **Deferred removal is a `Set` that is never iterated.** `remove()` marks;
   `cleanup()` walks the *dense array* and asks the set `has`, which keeps the
   removal list and the compaction both in id order without a sort (§6 R4).
   Which type buckets need compacting is tracked in a flag array indexed by
   `EntityType`, not a `Set` of types, so every loop in the file walks an array
   — a rule that can be checked by reading rather than by reasoning.
9. **`Simulation` takes the store as a constructor parameter**, defaulted, for
   the same reason it takes the world: the footprint source belongs to C06's
   registry, and until that exists whoever composes the game says where to ask.
   Phase 9 calls `cleanup()` and nothing else does.
10. **Two files outside the chunk changed.** `command.ts` now imports `EntityId`
    and `isEntityId` from `entities/entity.ts` and re-exports the type, which is
    the move C04's decision 7 promised. `coordinates.ts` gained `isRotation`,
    which `command.ts` had as a private copy and the store needed as a second
    one.

**The scaffolding shipped with C03 is now half real.** `debug/demo-entities.ts`
no longer builds render entities directly: it seeds the actual `EntityStore`,
and the renderer draws a view derived from it every frame. Only the two tables
in that file are still fake — the sizes (§15's building table) and the
placeholder looks, which is precisely what C06's `BuildingDefinition` replaces
when it deletes the file. The scene gained a 1×2 splitter turned east, so the
rotated-footprint rule is visible in the running game and not only in a test.

**Noticed, not fixed.**

- `byType` returns the store's own array rather than a copy. Systems call it
  every tick and copying twenty thousand belts per tick to guard against a
  caller that should not be writing is the wrong trade — but a caller that
  *retains* the array across a `cleanup` holds a compacted one. Documented on
  the method; C28 is where a cheaper guarantee would be measured.
- The composition root rebuilds the whole render-entity list every frame, one
  object per entity. Right for 26 demo entities, wrong for §12's 20,000; C07's
  `GameController` owns that derivation and C29 owns making it incremental.
- `ScenePicker` still scans the entity list per pick (C04 noticed it). The
  occupancy index that fixes it now exists, but the picker needs the *render*
  entity behind a tile, and that path belongs to C06 and C07.
- Nothing benchmarks the store. The 20,000-create test asserts ordering, not
  time; per-system tick cost against a committed baseline is C28's deliverable.

---

## C06 — Data-driven buildings & placement

**Goal.** Place, rotate and remove buildings from data definitions.

**Depends on.** C04, C05.

**Deliverables.**
```text
src/game/registries/building-registry.ts   src/game/data/buildings.ts
src/game/systems/build-system.ts           tests/unit/build-system.test.ts
```

**Tasks.**
1. ```ts
   export interface BuildingDefinition {
     readonly id: string;
     readonly name: string;
     readonly category: 'production' | 'logistics' | 'storage' | 'power';
     readonly size: { readonly width: number; readonly height: number };
     readonly rotationCount: 1 | 2 | 4;
     readonly buildCost: readonly ItemStack[];
     readonly placement: {
       readonly onTerrain: readonly TileType[];    // Water excluded by default
       readonly requiresResource?: boolean;        // miners
     };
     readonly sprite: SpriteId;
   }
   ```
2. `BuildingRegistry`: frozen at construction, `get(id)` throws on unknown id
   (a typo in content data must fail loudly and early, not produce `undefined`).
3. First buildings: **miner**, **chest**. That is enough to prove the system.
4. Placement pipeline: select → ghost preview follows the cursor → validate
   (bounds, occupancy, terrain, resource requirement, affordability) → place.
5. Rotation: `R` cycles; footprint dimensions swap for odd rotations.
6. Removal: right-click or a delete tool; refunds build cost to the player.
7. Ghost rendering: valid / invalid tint from the §11 tokens, drawn in the
   overlay layer so tall buildings never hide it.

**Acceptance.**
- Placing on an occupied tile, on water, or without resources is rejected with a
  distinct, visible reason.
- A 2×2 building placed at any rotation occupies exactly the right four tiles.
- Ghost preview is always visible, including over tall buildings.
- Removing a building frees every tile of its footprint and refunds its cost.
- Adding a new building to `data/buildings.ts` requires zero code changes elsewhere.

**Tests.** Validation matrix (occupied / water / no-resource / unaffordable /
out of bounds); footprint occupancy per rotation; place-remove-place idempotence;
cost deduction and refund.

**Out of scope.** Build time or construction animation — building is instant in
v1. Blueprints. Drag-to-build lines (add in C13 for belts, where it matters).

**Decisions made while building this chunk.**

1. **`BuildingDefinition` gained `entityType`.** Task 1 does not list it and
   something must carry it: entities store a numeric `EntityType` (C05) while
   commands, content and the UI name buildings by string id. The mapping lives
   on the definition so the two vocabularies meet in exactly one place, and the
   registry refuses two definitions that claim the same type.
2. **Six categories, not four.** The placeholder atlas (C03) already colours
   `extraction` and `research`, and §15 has buildings in both — a miner is not
   production and a lab is not storage. Two category vocabularies, one for the
   build menu and one for the colour, would be a table kept in step by hand.
3. **`sprite` is typed `string`, not `SpriteId`.** §4 forbids `game/` from
   importing `renderer/`, and the renderer's `SpriteId` *is* `string`. The
   field holds a name, not a picture; C29 changes the value, not the type.
4. **`placement.onTerrain` may only narrow `tile.ts`.** A definition listing
   water is refused at construction: "water is unbuildable" is a fact about the
   world (C02) and content data is not where it gets overruled. The shipped
   definitions use a list derived from `isBuildable`, so a terrain type added
   in C19 is buildable in one place.
5. **A rotation a building does not have is normalised, not rejected.** A chest
   asked to face south is stored facing north. Rejecting would add a reason no
   player could act on; normalising means a rotation outside `rotationCount`
   can never reach a save, where it would come back as a footprint nobody can
   explain. `R` cycles within `rotationCount`, so the ghost never shows one.
6. **Validation order is the order of the answers a player can use**, not the
   cheapest order: unknown building, bounds, occupancy, terrain, resource, and
   affordability **last**. Told that a tile is both water and unaffordable,
   "water" is what explains the red ghost; "you cannot afford it" would be just
   as true one tile to the left.
7. **The ghost asks the simulation, and gets the same answer the command will.**
   `Simulation.checkPlacement` is one read-only method rather than a public
   `BuildSystem`, because the UI may ask questions and may not apply effects
   (§7). It is what keeps a green ghost from being followed by a rejection.
8. **Four rejection reasons were added** — `unknown_building`, `bad_terrain`,
   `no_resource`, `nothing_there` — which is what §7's trailing `...` is for.
   Each is a distinct sentence a player could be shown, which is the chunk's
   first acceptance criterion.
9. **Right-click cancels the held building; it only demolishes an empty hand.**
   The click that cancels a misplaced ghost must never be the click that
   removes the building underneath it. Escape does both, and is the one key
   that always means "stop what you are doing".
10. **Left-drag places one building per tile crossed.** This is the path mining
    already used (C04) with its one-command-per-tile de-duplication, not the
    "drag-to-build lines" this chunk puts out of scope — that is C13's
    straight-line snapping for belts.
11. **`ItemCounts` is a placeholder for C08's `Inventory`.** The chunk's tests
    require cost deduction and refunds, and nothing holds items yet. It has no
    stack limits and no slots — those are precisely what C08 adds — and it
    lives in `game/items/item-stack.ts` beside `ItemStack`, which *is*
    permanent: it is how content names a quantity from here on.
12. **`Simulation` now takes an options object.** Four collaborators (world,
    registry, entity store, items) is past where positional parameters stay
    readable, and every one but the world has a default, so a test that cares
    about ticks still writes `new Simulation({ world })`.
13. **Build slots are content, not code.** `build.slot1`–`slot9` are bound to
    the number row, and the composition root resolves slot *n* against
    `data/buildings.ts`. Adding a building there gives it a hotkey, a ghost and
    a placement rule with no code change anywhere — the chunk's last acceptance
    criterion, expressed as a keymap. C07's build menu replaces the hotkeys and
    sets the same tool.
14. **A removed building holds its tiles until the tick ends.** C05 defers
    removal to the cleanup phase, so a `remove` and a `build` on the same tile
    in the same tick end with the build refused as `'occupied'`. That is the
    honest answer — the tile is not free until the tick that frees it has
    finished — and it is the same answer on every machine (§8). A second
    `remove` on the same tile in the same tick is `'nothing_there'` rather than
    a second refund.

**Scaffolding shipped with this chunk**, both marked in the source and both
deleted by the chunk that supersedes them.

- **`createPlaygroundGenerator`** — the checkerboard plus a pond and two ore
  patches near the origin. Three acceptance criteria are about *visible*
  rejections, and neither water nor ore existed in the world before this. The
  patches are stamped onto sand because C09 is what draws ore piles; until then
  the ground's colour is the only way to see where a miner may stand. C09
  replaces the patches and C19 replaces the generator.
- **A starting stock of 50 of every building**, granted in the composition
  root. Nothing produces items until C11 mines and C16 crafts, so without it
  the first acceptance criterion could not be met at all. C10 gives the player
  a real starting inventory.

`debug/demo-entities.ts` is **deleted**, as C03 and C05 said it would be: the
entities on screen are now placed by the player through the command pipeline.
The mapping from stored entity to drawable moved to `renderer/entity-view.ts`,
which C07's `GameController` takes over.

**Noticed, not fixed.**

- The composition root now holds the build tool's hotkey resolution, the ghost
  assembly and the render-entity derivation. All three are `GameController`'s
  by §4, and C07 is the chunk that creates it — moving them now would be
  building that file one chunk early.
- `ScenePicker` still scans the entity list per pick (noticed in C04, again in
  C05). The occupancy index could answer it directly now, but the picker needs
  the drawable behind a *pixel*, not the entity under a tile, and the ray it
  walks is the part that matters.
- The ghost is rebuilt and revalidated every frame, which runs the whole
  placement check at frame rate. It is a handful of tile lookups today; if it
  ever shows up in a profile it caches on (tile, rotation, tool).
- Placement does not consider the player's reach, because there is no player
  until C10. `'out_of_range'` currently means "off the edge of the packable
  world", and C10 is where it gains its second meaning.

---

## C07 — UI shell & HUD

**Goal.** Real DOM UI: toolbar, HUD, build menu, notifications — and the
`GameController` facade that keeps the UI out of the simulation.

**Depends on.** C06.

**Deliverables.**
```text
src/game/game-controller.ts   src/game/views/*.ts
src/ui/{ui.ts,toolbar.ts,hud.ts,build-menu.ts,notifications.ts}
src/styles/main.css
```

**Tasks.**
1. `GameController` — the single seam between UI and game:
   ```ts
   class GameController {
     dispatch(cmd: Command): CommandResult;
     getHudView(): HudView;
     getBuildingView(id: EntityId): MachineView | null;
     getBuildMenuView(): BuildMenuView;
     subscribe(event: GameEventType, fn: (e: GameEvent) => void): () => void;
   }
   ```
   Every returned view is a frozen snapshot (§13).
2. Build the DOM once per panel in `mount()`; update by assignment.
3. Toolbar with a 1–9 hotbar bound to building selection; `Esc` clears.
4. HUD showing the eight icons from §11 where relevant; tabular numerals.
5. Notification toasts, including every command rejection reason.
6. Throttled update loop per the §13 budget table, driven from the render loop.
7. CSS from `tokens.css`. Panels are `position: fixed`, never inside the canvas.

**Acceptance.**
- Selecting a building in the toolbar, placing it and removing it all work
  through commands only.
- No panel rebuilds its subtree on update (verify with a DOM mutation counter in
  a dev assertion).
- HUD updates at 5 Hz and the inspector at 10 Hz, both stopping when paused.
- `grep -r "simulation\." src/ui/` returns nothing.
- UI remains usable at 1280×720 and does not obscure the build cursor area.

**Tests.** jsdom tests for panel mount/update; controller returns frozen objects
(`Object.isFrozen`); a rejected command produces exactly one notification.

**Out of scope.** Inspector (C12), research panel (C22), save menu (C25).

**Decisions made while building this chunk.**

1. **`GameController` lives in `game/`, so it cannot assemble the render state.**
   C05 and C06 each noted that the composition root's render-entity derivation
   "belongs to C07's `GameController`". It does not, and §4 is why: a drawable
   names a `SpriteId`, and `game/**` may not import `renderer/**`. The
   derivation stayed in `renderer/entity-view.ts`. The two things that *did*
   move are the ones that were never about pixels — hotbar slot resolution and
   the placement preview — and the preview stops at a building id, which
   `main.ts` turns into a sprite. Those earlier notes were optimistic about
   which side of the boundary the work would land on; this is the answer, and
   it is the shape every later view model takes.
2. **The UI reads the held building through an interface the input layer
   satisfies by accident.** What the player is holding is presentation state
   owned by `InputManager` (C04): not serialized, read by no system, changing at
   pointer rate. The UI has to see it and §4 forbids `ui/**` from importing
   `input/**`, so the controller reads it through `BuildCursor` — four members
   that `InputManager` already had before this chunk existed, and still has
   never heard of. This is C04's `CameraControl`/`TilePicker` arrangement
   pointing the other way, and it is why not one line of `input/` changed.
   Nothing is cached: every view reads the cursor live, so a rotation pressed
   between two frames cannot leave the toolbar showing the wrong one.
3. **`dispatch` never returns the reason a command failed.** §7 puts validation
   inside the simulation, so the honest answer arrives a tick later. Both halves
   of that split — the malformed command the processor refuses at `enqueue`
   (C04 decision 3) and the occupied tile a system refuses in phase 1 — land in
   one rejection list and reach the UI as one `'rejected'` event. That is what
   makes "a rejected command produces exactly one notification" true for every
   reason in the vocabulary rather than for most of them, and `CommandResult` is
   therefore `{ queued: boolean }` and nothing more.
4. **Three event types, each with a real producer and a real consumer.**
   `'rejected'` feeds the toasts, `'buildMenuChanged'` feeds the toolbar and the
   menu, `'pauseChanged'` feeds the HUD. There is no fourth invented for a panel
   that does not exist (rule 10). `'buildMenuChanged'` needs something to notice
   the change, because §13 says that panel updates "on change event only": the
   controller compares a signature built from stock, affordability and
   selection — one pass over a table that ends at eleven entries (§15) — and a
   field added to `BuildMenuEntry` belongs in that signature too.
5. **`GameLoop` gained a pause.** Recorded in §8 above. It is C07's because the
   acceptance criterion "both stopping when paused" needs something to pause,
   and because a HUD with no pause button would be seven of §11's eight icons.
6. **`ui/icons.ts` is a ninth file beyond the deliverables**, because §11 asks
   for the eight icons "as inline SVG in `ui/`, one file, with `currentColor`"
   and that is a file. It holds a ninth glyph, `play`, which is the pause
   button's other face rather than a new icon: a toggle has to show what the
   next press does. Every icon is used — the HUD takes inventory, building,
   map, alert and pause; the build menu's category headings take resource,
   building, inventory, power and research.
7. **Power and research have tiles and no view-model fields.** See §13's note.
8. **A `MachineView` for a chest says `'idle'`, and §13 says never say that.**
   The rule is that a status must explain a stall — `'no_input'`, not a bare
   "idle" — and it is about machines that *could* run. Nothing in C07 can: no
   recipes, no buffers, no power. `'idle'` is the honest answer for a building
   that has nothing to do, and C11 gives miners `'running'` and `'output_full'`.
   The view exists now, without its panel, because task 1 names
   `getBuildingView(id)` and a facade with a hole in it is a facade C12 has to
   widen.
9. **`BuildMenuEntry.unlocked` is always true.** §13 lists "locked/unlocked" as
   part of what the build menu shows, and C22 is what makes it vary. The field
   and the dimmed style ship now so the menu gains a value rather than a whole
   visual state later.
10. **Two files outside the chunk changed, for the same reason C04's decision 9
    names.** `eslint.config.js` gained the `src/ui/**` boundary block, because
    §4 says the dependency table "must be enforced" and the new layer was the
    only one with no rule behind it. `input/keybindings.ts` gained `KeyB` and
    `KeyP` — an action with no handler is worse than no binding (its own file
    header), and C07 is the chunk that supplies both handlers.
11. **The F3 overlay lost its `reject` row.** C04 decision 6 put rejections
    there "because `ui/notifications.ts` is C07's deliverable". It is now, so
    they are toasts, and a second copy of the same information in a developer
    readout would be a second thing to keep in step.

**Noticed, not fixed.**

- Toasts do not expire while the game is paused, because the lane that ages them
  is one of the two pause stops. That is the deliberate reading — a message that
  expires behind a pause is a message the player never got to read — but it
  means a long pause accumulates up to five frozen toasts.
- `GameController.pump()` rebuilds the build-menu signature every frame. At two
  buildings it is nothing and at §15's eleven it is still nothing; if it ever
  shows up in a profile (§16) the registry gains a revision counter and the
  signature goes away.
- Ticks per second is measured by the HUD from two tick samples and its own wall
  clock, because §6 R1 leaves the simulation no clock to derive it from. It is
  therefore a 5 Hz estimate with 5 Hz granularity, which is right for a readout
  and would be wrong for anything C28 asserts against.
- The renderer still rebuilds the whole entity list every frame (noticed in
  C05). C07 did not change that, and did not move it: it is the renderer's, and
  C29 is where it becomes incremental.
- `ScenePicker` still scans the entity list per pick (C04, C05, C06). The
  controller now exists, and it still is not the answer — the picker needs the
  drawable behind a pixel, which is renderer geometry.

---

# Milestone B — First automation

> **Result:** iron ore is mined, carried, inserted and smelted without the
> player touching anything. This is the first genuinely playable build.

---

## C08 — Items & inventories

**Goal.** The item system every later system depends on.

**Depends on.** C05.

**Tasks.**
1. ```ts
   interface ItemDefinition {
     readonly id: string; readonly name: string;
     readonly stackSize: number; readonly sprite: SpriteId;
     readonly category: 'raw' | 'plate' | 'intermediate' | 'science';
   }
   ```
2. `ItemRegistry` assigns each item a **numeric runtime id** on registration.
   Inventories, belt items and saves store the numeric id; only content data and
   the UI use string ids. This keeps hot loops on integers and saves compact.
   The string↔number mapping is persisted so numeric ids survive a content
   reorder (§14 / C27).
3. ```ts
   class Inventory {
     add(item: ItemId, n: number): number;      // returns amount actually added
     remove(item: ItemId, n: number): number;   // returns amount actually removed
     count(item: ItemId): number;
     canAdd(item: ItemId, n: number): boolean;
     isEmpty(): boolean;
     toJSON(): SerializedInventory;             // plain, sorted by item id
   }
   ```
   Two variants: **slot-based** (chests, player — enforces stack limits and a
   slot count) and **buffer** (machine input/output — a small item→count map with
   a per-item cap). Do not use one for the other; a machine buffer with slot
   mechanics is where "why is my furnace stuck" bugs come from.
4. `add` and `remove` must be partial and honest — return what happened, never
   throw, never silently drop the remainder. Callers must handle the remainder.
5. Serialization sorts entries by numeric item id so saves are byte-stable (§6).

**First items.** `iron_ore, copper_ore, coal, stone, iron_plate, copper_plate`.

**Acceptance.**
- Stack limits are enforced; a partial add returns the amount added and leaves
  the inventory exactly full.
- Removing more than present removes what is there and reports it.
- `toJSON` output is identical for two inventories reaching the same contents by
  different paths.

**Tests.** Overflow, partial add/remove, stack boundaries, sorted serialization
stability, buffer-vs-slot semantics.

**Out of scope.** Filters, logistics requests, trash slots.

**Decisions taken while implementing this chunk.**

- **Runtime id `0` is `NO_ITEM`; real items start at 1.** Belt slots and
  inserter hands need a value meaning *empty* that fits in the same integer
  array as an item id, and a falsy valid id is the bug family `NO_ENTITY`
  exists to prevent (C05). One number is cheap.
- **New content is numbered above every id the saved mapping mentions**, not
  above the highest id still in use. A deleted item's number stays retired;
  reusing it would turn every stack of it in every old save into its
  replacement.
- **Contents are authoritative; slot *layout* is not.** A `SlotInventory` stores
  item→count and keeps items packed as tightly as their stack sizes allow, so
  it can never be full while holding two part-stacks of the same item, and two
  inventories holding the same things serialize identically however they got
  there — which is this chunk's third acceptance criterion, and would be false
  of a stored slot array. The cost is that the player cannot arrange their
  slots; §2 puts filters, sorting and trash slots out of v1, so there is
  nothing yet for an arrangement to be worth. The day a player *can* rearrange
  slots, the arrangement becomes authoritative state and this reverses.
- **Capacity is not serialized.** A slot count and a per-item cap are facts
  about the chest definition or the recipe — content, which §10 keeps out of
  saves. `fromJSON` is handed the capacity by whoever owns the inventory, and
  refuses contents that do not fit it.
- **`ItemDefinition.sprite` uses an `item:<id>` form** that the placeholder
  atlas does not draw yet. Nothing puts an item on screen until C12/C13, which
  is where the atlas learns the prefix (§11 grammar).

**Deviations.**

- **The player's bag is still C06's string-keyed `ItemCounts`.** `item-stack.ts`
  predicted that C08 would move it onto the real `Inventory`; it cannot. A
  build cost is paid in *building* items (`miner`, `chest`), and those become
  registered items only when C16 gives them recipes — a `SlotInventory` keys on
  numeric ids and asks the registry for a stack size, so it has nothing to say
  about them. Registering building items now would be implementing C16's
  content table early (§19 rule 4). C10 is where it moves onto the player.
  *(C16 was named here as the chunk that would merge the two and it is not:
  C16 adds `gear`, `copper_wire` and `circuit`, none of which is a building
  item. §15's building recipes are what forces the merge, and they are still
  unscheduled — C20's content pass is where they land.)*
- **`Simulation.items` is now the `ItemRegistry`**, parallel to
  `Simulation.buildings`, and the player's bag moved to `Simulation.inventory`.
  The registry is constructed in the simulation even though no system reads it
  yet, so that a typo in `data/items.ts` fails on the first frame rather than
  on the first ore (C09).
- **Six of §15's thirteen items ship.** The four raw resources C09–C11 mine and
  the two plates C15 smelts. An item nothing can produce or consume is a row no
  test can tell is wrong; the rest arrive with C16's and C22's recipes.

---

## C09 — Resource patches

**Goal.** Finite, depleting, visible resources.

**Depends on.** C02, C08.

**Tasks.**
1. Resources live in the world chunk's `resource` / `resourceAmount` typed arrays
   from C02 — **not** as entities. 20,000 ore tiles as entities would be absurd.
2. `world.consumeResource(x, y, n): number` returns the amount actually taken,
   decrements, marks the world chunk dirty, and clears the resource type at zero.
3. Rendering: tint the terrain diamond by resource type (§11 palette) and vary
   the ore-pile sprite by remaining amount in 4 buckets, so a depleting patch is
   readable at a glance without a number.
4. Stub generation until C19: a handful of hand-placed circular patches near the
   origin so mining can be built and tested.

**First resources.** `iron, copper, coal, stone`.

**Acceptance.**
- A patch depletes tile by tile and visibly thins as it does.
- A depleted tile stops producing and stops rendering an ore pile.
- Consuming from an empty tile returns 0 and changes nothing.
- Resource state survives being written and read back through the world chunk arrays.

**Tests.** Depletion arithmetic; the dirty flag; over-consumption clamping;
`resourceAmount` never goes negative or exceeds `Uint16` range.

**Out of scope.** Infinite patches, richness scaling, ore quality tiers.

**Decisions taken while implementing this chunk.**

- **`ResourceType` lives in `world/resource.ts`, not in `data/`.** It is the
  byte stored in `WorldChunk.resource` and persisted inside world-chunk deltas
  (§14), so it is storage vocabulary before it is content — the same thing
  `TileType` is, in the same directory, with the same "existing numbers may
  never be reassigned" rule. The file carries the two facts the table needs
  (`name`, `itemId`) rather than splitting a five-line properties table across
  `data/` and `world/`.
- **A resource's `name` is one word with three jobs**, exactly as
  `tileProperties.name` is: the §11 palette token (`--if-iron`), the sprite id
  the renderer builds (`resource:iron:2`), and the word a readout prints. There
  is no lookup table between a resource and its colour, and there is a test that
  fails if C19 adds a resource §11 never gave a tint.
- **`resourceItemId` ships unused.** C10 and C11 are its callers. A resource
  that does not say what it yields is an incomplete definition rather than a
  field held back, and a test checks every entry against `data/items.ts`, which
  is what keeps it from rotting before its callers arrive.
- **Fullness buckets are absolute, against `NOMINAL_RESOURCE_AMOUNT`**, not
  relative to what the tile started with. Relative would need a second
  `Uint16Array` per world chunk recording the original amount — 2 KB per world
  chunk and another field in every save — to answer a question only ever asked
  about a pixel. The cost: a tile richer than nominal sits in the fullest bucket
  until it drops below a full tile's worth. **C19 should revisit this** if patch
  richness ends up varying by more than about 2x; until then a patch is at most
  one full tile per square and the scale is exact.
  **Resolved in C19:** it does not. The generator's richest tile is capped at
  exactly two nominal tiles, and a test pins that, so the buckets stay as they
  are and the second array is never paid for. The only cost is that the richest
  patches in the world read as full until they are half mined.
- **Ore is drawn by the terrain layer, into the same cached bitmap.** A patch is
  not an entity (task 1), so it has no business in the entity layer, and caching
  it costs nothing extra: `consumeResource` bumps the world chunk's `revision`,
  which is already what invalidates a terrain bitmap, so a depleting patch
  redraws itself for free. Both draw paths — cached and direct — draw ore, since
  the direct path is the one used at high zoom, which is exactly when a player
  is looking at a patch.
- **Tint *and* piles, not one or the other.** The tint deepens with fullness and
  survives to the far end of the zoom-out range, where a lump is a fraction of a
  pixel and a patch has to read as a coloured region; the piles are what
  distinguish a half-mined tile from a full one up close. Task 3 asks for a
  patch legible "at a glance without a number" at every zoom, and neither cue
  does that alone.
- **`NOMINAL_RESOURCE_AMOUNT` is 500** — a thousand seconds of one miner at
  §15's 0.5 items/s, so a 2x2 miner on four full tiles runs about an hour before
  it must move. It is a balance number and belongs to C20's pass; it is named
  in one place so that pass is a one-line change.

**Deviations.**

- **Task 2's "clears the resource type at zero" is not implemented, and will
  not be.** C02 already built `consumeResource` and decided the opposite, with
  a reason that still holds: §14 stores changed amounts as a world-chunk delta,
  and a restored zero must not need a second field to say what kind of nothing
  it is. The type stays, the amount goes to zero, and "is this tile mineable?"
  is `getResourceAmount(x, y) > 0` everywhere. Every acceptance criterion in
  this chunk is met by that reading — a depleted tile produces nothing and draws
  no pile, because the *renderer* keys on the amount.
- **`NO_RESOURCE` was removed from `chunk.ts`** in favour of
  `ResourceType.None`. C02 needed a name for the byte before there was an enum
  to put it in; two names for zero is one more than the number of things zero
  means.
- **The playground generator's ore no longer stamps sand under itself.** C02's
  scaffolding used a terrain change to show where ore was, explicitly "because
  C09 is what draws ore piles". C09 draws them, so the stand-in went: a second
  cue would only hide whether the first one works. The patches themselves are
  now one per resource, with a linear falloff from centre to rim so that all
  four fullness buckets are on screen from the first frame — a wrong bucket
  boundary is then visible rather than inferred.
- **A hovered tile's resource was added to the debug overlay.** Not in the
  task list; C12's inspector is where it becomes player-facing. It is here
  because §20 asks for every acceptance criterion to be verified in the running
  application, and "the patch depleted on screen" is only half of that without
  the number behind it.

---

## C10 — Player character & manual gathering

**Goal.** Phase 1 of the progression narrative, which the previous revision
described but never scheduled.

**Depends on.** C06, C08, C09.

**Tasks.**
1. `PlayerState`: tile-space position (fractional, for smooth movement),
   `Inventory` (slot-based), facing, mining target, mining progress ticks.
2. `movePlayer` command; WASD held keys produce one command per tick with a
   direction vector. Movement is simulated, not interpolated in the renderer —
   the player's position is authoritative because build range depends on it.
3. Terrain collision: water and building footprints block movement.
4. `mineTile` command: hold left-click on a resource tile within reach
   (**6 tiles**) to mine at 0.5 items/s into the player inventory, with a
   progress ring in the overlay layer.
5. **Build range.** Placement requires the target within 8 tiles of the player.
   This is a real design decision: it makes the world physical and makes
   expansion mean travelling, which serves pillar 4. Make the range visible as a
   soft overlay circle while a building is selected.
6. Player sprite: three states from the reference sheet — idle, walk, work.
   Procedural placeholders in C10; real animation in C29.

**Acceptance.**
- The player walks with WASD, is blocked by water and buildings, and cannot walk
  off into an ungenerated void without world chunks generating.
- Manual mining fills the player inventory at the specified rate and stops when
  the inventory is full or the tile is depleted.
- Buildings cannot be placed outside build range, and the range is visible.
- Movement speed is identical at 30 fps and 144 fps.

**Tests.** Movement collision against water and multi-tile footprints; mining
rate in ticks; build-range validation; frame-rate independence of movement.

**Out of scope.** Player health, combat, equipment, inventory sorting.

**Decisions taken while implementing this chunk.**

- **Position is fixed-point, not a float.** §6 R3 forbids accumulating floats,
  and a walking player is the purest accumulator there is: `x += speed * dt`,
  thirty times a second, forever. §9 already sanctions fixed-point integers for
  belt item positions, and this takes the same bargain — the player's position
  is an integer count of **subtiles** and every step is an exact integer
  addition. No drift, no rounding that depends on where the player started, and
  a save that reloads bit-identical.
- **240 subtiles per tile, because 240 / TPS is exactly 8.** Any speed that is a
  whole number of eighths of a tile per second is then an exact integer number
  of subtiles per tick. A power of two would make 30 ticks per second a
  repeating fraction and the step would have to be rounded, which is the float
  problem again wearing a hat. The walking speed is **4 tiles/s** — 32 subtiles
  per tick — and the diagonal step is `round(32 / sqrt(2)) = 23`, so a diagonal
  covers the same ground per second as a cardinal one. The rounding leaves a
  diagonal 1.6% fast, which is invisible and, more to the point, *the same 1.6%
  on every machine*: computing the true length per step would put a square root
  on the movement path, and `Math.hypot` is not required to be correctly
  rounded (§6 R1).
- **WASD is named for the screen, and the camera translates.** The keys are a
  direction on the *picture*, a `movePlayer` command carries tile space, and §5
  forbids the input layer from owning the projection — so `InputManager` asks
  the camera, exactly as it already asks the picker what is under a pixel.
  `Camera.screenDirectionToWorld` is that question. Because the projection
  turns the grid 45°, **W alone is a diagonal tile move and W+D is a cardinal
  one**, and the quantisation to the nearest of the eight tile directions is a
  threshold on the scaled components (`tan 22.5°`), not a sign test — a sign
  test calls screen-up-right "north-west".
- **Build reach lives on the simulation, not in `BuildSystem`.** "May a
  building stand on this tile?" is a property of terrain, occupancy and cost,
  and it is the same question C11's miner asks about itself, which has no arms.
  "Can *the player* reach it?" is a property of the player.
  `Simulation.checkPlacement` composes the two, so the ghost and the command
  still ask one question, and `BuildSystem` keeps no dependency on where anyone
  is standing. Reach is measured to the **nearest tile of the footprint**, so a
  2x2 miner is not refused for a far corner a tile past a circle the player can
  see drawn around themselves, and it is checked **first**, because it is the
  answer the player can act on by walking.
- **`out_of_reach` is its own rejection reason.** `command.ts` predicted that
  C10 would reuse `out_of_range`; it does not. "That is outside the world" and
  "walk closer" are different instructions, and collapsing them would leave the
  most common rejection in the game explained by a sentence about the edge of
  the map (§7, pillar 3). `inventory_full` was added for the same reason.
- **The player carries two containers for one more chunk.** A `SlotInventory`
  of real items and the C06 `ItemCounts` bag of building materials. That is not
  a design, it is C08's recorded deviation arriving on schedule: a build cost is
  paid in `miner` and `chest`, which are not registered items until something
  gives them recipes. `Simulation.inventory` is now an alias for the bag on the
  player, so the one name survives the move. *(C16 was named here as the chunk
  that merges them; it did not — see C08's note above and C16's deviations.)*
- **A player standing somewhere invalid may move anywhere.** Three lines against
  a soft-lock: a building placed on top of the player, or a save whose terrain
  changed, would otherwise refuse every candidate position forever. Movement
  also resolves one axis at a time, so walking diagonally into a wall slides
  along it rather than stopping dead.
- **Collision generates the world.** `World.getTile` creates a world chunk on a
  miss, so the collision test is what pulls the map into existence ahead of the
  player — which is the acceptance criterion about the ungenerated void, met by
  construction rather than by a separate check.
- **Mining progress is discarded when it stops, not banked.** Half a lump of
  iron is not something the player can be given, and keeping it would make
  walking away and back a way to mine in instalments that no readout can
  explain. The stop conditions are checked *before* progress is added, so a
  player who fills their bag stops that tick rather than one item later.
- **The player is drawn into the depth-sorted pass but kept out of
  `RenderState.entities`.** Sorted in, so walking behind a miner puts the miner
  in front (§5); out of that array, because it is also what `ScenePicker`
  searches, and a player in there would answer for every pixel of their own
  sprite — reporting their own tile instead of the ground behind them, and an
  `entityId` of `NO_ENTITY`, which means "nothing" everywhere else. The depth
  key takes the player's fractional position without complaint: it is
  arithmetic, not an index.
- **Every balance number is named once.** Walking speed, bag size (30 slots),
  the starting stock and both ranges belong to C20's tuning pass, and each is a
  single named constant so that pass is a one-line change.

**Deviations.**

- **`stopMining` was added to §7's command union**, and `movePlayer` now sets a
  *persistent direction* rather than moving one step. Both are recorded in §7
  with the reasoning; the short version is that a command stream arrives at
  frame rate and the acceptance criterion is about tick rate.
- **Task 2's "one command per tick" is not what the input layer does**, because
  it cannot: it runs at frame rate and has no way to see a tick boundary. It
  sends the walk vector **when it changes**, and the simulation steps once per
  tick. That is the same intent and it is the version that is actually
  frame-rate independent.
- **A follow camera was added, which is not in the task list.** A 50% deadzone,
  in the composition root, panning only when the player leaves it. C10 is the
  chunk that first lets the player walk out of the viewport, and a game where
  the character can be lost off-screen with no way to find them is not one the
  acceptance criteria can be checked in. It is presentation only — it pans the
  camera, which §6 already permits to smooth against wall-clock time — and it
  is deliberately not a follow-cam: inside the box the camera does not move, so
  the arrow keys still put the view where the player wants it.
- **C06's "fifty of everything" starting stock is gone**, as `main.ts` predicted.
  The player now starts with 5 miners and 10 chests at tile (6, 6), which is on
  grass and within build range of the playground's iron patch but a walk away
  from its copper — so expansion means travelling from the first minute, which
  is what task 5 is for.
- **No inventory panel.** §13 lists one and C10 does not schedule it; the HUD's
  ITEMS tile counts what the player carries, both containers, and the debug
  overlay prints position, facing, bag usage and mining progress. C12's
  inspector is where this becomes a real panel. **It was not**: C12 built the
  panel for *machines* and the player's own bag kept its single total for
  another nine chunks. **C21A is the chunk that built it**, and the HUD tile
  this note describes is now the way in.

---

## C11 — Miner

**Goal.** The first machine that works while the player does not.

**Depends on.** C09, C10.

**Tasks.**
1. `MinerEntity`: `resourceType`, `progressTicks`, output buffer (capacity ~50),
   `status`. Footprint 2×2 (matching the reference sheet's rig), mining every
   resource tile under its footprint, round-robin by tile index for determinism.
2. `mining-system.ts`, phase 3. Rate: **0.5 items/s** at tier 1 (60 ticks/item).
3. Output goes to the internal buffer. When the buffer is full the miner's status
   becomes `output_full` and it stops — **backpressure from day one**.
4. Miner placement requires at least one resource tile under the footprint, and
   the ghost preview shows how many tiles it will cover.
5. Depletion: when every covered tile is empty, status becomes `no_resource` and
   an alert fires. A miner that silently stops is a bad game.

**Acceptance.**
- A miner on iron produces exactly 30 ore in 60 simulated seconds.
- Rate is unchanged at 10 fps and at 144 fps.
- A full miner stops and reports `output_full`; emptying it resumes production.
- A miner over a depleted patch reports `no_resource` and raises one alert, not one per tick.

**Tests.** Exact tick-count production; multi-tile round-robin determinism;
buffer-full stall and resume; depletion transition.

**Out of scope.** Power (C21), speed modules, mining productivity research.

**Decisions taken while implementing this chunk.**

- **What makes a building a miner is content, not an id.** `BuildingDefinition`
  gained an optional `mining: { itemsPerSecond, bufferCapacity }`, and its
  *presence* is the only test anything performs: `building-init.ts` branches on
  it, `MiningSystem` asks the registry for it, and there is still no
  `if (id === 'miner')` anywhere (§19 rule 17). C22's tier 2 is a table entry,
  and so would an electric miner be — C21 did not ship one, for a reason about
  content rather than code; see §15. The rate is authored in items per second —
  the unit §15's whole balance table is written in — and converted to
  `ticksPerItem` **once, at registry-build time**, exactly as §6 R3 requires.
- **`entities/building-init.ts` is a third job.** C05's store takes whatever
  fields it is given and C06's build system decides whether a building may
  stand somewhere; neither knows a miner has a progress counter, and neither
  should. Turning a definition into the initial state of one instance is its
  own small file, and it is where C13's belts and C15's furnaces add a line.
- **The output buffer is a count, not a `BufferInventory`.** C08's containers
  are classes, and an entity is plain data that must survive
  `JSON.stringify` (C05) — so a buffer object cannot go on one. A miner holds
  exactly one kind of item, so an item id beside the count would be a second
  copy of `resourceType`: `resourceItemId(miner.resourceType)` *is* what is in
  the buffer, always. That is an invariant rather than a coincidence, and it is
  what forces the adoption rule below.
- **A miner adopts its resource on its first tick, not at placement**, and may
  adopt a different ore under the same footprint — **but only while its buffer
  is empty**. One place decides what a miner may mine, so the ghost and the
  machine cannot disagree; and because the buffer names no item, switching with
  ore still inside would silently transmute it. A miner on a mixed patch
  therefore works the iron out, reports `no_resource` until something empties
  it (C14), and then takes up the copper.
- **`MachineStatus` is a numeric enum, complete on day one**, in
  `entities/machine-status.ts`. Numeric for the reason `EntityType` is: it is
  written into every machine in the save and compared once per machine per
  tick, so existing numbers may never be reassigned. Complete because a type
  that grows a member per chunk is one every save migration has to re-learn —
  C11 uses four of the seven. C07's hand-written string union in
  `views/building-view.ts` is now an alias for the same table's names, which is
  also where `'no_resource'` — a status §13 never listed — came from.
- **Status is stored although it is derivable.** §10 would normally call it
  derived, and it is recomputed from scratch every tick; what cannot be
  recomputed is the *transition*, and the transition is what task 5 asks for —
  one alert when a miner runs dry, not one per tick. Recomputing it every tick
  is also what keeps a loaded save honest, whatever was written into it.
- **Progress is kept through `output_full` and discarded on `no_resource`.**
  The asymmetry is deliberate and is the chunk's least obvious decision. C14's
  inserter empties a buffer a few ticks after it fills, so a miner that reset
  its progress on every stall would sit at a full buffer producing nothing —
  a miner that works alone and stops the moment it is automated. A miner with
  no ore left, by contrast, has nothing to be partway through, which is the
  answer C10 already gave for the player's manual mining.
- **Alerts are split across two files, and the split is §4.** `Alert` is a view
  model and lives in `game/views/alert.ts`, because the UI renders it and §4
  lets the UI import a view model and nothing else — the boundary test in
  `tests/unit/ui-boundary.test.ts` is what makes that concrete. `AlertLog` is
  the mutable queue a system writes to inside a tick, so it lives in
  `game/alerts.ts` and the UI never sees it. The same split §7 already makes
  between `CommandRejection` and the processor that records one.
- **`footprintTileAt` and `footprintTileCount` were added to `entity.ts`.**
  Random access into exactly the row-major order `forEachFootprintTile` walks,
  so the round-robin cursor cannot address tiles in an order nothing else in
  the game can predict — and so a miner does not allocate an array of four
  coordinates per tick inside a simulation phase (§16). A test asserts the two
  orders agree at every rotation.
- **Every balance number is named once**, as in C10: `itemsPerSecond` and
  `bufferCapacity` are content in `data/buildings.ts`, so C20's pass is a
  one-line change and no existing save carries the old rate.

**Deviations.**

- **Task 1's "mining every resource tile under its footprint" is narrower than
  it reads.** A miner mines every covered tile of *its own* `resourceType`,
  round-robin by tile index. The field is in the task list, and a buffer that
  mixed two ores could not say what was in it — see the adoption decision above.
- **The ghost's count is `n/m ore`, and it is a `PlacementView` field.** Task 4
  asks the preview to show how many tiles it will cover;
  `PlacementView.resourceTiles` is that number, `null` for a building that does
  not mine, because a chest covering no ore is not a chest that will produce
  nothing. The simulation answers it with the same `countResourceTiles` the
  placement rule uses, so a green ghost cannot promise four tiles over a patch
  with three. The label is drawn at a **fixed pixel size**, like C10's mining
  ring and for the same reason, anchored on the footprint's north corner — tile
  point `(x, y)`, asked of the camera rather than derived from tile dimensions
  (§5).
- **C12's `MachineView` is filled in early, except the rate.** Status, progress
  and the output stack exist as authoritative state the moment C11 lands, and
  the acceptance criterion "reports `output_full`" wants a path to the player.
  `ratePerMinute` stays 0: C12 measures it as a rolling average over 300 ticks,
  and a number nobody has measured should not look measured.
- **A `machine` row was added to the debug overlay.** Not in the task list, and
  the same reasoning as C09's ore row and C10's player row: §20 asks for every
  acceptance criterion to be verified in the running application, and "the
  miner stalled on screen" is only half of that without the status behind it.
  C12's inspector is where it becomes player-facing.
- **The HUD's alert tile now counts alerts as well as rejections.** It counted
  rejections because they were the only thing there was to count; from the
  player's side both are the same event — the game had to tell them something
  was wrong.

---

## C12 — Inspector & view models

**Goal.** The player can always see *why* a machine is not running (pillar 3).

**Depends on.** C07, C11.

**Tasks.**
1. `Inspector` panel showing name, status, progress bar, input/output contents,
   and a live rate in items/minute.
2. Rate is measured as a **derived** rolling average over the last 300 ticks
   (10 s), stored in the controller's derived state, never persisted.
3. Status strings come from the machine's enumerated status, mapped to
   player-facing text with a colour from the §11 status tokens.
4. Click to select, click empty ground or `Esc` to deselect. Selection is UI
   state, not simulation state.
5. Manual interaction: take from and insert into a selected machine's buffers via
   `takeItems` / `insertItems` commands.

**Acceptance.**
- Clicking any entity opens the inspector within one frame with correct data.
- A stalled machine always shows a specific reason, never a bare "idle".
- The panel updates at 10 Hz, not every tick, and does not rebuild its DOM.
- The inspector cannot mutate simulation state except via commands.

**Tests.** View-model construction for each status; rate-average correctness over
a known production sequence; frozen view models.

**Out of scope.** Recipe selection UI (C16), graphs, production statistics screen.

**Decisions taken while implementing this chunk.**

- **The rolling rate needs a monotone counter, and it lives beside the
  simulation rather than on the entity.** Task 2 puts the average in the
  controller's derived state, and an average over a window needs to know what a
  machine's output total *was* 300 ticks ago. `production.ts` holds both
  halves: `ProductionCounters`, which `MiningSystem` increments where an item
  is produced, and `ProductionRate`, the controller's window over it. Counting
  production rather than sampling the buffer is the load-bearing part — a
  buffer goes *down* when something empties it, and a rate measured from a
  number that falls reads as negative production the moment C14's inserter
  arrives. Neither half is authoritative state: the counter is the same third
  thing `AlertLog` is (§10), a measurement the simulation writes and never
  reads back, so it is not in the save and a loaded world simply fills its
  window over the next ten seconds. Keeping it off `MinerEntity` is what makes
  that true by construction — a `producedTotal` field would be written into
  every save by C24 and migrated forever for a number the player looks at for a
  few seconds.
- **The window is measured per *selected* machine, not per machine.** One
  window, reset when the selection changes. §12's reference factory has 2,500
  machines and the inspector shows one; 2,500 windows kept current so that one
  could be read is work with no reader. `perMinuteFor(id)` therefore answers 0
  for any machine but the selected one, which is the honest answer — a figure
  borrowed from a different miner is worse than no figure.
- **A short window reads over the history it has.** Samples arrive at frame
  rate, kept one per tick, so a window opened two seconds ago spans two
  seconds. The alternative — report 0 until 300 ticks have passed — is a panel
  telling the player that a visibly running machine produces nothing, which is
  the bug pillar 3 exists to prevent.
- **Selection moved from a tile to an entity, and the highlight to a
  footprint.** `InputManager` held a `selectedTile` from C04; the inspector
  wants a machine, so it now holds the picker's `entityId` — which makes "click
  empty ground to deselect" fall out of the pick rather than being a second
  rule. `RenderState.selected` became a rectangle, because a 2x2 miner clicked
  on its north corner and outlined one tile wide reads as a highlight that
  missed. `GameController.getSelectionView()` supplies it from the same
  `footprintExtent` the ghost uses.
- **`BuildCursor` is now `Cursor`.** The interface the controller declares for
  `InputManager` to satisfy gained `selectedEntityId` and `setSelectedEntity`,
  at which point a name about building was wrong. Selection is the same kind of
  thing the other members are: presentation state, pointer-rate, never
  serialized, read by no system.
- **`selectionChanged` is a game event, so the panel opens on the frame of the
  click.** The inspector otherwise lives on §13's 10 Hz lane, which would put
  up to a tenth of a second between the click and the panel and would show
  nothing at all while paused — and reading a machine is exactly what a player
  pauses to do. The controller notices the change in `pump()`, the same place
  it notices a build-menu change, and the same place it drops a selection whose
  machine has been demolished.
- **Clicking a machine inspects it and does not mine the ground under it.** A
  miner always stands on ore, so without this every click on one would also
  start digging the tile it is standing on. `actOnTile` skips a tile with an
  entity on it when the hand is empty.
- **The panel's stack rows are a fixed pool.** §13 forbids rebuilding a
  subtree, and a buffer with a varying number of lines is the shape that tempts
  a panel into `innerHTML = ''`. Four rows per section, built at mount and
  hidden when unused; C16 is the chunk that could produce a machine with more
  ingredients than that, and it is the chunk that would raise the number.
  *(C16's widest recipe takes two, and §15's widest ever takes three, so four
  stands. What C16 did add is the recipe picker, which is **not** a fixed pool:
  how many choices a machine has is a property of the machine rather than of
  what is happening inside it, so the grid is rebuilt when the choices change
  and never on a repaint.)*
- **Manual transfer is its own system, `systems/hand-system.ts`.** The exact
  parallel of `BuildSystem`: it owns one pair of commands end to end, including
  their refusals, and C15's furnace adds an arm there rather than widening the
  orchestration. It is not C14's inserter — that is a building, it runs every
  tick in phase 6, and it has no opinion about where the player is standing.
  What counts as a buffer is content (`definition.mining`), never an id (§19
  rule 17).
- **Reach for taking is the mining range, six tiles, not the build range.**
  These are the player's arms, and the arms that swing a pick and the hand that
  reaches into a hopper ought to reach the same distance. Measured to the
  nearest footprint tile, exactly as build reach is.
- **Three new rejection reasons**, each with a sentence in `notifications.ts`:
  `'unknown_entity'` (the machine was demolished between the frame that drew
  the button and the tick that read the click — reachable without anyone doing
  anything wrong), `'nothing_to_take'` and `'not_accepted'`.

**Deviations.**

- **`insertItems` is validated but nothing accepts items yet, and the panel has
  no insert control.** Task 5 names both directions. A miner's buffer is an
  *output*, and a chest has no inventory — how a plain-data entity (C05) holds
  one is a decision C13 has to make anyway, since its acceptance criterion is
  "the chest fills", and making it here would be implementing C13 in advance
  (§19 rule 4). So the command's arm is real and its refusal is the answer that
  stays true for a miner forever ("that machine does not take items"), the
  view's `inputs` is an empty list, and the INPUT section hides itself. **C15's
  furnace is the first machine with somewhere to put an ingredient**, and it
  fills in `HandSystem.insert` and gives the input rows their button. Taking is
  fully real, and it is what finally gives C11's "emptying it resumes
  production" a way for a player to do it.
- **`MachineView.progress` and `ratePerMinute` are nullable, and the stacks are
  richer than `ItemStack`.** §13's sketch gives plain numbers and bare stacks.
  The reason is §13's own note about `HudView`: a view model carries only what
  exists. A chest is not a machine that is 0% of the way through something at 0
  items a minute — it has no progress and no output, and a panel handed zeroes
  cannot tell those apart, so it draws a dead bar and a dead number under every
  crate in the factory. `MachineStack` adds `name` and `capacity` because only
  the controller may ask the item registry (§4) and because "12/50" is the
  number that says `output_full` is coming, which is what pillar 3 wants on
  screen *before* the miner stops.
- **`'idle'` reads "Nothing to do".** C07's decision 8 settled that a chest is
  honestly idle and that this chunk's "never a bare idle" is about machines
  that *could* run. The panel says so in words rather than showing the enum's
  name, which is the same sentence with nothing bare about it.
- **The `machine` row left the F3 overlay.** C11 added it saying the inspector
  was where it became player-facing. It is, and a second copy of the same
  information in a developer readout is a second thing to keep in step — the
  same reasoning that retired C04's `reject` row in C07. The `ore` and `player`
  rows stay: one is about the world and one about the player, and the inspector
  answers for neither.
- **The F3 overlay moved right.** It sat at the top-left corner, which is where
  the inspector now lives. One CSS line, on a panel only a developer sees.

**Noticed, not fixed.**

- The rate window holds up to 301 samples in two arrays and drops the oldest
  with `shift()`, which is O(n) on a 301-element array once per tick for one
  machine. It is nothing, and a ring buffer would be more code than it saves
  until a profiler says otherwise (§19 rule 20).
- `getBuildingView` is called once per 10 Hz update and allocates a fresh
  frozen view each time. That is the point of a snapshot (§13) and it is one
  object every tenth of a second; it would matter only if something started
  asking for every machine at once, which is C28's production screen.

---

## C13 — Belts

**Goal.** Items move. This is the chunk that makes it a factory game.

**Depends on.** C11.

**Tasks.**
1. Implement §9 exactly: one lane, 4 slots/tile, fixed-point positions, items are
   **not** entities.
2. `BeltEntity`: `direction`, `speedTier`, and a compact per-tile item list.
3. `belt-system.ts`, phase 5, **downstream-first** (§8). Get this wrong and belt
   speed silently depends on entity creation order.
4. Belt-to-belt handoff, including into a belt of a different direction (a curve).
5. Blocking: an item cannot pass an item ahead of it; the block propagates
   backwards through connected belts to the source machine.
6. End-of-belt: if the next tile is a machine or chest, insert into it if it has
   room; otherwise the item waits and the belt backs up.
7. Drag-to-build for belt lines: click-drag lays a path (axis-aligned, with an
   automatic corner) and enqueues one build command per tile. Belts without
   drag-building are miserable to place.
8. Renderer: chevrons animate by belt speed using render-side time only; items
   are drawn at their interpolated fixed-point position.

**Acceptance.**
- Chain **miner → belt → chest** runs unattended and the chest fills.
- A full chest backs the belt up and eventually stalls the miner, with the miner
  reporting `output_full`.
- Belt throughput measures 8.0 items/s ±1% at tier 1 over 60 simulated seconds.
- Throughput is identical whether belts were built left-to-right or right-to-left.
- 12,000 belt tiles with 8,000 items cost < 4 ms per tick.

**Tests.** Movement over N ticks against an exact expected layout; blocking and
compaction; handoff between directions; **build-order independence** (build the
same line in two orders, assert identical state after 600 ticks); throughput.

**Out of scope.** Splitters (C17), underground belts (C22), belt networks (C29),
two lanes (never, in v1).

**Decisions taken while implementing this chunk.**

- **Downstream-first is a cached post-order walk of the belt graph, not an id
  walk.** A belt has at most one tile in front of it, so the graph has
  out-degree one and the walk is chain-following: every belt is emitted after
  the belt it feeds. The order is derived state — §10 lists belt topology as
  exactly that — so it is rebuilt rather than persisted, and only when the set
  of entities has changed. On an unchanged factory `BeltSystem` does no graph
  work at all. The alternative, sorting by entity id, passes the movement and
  hand-off tests and fails task 3's whole point: a belt whose downstream has
  not yet moved shows a fuller tile than the tick will end with, items bunch by
  a slot, and the line runs at a speed that depends on which end of it was
  built first.
- **`EntityStore` gained a `structureRevision` counter**, bumped by `create`
  and by a `cleanup` that actually removed something. It is what tells a
  derived index that the thing it indexes has changed, and it is **not**
  authoritative state: never serialized, and a loaded world starts at zero with
  every index rebuilt on its first tick, which is what §10's `rebuildDerived()`
  means. A future `rotate` has to bump it too, which is the second reason the
  base fields are readonly (C05) — the only way to turn a belt will be a store
  method, and that method is where the line goes.
- **A chest's inventory is an `ItemSlots` — a plain `[itemId, count]` array —
  living on the entity, and `SlotInventory` became a view over one.** C12 left
  this decision to C13 in as many words. An entity is plain data that must
  survive `JSON.stringify` (C05), so it cannot hold a container class; C11
  solved the same problem for a miner with a bare count, which works only
  because a miner's buffer holds one kind of item. A chest holds anything. So
  the containers in `items/inventory.ts` swapped their `Map` backing for a
  sorted array and gained an optional `contents` option: the chest hands over
  its own field, the container writes straight into authoritative state, and
  there is one implementation of stack packing rather than two. The array also
  retires the `Map` C08 had to justify — nothing left in a container has an
  iteration order that could reach a decision (§6 R4) — and `usedSlots` is now
  walked rather than tracked, because a container built per use would have to
  recompute a running total at every construction anyway.
- **Machines are unloaded onto belts at the end of phase 5, after every belt
  has moved.** There is no inserter until C14 and the chain has to run, so a
  machine with an output buffer drops **one item per tick** onto the first belt
  it finds on its output side — `forEachOutputTile` walks the tiles just
  outside the footprint on the side `rotation` faces, so a 2x2 miner tries both
  of the tiles in front of it. Running it after the movement pass means an item
  lands on a settled tile, which is the same promise §8 makes to C14's
  inserters one phase later and for the same reason. Which machines have an
  output is content (`definition.mining`, via `BuildingRegistry.outputBufferTypes`),
  never an id (§19 rule 17); C15's furnace joins the list by gaining a recipe
  output.
- **Two belts nose to nose do not hand off.** Without the rule they trade the
  same item back and forth every tick, which looks like a belt that has jammed
  for no visible reason. Every other relative facing — including sideways,
  which is §9's curve — is an ordinary hand-off.
- **`RenderEntity` gained an optional `depthRow`.** An item is drawn at its real
  position, which for the back half of a tile is a depth row *behind* the belt
  carrying it, so the belt's own flat face painted over it for half of every
  tile. Items now sort in their belt's row, where `RenderLayer` decides,
  nudged by a tenth of a row so two items on one tile still overlap in the
  right order. Everything else leaves the field out and gets the footprint's
  near corner exactly as before (§5).
- **Belt items are a separate list on `RenderState`, like the player.** The
  entity array is also what `ScenePicker` searches, and §9 says belt items are
  not entities: a pick landing on one would hand the inspector `NO_ENTITY`,
  which means "nothing" everywhere else in the codebase.
- **The chevron animation phase is baked into the sprite id** (`belt:1:5`).
  `SpriteAtlas.draw` takes no time and giving it one would put a wall clock
  behind the interface whose whole purpose is that C29 can swap the
  implementation. The phase is computed render-side from elapsed wall time,
  which §6 permits explicitly, and from the belt's *content* speed — so C22's
  fast belt animates twice as fast without anything in the renderer learning
  that a second tier exists. The clock is accumulated from the frame delta and
  not read raw, so pausing stops the chevrons with the belts.
- **Drag-to-build grows the line from its own head, and never enqueues a
  `remove`.** Two rules, and both were found by driving the running game rather
  than by a test.

  *The line grows from the head, not from the anchor.* A path recomputed from
  where the drag started changes **shape** as the cursor moves — the
  long-axis-first rule flips the corner to the other side of the rectangle the
  moment the drag becomes taller than it is wide — and because a tile once
  asked for is never taken back, both routes get built: dragging an L builds
  all four sides, and a wandering cursor fills the rectangle in. Extending from
  the head means the only tiles ever asked for are the ones between two
  consecutive cursor positions, so what gets built is what the player drew. A
  drag that retraces its own line moves the head back and lays nothing, because
  extending *into* a tile already laid would put a belt at the head facing
  backwards, nose to nose with the run behind it.

  *The head tile is not laid until the drag moves past it.* A tile's direction
  is decided by the tile after it, so the head is the one tile whose direction
  is still a guess — and it is exactly the tile that becomes the corner when
  the player turns. Laying it early means laying it the wrong way and taking it
  up again, and a `remove` and a `build` on one tile in one tick **do not
  work**: C05 defers removal to the cleanup phase, so the build that follows is
  honestly refused as `'occupied'` and the corner is left as a hole. Holding
  the head back costs nothing — the ghost is still drawn under the cursor — and
  the corner comes out facing the way the player turned, first time. A press that never moves still places one
  belt, on release, facing the ghost.

**Deviations.**

- **Task 2's `direction` and `speedTier` are not stored.** `Entity.rotation`
  *is* the direction, and a second copy is a second thing to keep in step —
  the one that drifts is the one the simulation reads. The speed is content on
  `BuildingDefinition.belt`, exactly as C11 put a miner's rate on
  `BuildingDefinition.mining` rather than on every miner, so C20's balance pass
  does not have to migrate every belt in every save. C22's fast belt is a
  content row taking the next free `EntityType`, which is what
  `entity-types.ts` already says a new kind of entity does.
- **Task 8's "interpolated position" is read as sub-tile, not inter-tick.** An
  item is drawn `pos / 256` of the way across its tile, at the position the
  simulation settled on. There is deliberately no extrapolation by the frame's
  `alpha`: an item advances a fifteenth of a tile per tick at tier 1, which is
  already smooth, and extrapolating would make every *blocked* item jitter
  forward and snap back — at the one place on a belt a player is actually
  looking.
- **A chest can be taken from, which C12 assigned to C15.** C12's deviation
  said `HandSystem.insert` waits for the furnace, and it still does. *Taking*
  is different: C13 is the chunk that gives a chest contents, the inspector
  already draws a TAKE button beside any output row, and a container that fills
  and can never be emptied is not a container. `HandSystem.outputOf` became
  `outputsOf`, returning a list, because a chest holds more than one kind of
  thing.
- **The player now starts with 100 belts** as well as 5 miners and 10 chests.
  A balance number, and the odd one out on purpose: belts are cheap, they are
  spent a dozen at a time, and running out mid-drag is the one shortage that
  reads as the game being broken rather than as a constraint.
- **The inspector shows a chest's contents with no capacity beside them.** A
  miner's row says "12/50" because a per-item cap is what `output_full` counts
  against; a chest fills by running out of *slots*, whatever is in them, so
  there is no per-item number that would mean anything.

**Noticed, not fixed.**

- A closed loop of belts has no last tile, so there is no downstream-first
  order for it to have. The walk breaks the cycle at whichever belt it entered
  from, which is deterministic for a given layout and store but is the one case
  where the break point depends on entity id — and therefore on build order. A
  loop that feeds only itself carries nothing anywhere, so nothing observable
  rides on it. C18's determinism tests are where this would have to be
  revisited if a loop ever gains an exit.
- `describeBeltItems` allocates one object per item per frame, which at §12's
  eight thousand items is eight thousand allocations a frame. It is the same
  shape `describeEntities` already has and the same answer applies: C28
  measures it and C29 makes both incremental.
- The page requests `/favicon.ico` and gets a 404 on every load. It is the only
  console error in normal play and it predates this chunk; `index.html` names
  no icon.

---

## C14 — Inserters

**Goal.** Move items between belts, machines and chests — the connective tissue.

**Depends on.** C13.

**Tasks.**
1. State machine, advanced in phase 6:
   ```text
   Idle -> Pickup -> Carrying -> Drop -> Idle
   ```
2. `InserterEntity`: `rotation` determines pickup tile (behind) and drop tile
   (in front), `speedTier`, `heldItem`, `stateTicks`.
3. Source and destination validation each attempt: belt, machine buffer, chest,
   or nothing. Never assume a neighbour still exists — it may have been removed.
4. **Contention resolution by entity id** (§6 R6): two inserters reaching for the
   same belt item, lowest id wins. Test it.
5. Rate: **1 item/s** standard, **2.5 items/s** fast (C22 unlock). Note this is
   deliberately below belt throughput, so saturating a belt takes multiple
   inserters — a real layout decision rather than a free action.
6. Do not let an inserter pick up an item it cannot possibly drop (destination
   full) — holding an item hostage in a stalled inserter is confusing. Check the
   destination has room at pickup time.
7. Renderer: the arm swings using render-side interpolation of `stateTicks`.

**Acceptance.**
- Chain **miner → belt → inserter → chest** runs unattended.
- An inserter facing a full destination waits with empty hands and reports
  `output_full`.
- Removing the source or destination mid-swing does not throw; the inserter
  returns to idle and drops nothing.
- Two inserters contending produce identical results across runs and across a
  save/load.

**Tests.** Full state-machine cycle in exact ticks; contention determinism;
neighbour-removed-mid-swing safety; rate verification.

**Out of scope.** Filter inserters, stack inserters, long inserters.

**Decisions taken while implementing this chunk.**

- **The state machine has a fifth state, `Returning`.** Task 1's list is four
  states and an arm that teleports home: after the drop the hand is over the
  *destination*, and something has to bring it back before the next pickup.
  Folding the return into `Idle` would give `Idle` a duration and a hidden
  condition; leaving it out altogether would draw an inserter whose arm snaps
  home instantly, which reads as a machine running at twice its stated rate.

- **The four timed stages sum to `ticksPerItem`, and `Idle` has none.** That is
  what makes 1.0 items/s exact rather than approximate: `Returning` completing
  begins the next `Pickup` in the same tick, so a saturated inserter never
  passes through `Idle` and delivers one item every thirty ticks for ever. The
  split is a tenth of the cycle for the grab and a tenth for the release, the
  rest divided between the two swings with the odd tick going to the carry —
  all of it computed once at registry-build time (§6 R3), so the stages cannot
  drift apart from the cycle they divide however C20 retunes the rate. The
  registry refuses a rate under four ticks a cycle, because four stages need
  four ticks.

- **The item is taken at the end of `Pickup` and only ever put down in the
  destination.** Between those two moments it exists nowhere else; `heldItem`
  is the only record of it. This is what makes task 3's "never assume a
  neighbour still exists" a property rather than a habit — a vanished source
  cannot un-take an item that was never taken.

- **A destination removed mid-swing leaves the inserter holding, not
  dropping.** Task 6 keeps the *ordinary* stall empty-handed by checking the
  destination has room at pickup time, which is acceptance criterion 2. What it
  cannot prevent is the chest being demolished while the arm is already across.
  The item is out of the belt by then, and the three possible answers are
  destroy it, put it on the ground, or hold it. Nothing in IronFlow deletes an
  item the player mined and there is no such thing as an item lying on the
  ground (§2), so it holds: `Drop` does not complete, the inserter reports
  `output_full`, and the moment anything with room appears in front the item
  goes in. It is not hostage either — the hand shows in the inspector and the
  player can take it back (see the deviation on `HandSystem` below).

- **Contention is not a rule written anywhere; it falls out of two decisions.**
  Inserters are walked in the store's id-ordered array (§6 R4) and the item
  leaves the source at the *instant* the pickup completes, so the lower id
  takes it and the higher one, reaching the same tick, finds the belt empty and
  parks. No reservation, no priority table, nothing extra to keep in step
  across a save — which is why the test asserts the answer flips when the two
  inserters are built in the other order. §6 R6 is about ids, not geometry.

- **A belt offers its front item and a container its lowest item id.**
  `items[0]` is the item nearest the output end by `belt-entity.ts`'s
  invariant, and a chest's slots are kept sorted — so "whatever is first" never
  depends on the order things were put in (§6 R4).

- **`MachineStatus` gained a `statusOf(entity)` reader**, and the inspector's
  status and progress are no longer a branch on "is this a miner". C12 wrote
  `status: miner === null ? 'idle' : …`, which was honest with one kind of
  machine in the game and would have become a branch per chunk. §13's "status
  must always explain a stall" is now true for every machine that stores one,
  and C15 and C21 add theirs without touching the controller.

- **The arm sweeps through an arc, not a slide.** Interpolating the hand's
  position linearly from the source tile to the destination tile takes it
  through the base at the halfway point, where the two offsets cancel and the
  arm vanishes into itself every cycle. Sweeping through a half turn — `cos`
  along the facing axis, `sin` upward — puts the hand over the source at one
  end, over the destination at the other and raised above the machine in
  between, which is both what an inserter does and the only shape that reads in
  isometric.

- **Content order in `data/buildings.ts` follows §15's building table**, so the
  inserter sits between the belt and the chest. That order is also menu and
  hotkey order, so the chest moved from key 3 to key 4. Four tests had the old
  count written into them by hand; they now read it from the content table,
  which is what C06's "adding a building requires zero code changes elsewhere"
  was supposed to mean for tests too.

**Deviations.**

- **Task 1's four states are five.** See the first decision above.

- **Task 2's `speedTier` is not stored**, for exactly the reason C13 gave for
  the belt's: the rate is content on `BuildingDefinition.inserter`, so C22's
  fast inserter is a table entry and C20's balance pass does not have to
  migrate every inserter in every save.

- **`heldItem` is an `ItemId` with `NO_ITEM` for an empty hand**, not a
  nullable field. C05 refuses `undefined` in an entity because it does not
  survive `JSON.stringify`, and `0` already means "no item" everywhere else
  (`item-registry.ts`).

- **Acceptance 3's "returns to idle and drops nothing" is read literally for a
  removed *source* and as "drops nothing" for a removed *destination*.** The
  first returns to idle empty-handed, which is exactly the sentence; the second
  holds, for the reason set out above. Both are tested, and neither throws.

- **`HandSystem.outputsOf` gained an inserter's hand.** C12 built it for a
  miner's buffer and C13 added a chest's contents; an inserter holding one item
  it cannot put down is the same problem one item wide, and a `TAKE` button
  beside it is the affordance that makes task 6's worry about a hostage item
  moot. `insert` still refuses everything — C15's furnace is still the first
  machine with somewhere to put an ingredient.

- **Task 7's "render-side interpolation of `stateTicks`" is quantised to
  seventeen arm positions baked into the sprite id**, the same arrangement C13
  used for the chevrons and for the same reason: `SpriteAtlas.draw` takes no
  time, and giving it some would put a clock behind the interface whose whole
  purpose is that C29 can swap the implementation. It interpolates per *tick*
  rather than per frame — at thirty ticks a second across twelve ticks of
  swing, that is finer than the eye resolves, and extrapolating by the frame's
  `alpha` would make a stalled arm jitter forward and snap back, which is C13's
  reasoning about blocked belt items applied to the one part of an inserter a
  player watches.

- **The sprite id carries one bit for "holding" rather than the item's id.**
  The hand takes the cargo colour when full, so a working inserter reads from
  across the factory; *what* it is holding is in the inspector, and it holds it
  for under a second. Threading the item registry into `describeEntities` to
  colour a diamond that size was not worth the parameter.

- **The player starts with 20 inserters** as well as 5 miners, 100 belts and 10
  chests. Four per miner: enough to wire a first factory, not enough to skip
  thinking about where they go. A **balance number** for C20.

**Noticed, not fixed.**

- **Three files now each carry their own copy of "how an item gets into a
  chest"** — `belt-system.ts`, `hand-system.ts` and `inserter-system.ts` all
  build a `SlotInventory` over an entity's `contents`. It is about six lines
  each and §19 rule 5 forbids refactoring an unrelated system inside a chunk,
  but three is the number at which it stops being a coincidence. C15 has to
  touch all three to give the furnace an input buffer, which makes C15 the
  chunk that should unify them into a single "ports" module.
- An inserter draws in `RenderLayer.InserterArm`, so its arm goes over
  everything in its own depth row — including an item on the belt it is
  reaching into. It is still overdrawn by anything standing in the row *in
  front* of it, which for a belt (flat) is invisible and for a future 2x2
  machine will clip the last few pixels of the arm. C29's real art is where
  that gets a proper answer; drawing the arm as its own depth-sorted drawable
  would be the fix.
- `InserterSystem` asks `sourceItem` at the start of a cycle and `grab` at the
  end of the pickup, which walks the source lookup twice per item. It is two
  map lookups every thirty ticks per inserter and nowhere near §12's budget;
  C28 is where it would show up if it ever mattered.

---

## C15 — Furnace and the first vertical slice

**Goal.** Processing. After this chunk, IronFlow is a factory game.

**Depends on.** C14.

**Tasks.**
1. ```ts
   interface RecipeDefinition {
     readonly id: string;
     readonly inputs: readonly ItemStack[];
     readonly outputs: readonly ItemStack[];
     readonly durationTicks: number;      // converted from seconds at registry build
     readonly category: 'smelting' | 'crafting';
   }
   ```
   `RecipeRegistry`, indexed by id and by category.
2. `production-system.ts`, phase 4, shared by furnaces and (C16) assemblers.
   The system must contain **no per-recipe special cases**, ever.
3. Furnace: input buffer, fuel buffer, output buffer, current recipe (auto-selected
   by input item for smelting), `progressTicks`, `fuelTicksRemaining`.
4. Fuel: coal burns for 8 s. Out of fuel ⇒ status `no_fuel`, progress **pauses**
   rather than resetting. Losing progress to a fuel gap feels punitive and teaches
   nothing.
5. First recipe: `iron_ore → iron_plate` in **3.2 s** (0.3125 plates/s).
6. Output-full behaviour: hold the finished item, stop, report `output_full`.

**Acceptance — the vertical slice.**
```text
iron patch -> miner -> belt -> inserter -> furnace -> inserter -> chest
```
runs unattended for 10 simulated minutes and produces plates at the rate the
math in §15 predicts, ±2%.

Also:
- Removing fuel pauses progress and resumes it exactly where it stopped.
- A blocked output stalls the whole chain backwards to the miner.
- The whole chain's state survives §6 R8's save round-trip (asserted from C24;
  write the test now and mark it skipped until then).

**Tests.** Recipe completion in exact ticks; fuel consumption and pause/resume;
output blocking; the full integration chain as a headless test with **no canvas
and no DOM**.

**Out of scope.** Electric furnaces (C21), recipe selection UI (C16), modules.

**Decisions taken while implementing this chunk.**

- **One `MachineEntity`, not a `FurnaceEntity`.** Task 2 says the production
  system must contain no per-recipe special cases; the same argument applies
  one level up, because a branch on "is this a furnace" is a branch C16, C20
  and C21 each have to find and extend. What separates a furnace from an
  assembler is `ProductionProperties` in `data/buildings.ts` — recipe
  category, buffer sizes, and whether it burns anything — so `asMachine` asks
  the *registry* rather than the entity type, and C16's assembler becomes a
  machine by appearing in the content table.

- **Ingredients are taken when a craft starts and the product is held when it
  finishes.** `progressTicks` sitting at `durationTicks` *is* the "holding a
  finished item" state (task 6), so there is no field for it and no way for
  the two to disagree. The ingredients for the next craft are not touched
  until the held one lands, which is what makes the stall reversible: unblock
  the output and the machine carries on in the same tick.

- **Fuel is checked before the ingredients are consumed.** A furnace that runs
  dry between crafts has not eaten an ore it cannot smelt. Task 4's "progress
  pauses rather than resetting" is the same instinct one step earlier: a
  supply gap costs time, never work already done.

- **A saturated machine completes a craft every `durationTicks` exactly.** The
  craft that finishes at the end of a tick delivers *in that tick*, leaving
  `progressTicks` at 0 with no idle tick before the next one — the same
  arrangement C14 made for the inserter's `Returning` stage, for the same
  reason. 3.2 s is 96 ticks and 96 ticks is what a fed furnace takes, which is
  what the ±2% acceptance criterion is measured against.

- **A furnace picks its recipe from the lowest item id in its input buffer**,
  not from what arrived first. Arrival order is not serialized, so a furnace
  holding both ore and stone must choose the same recipe after a reload as
  before it — §6 R6's "resolve contention by id" applied to items rather than
  entities. `RecipeRegistry.forInput` refuses to answer at all when two
  recipes in a category want the same ingredient. *(That was expected to be all
  C16's player-chosen crafting needed, and it was not: ambiguity decides which
  recipe an item names and cannot make a choice survive an empty buffer, so
  C16 added `recipeSelection` to the building. The index is unchanged and the
  furnace still uses it exactly as described here.)*

- **Fuel is a property of the item, not of the furnace.** `fuelSeconds: 8` sits
  on coal in `data/items.ts`, so C21's generator burns the same coal without
  either building carrying a table of what it accepts. It converts to ticks
  once, at registry build (§6 R3). *(C21: "eight seconds" turned out to mean
  "eight seconds at 150 kW" — the furnace is unchanged, because it has no power
  rating and therefore burns at exactly that reference rate. See §15's fuel
  note.)*

- **A belt still does not load a machine, and a machine does not unload onto a
  belt.** Two comments written in C13 predicted the opposite — that the furnace
  would gain an arm in `belt-system.ts` and join `outputBufferTypes` — and both
  were wrong on the plan's own evidence: §15 derives its ratios with an
  inserter in that gap ("1 std inserter feeds 3.2 plate furnaces"; "a belt is
  saturated by 16 miners **or** 8 std inserters"), and C15's acceptance chain
  puts an inserter on each side of the furnace. A belt that could load a
  machine at 8 items/s would make half of those inserters decoration. A
  *miner* keeps its direct drop, because it has no input side and §15 counts
  it that way. Both comments now say so, beside the code that implements it.

- **`items/item-port.ts` exists, which is C14's "noticed, not fixed" paid
  off.** C14 ended with three systems each carrying their own copy of "how an
  item gets into a chest" and named C15 as the chunk that should unify them,
  because C15 had to touch all three. A **port** is one end of a transfer, in
  two interfaces rather than one — `ItemSource` and `ItemSink` — because the
  two directions are genuinely different sets of buildings, and splitting them
  means every port that exists has a caller for every method it implements. A
  miner offers and never accepts; a furnace's input accepts and never offers;
  only a chest does both. Belts stay out of it on purpose: an item on a belt
  has a *position* (§9), and flattening that into "add one item" would make a
  belt a container with a count.

- **The player can hand-feed a furnace, and `insertItems` finally does
  something.** C12 wrote the refusal and said the furnace would fill it in.
  What did not change is who decides: `not_accepted` comes from the building —
  no input port, or an item no recipe of its category wants — rather than from
  a list kept in `HandSystem`.

**Deviations.**

- **Task 1's `RecipeDefinition` is split in two**, the way `BuildingDefinition`
  already is. Content authors `seconds` and string item ids because that is how
  §15's table reads; the registry builds a frozen `Recipe` with `durationTicks`
  and runtime `ItemId`s, so no system resolves a string per tick. The task's
  comment — "converted from seconds at registry build" — is what this is.

- **A recipe has a numeric `RecipeId`, but there is no saved id mapping.**
  A machine's `recipe` field is a number with `NO_RECIPE` for none, exactly as
  `heldItem` is an `ItemId` with `NO_ITEM` (C05 refuses `undefined` in an
  entity). Unlike items, C24 will write the recipe's *string* id into the save
  and read it back through `get`: one field per machine does not earn a
  translation table, and a save that names its recipes is one a human can read.

- **`MachineStatus` gained `NoFuel`**, and `AlertType` gained
  `machine_no_fuel`. The status is task 4's; the alert follows C11's miner
  precedent — it fires on the transition, not every tick — because §13 asks a
  stall to explain itself and "it stopped an hour ago and I never noticed" is
  the failure that makes a factory game feel arbitrary.

- **C15 ships all four of §15's smelting recipes, not only `smelt_iron`.**
  Task 5 names the first one; the other three are content in the same table and
  the chunk's central claim is that the system does not know one recipe from
  another — four rows test that better than one, and `smelt_steel`'s five-plate
  input is the only multi-ingredient recipe the game will have before C16.
  `steel` and `brick` join `data/items.ts` under that file's existing rule: an
  item arrives with the recipe that makes it. Both also gained a palette token,
  because without one they would have drawn as the same grey box.

- **The furnace has four rotations**, although a 2×2 footprint looks the same
  in all of them. Rotation is what an inserter and the placement ghost read to
  face it, and a building that cannot be turned is a building the player
  fights with. It costs nothing: `normalizeRotation` already handles it.

- **The three buffer capacities are 50 each** — one stack of ore in, one of
  plates out, and 400 seconds of coal. **Balance numbers** for C20, and the
  ceiling that makes backpressure reach the belt (§9).

- **The starting kit gained 10 furnaces**, two per miner against §15's 1.6.
  Another balance number, and the first one here that comes out of the content
  table rather than out of the feel of the thing.

- **`rejected: 'nothing_to_give'` was added** for an `insertItems` whose player
  is not carrying the item — the other half of `nothing_to_take`, which said
  the wrong thing about the wrong container.

**Acceptance, as tested.**

- `tests/integration/vertical-slice.test.ts` builds
  `iron patch -> miner -> belt -> inserter -> furnace -> inserter -> chest`
  **and** a second `coal patch -> miner -> belt -> inserter -> furnace` chain
  entirely from `build` commands, then runs twenty simulated minutes without
  touching anything. The coal chain is not decoration: a hand-fed furnace
  cannot make the "unattended" claim. Plates arrive at 0.3125/s ±2% over the
  second ten minutes, nothing is lost, a full chest stalls the line all the way
  back to the miner's buffer, and two identical builds produce identical state.
  The §6 R8 round-trip test is written and skipped until C24.

**Noticed, not fixed.**

- **`ProductionRate`'s window is 300 ticks**, which at 0.3125 plates a second
  is three plates: the furnace's rate in the inspector is honest but visibly
  coarse, and it flickers between roughly 12 and 24 per minute. A miner at 0.5
  a second has the same problem half as badly and C12 did not notice. The fix
  is a window in *items* rather than ticks, or a longer one for slow machines;
  C20 is where a number that reads wrong on screen matters.
- **`MachineInputPort.route` decides fuel-before-ingredient** for an item that
  is both, and no item in v1 is both. If C20 ever makes something smeltable
  that also burns, that line is the one to look at.
- The inspector has no INSERT button, so `insertItems` is reachable only from
  a command. *(C16 built the recipe panel and did **not** add the button: a
  machine's input is emptied by `setRecipe`, which is the case that made the
  ingredients unreachable. See C16's "noticed, not fixed".)*

---

# Milestone C — Factory game

> **Result:** a seeded world, a tech tree, power, and a factory worth rebuilding.

---

## C16 — Assembler & multi-input recipes

**Goal.** Recipes with more than one input, chosen by the player.

**Depends on.** C15.

**Tasks.**
1. `AssemblerEntity`: one input buffer per recipe ingredient, an output buffer, a
   player-selected recipe, `craftingSpeed` (tier 1 = **0.5**).
2. `setRecipe` command. Changing a recipe returns the current inputs to the
   player if in range, or voids nothing — never silently delete items.
3. Recipe picker UI in the inspector: a grid of unlocked recipes for the
   machine's category, with ingredient icons and rate.
4. First recipes: `gear = 2 iron_plate` (1.0 s), `copper_wire = 1 copper_plate → 2`
   (0.5 s), `circuit = 3 copper_wire + 1 iron_plate` (1.0 s).
5. Effective duration is `durationTicks / craftingSpeed`, rounded to whole ticks
   **once**, at recipe-selection time, and stored — never recomputed per tick (§6 R3).

**Acceptance.**
- An assembler crafts only when every ingredient is present, and reports which
  ingredient is missing.
- Switching recipes mid-craft is safe and loses no items.
- Adding a recipe to `data/recipes.ts` requires no changes to `production-system.ts`.
- Chain **plates → assembler → gears → chest** runs unattended.

**Tests.** Multi-input consumption atomicity (never consume a partial set);
recipe switching; the no-special-cases property, verified by a test that adds a
synthetic 3-input recipe at runtime and expects it to work.

**Out of scope.** Modules, beacons, productivity.

**Decisions taken while implementing this chunk.**

- **Who chooses a machine's recipe is content, not a category.** C15 expected
  `RecipeRegistry.forInput`'s ambiguity to carry this — "smelting happens to be
  unambiguous, crafting happens not to be" — and it does not, for two reasons
  the table makes plain. `copper_plate` names exactly one crafting recipe, so
  an assembler beside a copper belt would quietly start making wire; and a
  player's choice has to survive an **empty** buffer, which no fact about
  ingredients can decide. So `ProductionProperties` gained
  `recipeSelection: 'auto' | 'player'`. A furnace reads its buffer and drops
  its recipe when the ore runs out, exactly as in C15; an assembler is told,
  and keeps it until it is told otherwise. `production-system.ts` branches on
  that field and still contains no building's name.

- **A machine that knows what it is making accepts only that recipe's
  ingredients.** C15's input port asked the *category*, which was the same
  answer while every machine picked its own recipe. It stops being the same
  answer the moment a machine is told: a gear assembler beside a copper belt
  would fill fifty slots with plates it will never spend, and the player would
  read a full buffer under the words "missing ingredients". This is C14 task
  6's rule — an inserter waits rather than silting a machine up — now that a
  machine can say which is which. A machine with no recipe yet falls back to
  the category if it auto-selects, and to **nothing** if the choice is the
  player's: until it is told, "will you want this?" has no answer that is not
  a guess.

- **`setRecipe` is a hand action, in `hand-system.ts`.** It reaches into a
  machine and takes the ingredients out (task 2), which is what that system
  is: the player, standing next to something, in phase 1, because somebody
  clicked. `production-system.ts` runs every machine every tick and has never
  heard of the player. Reach is required for the reason `takeItems` requires
  it, and the refusals are that system's existing vocabulary —
  `unknown_entity`, `out_of_reach`, `unknown_recipe` for an id no recipe has,
  `not_accepted` for a building that cannot run one.

- **Switching a recipe refunds the craft in progress, not only the buffer.**
  C15 takes a craft's ingredients when it *starts*, so a machine switched
  half-way through would lose real items rather than only time. Both come back
  — into the player's bag as far as it will take them, the rest left in the
  machine — and the switch is refused before anything moves if the refund has
  nowhere at all to go. The **fuel** buffer is untouched: coal is coal whatever
  the machine is making. Choosing the recipe a machine is already on is a
  no-op, so a panel that re-sends its own selection cannot empty a machine.

- **`MachineStatus.NoRecipe` is produced at last**, by a machine whose choice
  is the player's and who has not made one. An auto machine with nothing
  resolvable still says `no_input`: "feed me" and "decide" are different
  instructions, and pillar 3 is about which one the player can act on.

**Deviations.**

- **Task 5's rounded duration is stored in a content table, not on the
  machine.** The task says "at recipe-selection time, and stored"; it is
  computed once at startup for every (machine type, recipe) pair, in
  `registries/craft-durations.ts`, and looked up. Both satisfy the part that is
  load-bearing — the division happens once and a tick compares two integers —
  and the difference shows up exactly once, when C20 retunes a recipe or a
  speed: a number written into an entity is written into the save with it, so
  every assembler built before the retune would keep the old rate for ever and
  the factory would produce two different numbers depending on when each
  machine was placed. `MiningConfig` in `building-registry.ts` decided this
  first, in the same words, and a second answer to the same question is what a
  save migration is made of.

- **`craftingSpeed` is on every machine, including the furnace**, which
  declares 1.0. §15 gives a crafting speed only to the assembler; making it
  optional would have hidden a real property of a building behind a default,
  and "a furnace's smelting times are already the times a furnace takes" is
  worth one line of content saying so. §15's anchors now name it.

- **C16 ships task 4's three recipes and no more.** §15 has five processing
  crafting recipes; `make_frame` and `make_data_core` wait for C22's lab,
  because their *consumer* does, and a recipe no player has a reason to run is
  content C20 cannot balance. This is the rule `data/items.ts` already
  follows, and it is why `gear`, `copper_wire` and `circuit` arrive here while
  `frame` and `data_core` do not. The **building** recipes wait too, and for a
  different reason: they need the player's materials bag and their slot
  inventory to become one thing, which is a change to how a build cost is
  *paid* rather than to what an assembler can make. C15's note in
  `simulation.ts` predicted C16 would do it; it does not, and the note now
  says so.

- **The picker has no `unlocked` field.** Task 3 says "unlocked recipes", and
  every recipe is unlocked until C22 — so the controller filters and the panel
  lists what it is handed. A field that is `true` for every row in every
  machine for six chunks is §13's "a view model carries only what exists"
  broken for the sake of a word.

- **"Ingredient icons" are the count and the name.** §11 puts eight inline
  SVGs in `ui/icons.ts` and no item art anywhere; item sprites belong to the
  canvas atlas and to C29. The chip the picker draws is what a player reads
  and what will hold a real icon beside it when there is one.

- **The starting kit gained three assemblers**, which is §15's arithmetic one
  step along from C15's ten furnaces: a gear assembler needs 3.2 plate
  furnaces, so ten furnaces feed three. A **balance number** for C20.

- **The assembler's two buffer capacities are 50**, the furnace's numbers, for
  the furnace's reason: a ceiling per ingredient is what makes backpressure
  reach the belt (§9). **Balance numbers.**

**Acceptance, as tested.**

- `tests/integration/ore-to-gears.test.ts` is §17's required C16 chain —
  `ore -> smelt -> assemble -> chest` — built as C15's vertical slice with an
  assembler on the end: two mining chains, a furnace, an assembler set to
  `make_gear` by command, and a chest. Twenty simulated minutes unattended,
  gears at 0.15625/s ±2% over the second ten, which is §15's "1 gear assembler
  needs 3.2 plate furnaces" observed from the other end. Nothing is lost —
  every plate smelted is a gear, an ingredient in a buffer, a pair in the fire
  or an item in a hand — a full chest stalls the line back through the
  assembler and the furnace to the miner, an assembler with no recipe stops the
  line and says why, and two identical builds produce identical state.
- `tests/unit/assembler.test.ts` carries the three tests the chunk names:
  multi-input atomicity (three wires and no plate is a wait, not a partial
  take), recipe switching (nothing lost, mid-craft included, and a no-op when
  it is the same recipe), and the no-special-cases property — a synthetic
  three-ingredient recipe built at runtime into a registry `data/recipes.ts`
  has never contained, which crafts in exactly the ticks the division predicts.
- `tests/unit/inspector.dom.test.ts` covers the picker: every crafting recipe
  offered with its ingredients and rate, none offered for a furnace or a miner,
  a click that dispatches a command and changes nothing until a tick judges it,
  a second click on the chosen one that clears it, and no DOM rebuilt while the
  machine runs.
- `tests/unit/sprite-atlas.test.ts` gained a guard C16 wanted and every earlier
  chunk could have used: every building and every item in the content tables
  draws as something, rather than as the magenta marker a typo would produce.

**Noticed, not fixed.**

- **`ProductionRate`'s window is still 300 ticks** (C15's note). An assembler
  at 0.5 gears a second reads it far better than a furnace does, so the
  problem is now visibly one of *slow* machines rather than of the window.
  Still C20's.
- **A machine's input buffer has no TAKE button.** `setRecipe` empties it, so
  nothing is trapped in practice — but ingredients left behind because the
  player's bag was full can only be recovered by switching the recipe twice.
  The port split in `items/item-port.ts` is deliberate (an inserter must never
  steal a machine's ingredients), so the fix is a player-only source rather
  than widening `outputPortOf`.
- **Nothing consumes a `gear` or a `circuit` yet.** They bank up in a chest
  until §15's building recipes or C22's lab give them somewhere to go, which
  is the shape of the tech tree rather than a gap in this chunk.

---

## C17 — Splitters & belt routing

**Goal.** The layout puzzle gets interesting.

**Depends on.** C13.

**Tasks.**
1. `SplitterEntity`, 1×2 footprint (per the reference sheet), two inputs, two
   outputs, **deterministic round-robin** on a persisted counter — not random,
   not "whichever is emptier".
2. Balanced output when both sides can accept; full pass-through to one side when
   the other is blocked.
3. Merging: two belts feeding one splitter input side alternate deterministically.
4. Renderer: the splitter sprite from the reference sheet, with the belt lane
   drawn continuously through it.

**Acceptance.**
- A saturated input splits 50/50 ±1 item over 1,000 items.
- Blocking one output sends 100% to the other with no throughput loss.
- Behaviour is identical across a save/load (the round-robin counter is persisted).

**Tests.** Split ratio over long runs; blocked-output behaviour; round-robin
counter persistence; determinism across build order.

**Out of scope.** Priority splitters, filter splitters.

**Decisions taken while implementing this chunk.**

- **A splitter is a belt, twice over, and lives in the belt system.** §8's
  phase list has a `belts` phase and no splitter phase, and §9 puts "splitter
  round-robin" in the *belt model's* own list of required behaviours. Both are
  taken literally: `entities/splitter-entity.ts` holds two lanes of §9's
  ordinary belt items, and `belt-system.ts` advances them with the loop it
  advances a belt tile with. The word the file uses for what it moves is a
  **carrier** — anything content gives a `tilesPerSecond` to. Splitting it into
  a second system was considered and rejected for one concrete reason: the
  downstream-first order is **one graph** spanning both kinds, and two systems
  would each hold half of an order neither could compute.

- **The cached order became a real depth-first walk.** C13's version followed a
  chain, because a belt has exactly one tile in front of it. A splitter has
  two, so the walk gained a per-node edge cursor. Everything else about it is
  unchanged — still post-order, still keyed on `structureRevision`, still no
  graph work on a factory that has not been edited.

- **Two cursors, and one sentence governing both.** `outputCursor` says which
  side a leaving item tries first; `inputCursor` says which lane is advanced
  first. Both obey **"a cursor advances when the thing it pointed at was
  used"**, and all three of this chunk's acceptance criteria fall out of that
  rather than being coded for one at a time. Balanced output is strict
  alternation. A blocked side is tried, fails, and does *not* take its turn, so
  every later item repeats the same failed try and the same successful
  fallback — 100% down the free side at the full belt rate. A merge alternates
  between its two inputs, and a lane that is empty keeps its favour rather than
  burning it, so a dead input never costs the live one a turn. The second
  cursor is what task 3 asks for and is invisible until two belts feed one
  splitter; without it lane 0 wins every contested tick and starves lane 1.

- **A splitter accepts items across its back edge and nowhere else.** §15 gives
  it two inputs, and `splitterSideFedFrom` is what makes that a rule rather
  than a description. A belt running into its flank backs up, which is what a
  belt pointed at the side of any other machine does. The same geometry is what
  keeps two splitters nose to nose from trading an item across the seam and
  back every tick: the tile an item would return from is on the far side of the
  other machine, so it is never an input tile. `facesBack` covers that hazard
  for two belts; here the shape covers it and no flag is needed.

- **`beltAccept` and `beltEntryPosition` became `laneAccept` and
  `laneEntryPosition`, over the array rather than the belt.** A belt tile has
  one lane and a splitter has two, and they are the same thing: four slots of
  fixed-point positions that items compact along. Writing the rule once, over
  the array, is what lets one loop advance both — and it is why an item
  crossing into a splitter keeps the position it carried over the boundary
  instead of being re-derived at the seam. Two names for one concept was the
  alternative and is how the copies start.

**Deviations.**

- **The splitter has four rotations, not the two §15's "1×2" suggests.**
  `building-registry.ts` predicted this in C06 — "a 1×2 splitter only ever
  faces north or east" — and it is wrong: a splitter's *shape* repeats every
  half turn but its **direction** does not. With two rotations it could only
  ever push north and east, so no belt line running south or west could use
  one, which is half the layout puzzle this chunk exists to create. The comment
  in the registry now says so where it used to say the opposite.

- **The footprint is authored `{ width: 2, height: 1 }`.** §15 writes "1×2",
  which is a shape rather than an orientation. Two across the flow and one deep
  is the only reading that works: every geometry helper in
  `splitter-entity.ts` reads "the tile in front of this side" off the rotation
  alone, and a footprint deeper than one tile would make that wrong for the far
  row. The registry **refuses** any other size for a building with a `splitter`
  field, so the assumption is enforced rather than remembered.

- **`splitter` is its own content field rather than a flag on `belt`.** They
  carry the same `tilesPerSecond` and convert it with the same arithmetic, but
  a belt is one tile with one way out and a splitter is two tiles with two, and
  `belt-system.ts` has to know which it is holding before it can move an item
  off the end. The speed *check* is shared (`checkCarrierSpeed`), because a
  rule that held for only one of them is a rule the other could break.

- **The splitter runs at the belt's 2.0 tiles/s**, which is a **balance
  number** for C20 but not an arbitrary one: a splitter slower than its belt is
  a throughput cliff in the middle of a line the player cannot see, and one
  faster would make splitting a line speed it up. §9's anchor carries straight
  through it, so an item does not change pace crossing the seam.

- **Neither an inserter nor a miner can load a splitter directly.** §15 counts
  a miner's output straight onto a belt and everything else through an
  inserter, and §17's required chain is `belt -> splitter -> 2 belts -> 2
  chests`: a splitter is a **belt fitting**, fed by belts. Making an inserter's
  destination work would have meant making its *source* work too — which is a
  third round-robin, over which lane it reaches into — and that is scope this
  chunk does not need. Listed under "noticed, not fixed" because a player will
  eventually point an inserter at one.

- **The starting kit gained ten splitters**, which is two per miner: the number
  it takes to fan one ore line out to four consumers, one split and then a
  split of each half. A **balance number** for C20. The splitter also takes
  hotbar slot 3, pushing the inserter and everything after it along one —
  `data/buildings.ts` is in §15's table order and says so.

**Acceptance, as tested.**

- `tests/integration/belt-splitter-chests.test.ts` is §17's required C17 chain,
  built from `build` commands with a miner on the end of it. Twenty simulated
  minutes unattended: both chests fill to within one item of each other, every
  ore mined is in a chest or still in flight, the same factory with one branch
  never built delivers exactly the same total down the one branch it has, two
  full chests stall the line back through the splitter to the miner, and two
  identical builds produce identical state.
- `tests/unit/splitter.test.ts` carries the four tests the chunk names.
  **Split ratio**: a saturated belt into a splitter with two outputs delivers
  1,108 items as 554/554. **Blocked output**: everything goes down the free
  side, and the count matches a plain belt line of the same length to within
  one item — no throughput loss. **Round-robin counter persistence**: a factory
  run 400 ticks, serialized through JSON at the halfway mark and rebuilt from
  that data alone, is byte-identical to one that never stopped — which is only
  true because both cursors are fields on the entity. **Build order**: the same
  line laid from the feed end and from the chest end is the same state after
  900 ticks. Beside them: the back-edge-only input rule, backpressure into the
  feeding belt, the footprint geometry at all four rotations, and the
  registry's refusal of a splitter that is not two across and one deep.
- `tests/unit/splitter-view.test.ts` covers task 4 — the part of it that is a
  fact rather than a picture. The splitter draws in the **belt** layer, takes
  its rotated extent (2×1 north, 1×2 east), names a real sprite at every
  rotation including the ghost's, runs on the belt's chevron cycle because it
  runs at the belt's speed, and the items inside it are drawn on their own
  footprint tiles beside the items on the belts — which is what makes the lane
  read as continuous through it.
- **In the running game**: the splitter is in the build menu at slot 3, places
  from the hotbar in line with a belt run, and draws as one two-tile plate with
  a chevron lane through each half and a structure-coloured edge — with no
  console errors or warnings.

**Noticed, not fixed.**

- **An inserter pointed at a splitter waits for ever, silently.** The
  destination has no port, so the inserter never picks anything up. It is not
  wrong — a splitter is fed by belts — but "nothing happens" is the failure
  mode §7 and pillar 3 exist to prevent, and the fix is either a port or a
  placement-time warning. Neither is C17's.
- **A splitter's inspector panel is empty**, exactly as a belt's is: it has no
  ports, so the view model carries no contents. What a player would want to see
  is which way the next item is going, which is the one cursor the UI has no
  word for yet.
- **The procedural atlas has no test that executes a `draw`.** `drawSplitter`
  is covered by the browser run and by nothing else; a throw inside any of the
  atlas's draw functions would reach a player before it reached the suite. That
  predates this chunk — no sprite has ever been drawn in a test — and it is
  C29's to settle when the image-backed atlas arrives.
- **`describeBeltItems` now walks two entity buckets and allocates per item.**
  Still the wrong shape for §12's reference factory, still C28's to measure and
  C29's to make incremental — the note C06 first wrote, unchanged.

---

## C18 — Simulation hardening & determinism tests

**Goal.** Make §6 true and keep it true. **This chunk is a gate — do not proceed
to C19 until it passes.**

**Depends on.** C17.

**Tasks.**
1. Implement `game/rng.ts` (§6 R2) and route every existing use of randomness
   through it. Serialize the stream position.
2. Audit every system for float accumulation and convert to integer ticks (§6 R3).
   Grep for `+= dt` and `* dt` inside `src/game/`.
3. Audit every simulation loop for `Map`/`Set`/`Object.keys` iteration (§6 R4)
   and replace with id-ordered arrays.
4. Add the ESLint rule from C00 in error mode if it was a warning.
5. Build the determinism test harness:
   ```ts
   function runScenario(seed: number, commands: TimedCommand[], ticks: number): Hash;
   ```
   with a stable, order-independent state hash (FNV-1a over a canonically
   serialized state).
6. Write the three core determinism tests: identical reruns; frame-pattern
   independence (§8); build-order independence.
7. Add a benchmark harness (`vitest bench`) for tick cost per system.

**Acceptance.**
- 10,000 ticks of a 500-entity factory produce an identical state hash across
  10 runs.
- The same scenario driven by regular 16 ms frames, jittery 5–120 ms frames, and
  one 2-second stall produces identical hashes.
- No `Math.random` / `Date.now` / `performance.now` anywhere under `src/game/`.
- Every numeric field of a serialized state is finite (§6 R7).

**Tests.** The above, plus a per-system benchmark baseline committed to the repo
so future regressions are visible.

**Out of scope.** Replay recording (a natural follow-on, but not v1).

**What the audits found.**

Tasks 2 and 3 are audits, and the honest answer to both is *nothing to fix* —
which is worth writing down, because "we looked" and "there was nothing there"
are different claims and only the first one is a task.

- **R3, float accumulation.** `grep` for `dt`, `delta` and `deltaTime` under
  `src/game/` returns matches in **comments only**. Every duration in the game
  is authored in seconds in `data/` and converted to an integer tick count once
  at registry-build time (`ticksPerItem`, `unitsPerTick`, `inserterConfig`,
  `CraftDurations`), which is §6 R3's rule already structural. The one place
  real time enters the game is `SimulationClock`, and C00 had already made its
  accumulator an integer.
- **R4, `Map`/`Set` iteration.** No simulation system iterates one. The three
  places that come close are all deliberate and all documented where they
  stand: `EntityStore.cleanup` walks a `Uint8Array` of touched types rather
  than a `Set` of them, `BeltSystem.rebuildOrder` uses a `Map` for lookup and
  never traverses it, and `ItemCounts.toJSON` sorts its keys. The registries
  hold `Map`s that are lookup tables and are never walked — each of them has an
  ascending, enum-derived array beside it for exactly that reason.

Both are now **guarded rather than merely audited**:
`tests/determinism/source-rules.test.ts` scans the source for the shapes each
rule forbids, in the same form `projection-boundary.test.ts` guards §5. An
audit protects the day it was done; a scan protects every day after it.

**Decisions taken while implementing this chunk.**

- **The state hash is a test fixture, not `src/game/save/`.** C24 owns the real
  serializer, and §14's save is a *different document*: world deltas rather
  than whole world chunks, a schema version, migrations. Hashing the save would
  make the determinism tests blind to exactly the bug §6 R8 exists to catch — a
  field the serializer forgot hashes the same before and after. `state-hash.ts`
  therefore walks live state from an explicitly listed set of roots, so adding
  authoritative state without adding it there is one visible omission rather
  than a silent one, and the two checks stay independent when C24 lands.

- **Canonical means sorted, not `JSON.stringify`.** Three properties are load-
  bearing and `JSON.stringify` has none of them: it writes object keys in
  *insertion* order (so the same entity built in a different sequence would
  hash differently), it normalises `-0` to `0` (so a hash built on it is blind
  to the one value §6 R7 calls the quietest), and it turns `NaN` and `Infinity`
  into `null`. `canonicalize` sorts keys, writes `-0` as `-0`, and writes the
  two non-finite values by name.

- **Build-order independence is asked of an id-free projection.** It has to be,
  and the reason is §6 R5 rather than a weakness in the test: ids are monotonic
  and never reused, so laying the same factory in a different order genuinely
  produces a different set of them, and a hash including ids would report that
  difference instead of the one being asked about. `hashLayout` keys entities
  by tile and drops `id` — but keeps `nextEntityId`, so a layout that quietly
  leaked one is still caught. A companion test asserts the two orders *do*
  differ under `hashState`, so the comparison cannot become vacuous.

- **A scenario is a number of ticks, and the harness clamps to it.** A frame
  carries up to `MAX_STEPS_PER_FRAME` ticks, so a loop driven by frames cannot
  land on an exact tick count: the jittery pattern sails two ticks past ten
  thousand where the steady one stops on it. §6's contract is stated in ticks
  and §8 is explicit that wall-clock time away costs nothing, so
  `ScriptedSimulation` stops stepping once the scenario's tick budget is spent
  and the loop keeps running around it. Commands are likewise placed on
  **ticks**, not on frames — enqueued inside the tick they are due on — because
  "enqueue before each frame" would land a command on a different tick under a
  different pattern, and the frame-pattern test would then fail for a reason
  that has nothing to do with the simulation.

- **The command script holds no entity ids.** §7's union has three members that
  name one — `rotate`, `setRecipe`, `takeItems` — and none of them can appear
  in a script shared by two build orders, for the reason above. They are
  covered by C12's and C16's tests, where the entity is the subject rather than
  the variable. What is left still exercises the queue, validation, a
  placement, a removal, walking and the world being mined.

- **The reference factory is created, not built from commands.** A build
  command is checked against the player's reach (C10), so a 507-entity factory
  would have to be built by walking the player up and down it for thousands of
  ticks before the measurement could start — a test of `movePlayer`. Creating
  the layout directly is also the shape a loaded save arrives in.

- **`World.forEachLoadedChunk` was added, sorted.** The hash has to fold the
  world in without *generating* it, and `forEachChunkInBounds` generates by
  design. The only other way to enumerate was the `Map`, which iterates by
  insertion — so a world explored westward and the same world loaded from a
  save would have handed out their chunks in different sequences. Sorting by
  packed key makes the order a coordinate order. §14's save wants the same
  method for the same reason.

**Deviations.**

- **The benchmark harness is not `--outputJson` / `--compare`.** Vitest 5
  replaced the benchmark API this project was written against: `bench` is no
  longer a module export, benchmarks are ordinary tests that take a `bench`
  from the test context, and the CLI has neither flag. The committed baseline
  is therefore one JSON file per case under `tests/bench/baseline/`, written by
  `bench`'s own `writeResult` and read back as `bench.from(...)` rows in the
  comparison table. `npm run bench` prints current against baseline;
  `npm run bench:baseline` overwrites it and is the only thing that does, so a
  regression cannot quietly become the new normal on the next run.

- **Benchmarks do not run under `npm test` and assert nothing.** A benchmark's
  result is a property of the machine, and a suite that failed because a laptop
  was on battery is a suite people learn to ignore. §12's budgets are asserted
  at C28, against the profiler C28 builds; C18's job is the harness and a
  baseline a person can read.

- **"Tick cost per system" is measured as a factory made of one thing.** The
  systems are private to `Simulation` and widening that surface for a
  measurement would be the wrong trade — and calling a system outside its phase
  order would measure something the game never does. Each case is a whole tick
  over 1,000 entities of one kind; `reference factory (mixed)` is the mixture
  and is the row that maps onto §12's tick budget.

**Acceptance, as tested.**

- **10,000 ticks of a 500-entity factory, identical across 10 runs.** 507
  entities in 39 cells — miner, four belts, splitter, two belts, chest,
  inserter, furnace, inserter, chest — so every system in the game is inside
  the measurement. Ten runs, one hash. Two companion tests keep it honest: a
  different command script and a different tick count each produce a
  *different* hash, so a comparison that had stopped depending on either would
  fail rather than pass quietly.
- **Frame-pattern independence.** Steady 60 Hz, jitter between 5 ms and 120 ms,
  and one two-second stall all produce the same hash. A fourth test asserts the
  three patterns really are different: steady runs 0 or 1 ticks a frame and
  never two, jitter spreads across 0–4 and needs less than half the frames, and
  the stall hits §8's step cap exactly once.
- **Build-order independence.** The factory laid forwards and backwards
  produces the same layout hash after 10,000 ticks — and a different *state*
  hash, which is the guard that the first comparison is not vacuous.
- **No `Math.random` / `Date.now` / `performance.now` under `src/game/`**, plus
  the rest of §6 R1's sentence — `crypto`, `navigator`, `Intl`, locale-
  sensitive sorting and formatting — checked file by file, with a test that the
  patterns themselves match the shapes they claim to and miss the shapes that
  are fine. The ESLint rules gained the same members and were verified to fire.
- **Every number in a serialized state is finite, and none is `-0`**, after a
  ten-thousand-tick run. Beside it, a test that `forEachNumber` would find one.
- `tests/unit/rng.test.ts` covers §6 R2: the same seed gives the same stream,
  the position round-trips through JSON and resumes exactly, a seed is
  normalised to 32 bits, `NaN` is refused rather than silently becoming 0, and
  the distribution is flat to within 5% over 100,000 draws.
- **The harness was checked against a real defect**: a `Math.random()` inserted
  into `MiningSystem.tick` that skips a tick 0.2% of the time fails all three
  core determinism tests. An earlier attempt that wrote only to a private field
  nothing read failed *none* of them, which is the right answer and is why the
  mutation was made to touch authoritative state.

**Noticed, not fixed.**

- **Miners are the most expensive system per entity, by five times.** The
  baseline reads 34.0 ms for 50 ticks of 500 miners and 500 chests against
  7.5 ms for 1,000 belt tiles — about 1.3 µs per miner-tick against 0.15 µs
  per belt-tick. §19 rule 20 says profile before optimising, and this *is* the
  profiling; acting on it is C28's, which is the chunk that owns §12's budgets
  and a profiler that can say where inside a miner's tick the time goes.
- **The RNG has no consumer.** It is §6 R2's named artifact and C18 task 1 asks
  for it, and it is honestly an abstraction ahead of its use — the narrowest
  the plan permits, and C19 is the chunk that uses it. If C19 slips, this is
  the thing to re-read rule 10 about.
- **§6 R8's save round-trip is still C24's.** C18 proves the simulation is
  deterministic; it cannot prove a save carries everything, because it does not
  go through a save. The hash is built so that C24's test can compare a loaded
  world against it directly.
- **The determinism suite costs about 8 seconds**, most of the whole test run.
  That is 10,000 ticks run fourteen times, and it is the price of the gate
  being real. If it becomes a problem the answer is a shorter default with the
  full run behind a flag, not a smaller factory.

---

## C19 — Procedural world generation

**Goal.** New seeds make genuinely different runs. This is pillar 2.

**Depends on.** C18.

**Tasks.**
1. `generateChunk(seed, cx, cy)` — **pure and positional**. Generating world
   chunk (5,5) must give the same result whether it is the first or thousandth
   generated. Derive a per-chunk stream: `createRng(hash(seed, cx, cy))`.
2. Terrain: 2–3 octaves of value noise for elevation and moisture →
   grass / dirt / sand / stone / water. Hand-write the noise (~60 lines).
3. Resource patches: a separate low-frequency noise per resource type, thresholded,
   with **per-patch variation in size, shape and richness**. Patch shape variety
   matters more for replayability than patch count — a long thin iron patch and a
   round one produce different factories.
4. Distance-based scaling: patches get richer and larger further from the origin,
   giving expansion a payoff.
5. **Starting-area validation** — the generator must guarantee a playable start:
   ```text
   within 30 tiles of spawn:  >= 1 iron patch of >= 20 tiles
                              >= 1 copper patch of >= 15 tiles
                              >= 1 coal patch of >= 15 tiles
                              >= 1 stone patch of >= 10 tiles
                              >= 400 contiguous buildable land tiles
                              spawn tile itself buildable and not water-locked
   ```
   If validation fails, perturb the seed deterministically (`seed + 1`) and retry,
   up to 64 times. Never hand the player an unplayable world.
6. `generatorVersion` constant, written into saves (§14).
7. A dev tool: render a seed's 64×64-chunk overview as a minimap image, so seeds
   can be eyeballed during tuning.

**Acceptance.**
- The same seed produces byte-identical worlds, regardless of exploration order.
- 100 random seeds all pass starting-area validation within the retry budget.
- 20 seeds inspected by eye produce visibly different resource layouts.
- Generating 40×40 world chunks takes < 500 ms.

**Tests.** Positional purity (generate in shuffled order, compare); validation
over 100 seeds; determinism across the save round-trip; performance benchmark.

**Out of scope.** Biomes with gameplay effects, rivers, cliffs as pathing
obstacles, decorative props.

**Decisions taken while implementing this chunk.**

- **Patches come from a jittered grid, not from a thresholded noise field**
  (task 3). A noise field has no notion of a *patch*, so it cannot vary
  anything per patch — every blob it produces has the same size distribution
  and the same roundness, and richness could only be a function of position
  rather than of the deposit. Task 3's own next sentence is that per-patch
  variation in size, shape and richness matters more than patch count, so the
  grid is what the task actually asks for: one cell of one resource's grid
  holds at most one deposit, whose position, radius, aspect, orientation and
  richness all come off a stream seeded by `hash3(seed, cellX, cellY,
  resource)`. The low-frequency noise the task names is still here, doing the
  two jobs it is good at — roughening each deposit's edge so it does not read
  as an ellipse, and deciding **how many** deposits a region holds.
- **The density field is the fix for a map that was confetti.** Without it
  every cell is an independent coin flip and all four ores are evenly
  interleaved everywhere: no direction is worth walking in and no piece of
  ground is worth more than any other, which fails pillar 4 on a map that
  technically satisfies every other criterion. With it the map has iron
  country and copper country, and the good spots are the seams. It is also
  what makes starting-area validation worth having rather than a formality —
  a spawn that passes it is a spawn on one of those seams.
- **Distance buys size and richness, and costs count.** Task 4 asks for
  patches that get richer and larger further out. They do — 1.4× the radius
  and 2× the peak at 1,024 tiles — and they also get *rarer*, by a factor of
  about three. Measured: 15% ore coverage at the origin with a mean of 164
  units a tile, against 8% at a thousand tiles with a mean of 286. The total
  ore under a distant square mile is about what it is at home, concentrated
  into a third as many places, which is what makes the far patch worth a long
  belt run: there is not another one behind it. It also keeps the starting
  area dense enough for task 5's guarantees to be reachable without making
  the whole world a sprinkle of ore.
- **Peak richness is capped at exactly 2× nominal**, because C09 fixed the
  four ore-pile fullness buckets to an absolute scale and asked C19 to revisit
  that "if patch richness ends up varying by more than about 2x". It does not,
  and a test pins it. The alternative — a second `Uint16Array` per world chunk
  recording each tile's original amount — is 2 KB per world chunk and a field
  in every save, to answer a question only ever asked about a pixel.
- **Spawn moved to the origin** from C06's (6, 6). The distance scaling is
  measured from the origin, so spawning anywhere else would put the player on
  ore already richer than the generator's own baseline.
- **A "patch of ≥20 tiles" is measured by flood fill, not by counting tiles.**
  Twenty iron tiles scattered as four five-tile slivers is not a patch a 2×2
  miner can stand on. The validator counts connected four-neighbour regions.
- **`createStartingWorld` throws when all 64 seeds fail**, rather than handing
  back the last one. "Never hand the player an unplayable world" has only two
  honest implementations, and silently returning attempt 64 is neither. It
  also reports the seed it settled on — the debug overlay shows it — because a
  perturbed seed the player is not told about is a bug report about a world
  with no iron in it.
- **`NoiseField` offsets its own origin, derived from the seed.** Tile (0, 0)
  sits exactly on a lattice corner of every octave, so an unoffset field
  returns a raw uninterpolated hash there — *uniformly* distributed, where
  every other tile in the world is the bell-shaped average of four. The spawn
  tile was therefore the one tile that did not obey the generator's own
  terrain distribution, and it showed: a third of all seeds put the player in
  a lake against a global water coverage of an eighth, and every ore cell near
  the origin shared one density value, making a starting area all-or-nothing
  per resource. Validation pass rate went from 14% to 21% on that fix alone,
  and to 47% after retuning. Found by a test, not by eye.
- **No `Math.sin`, `Math.cos` or `Math.pow` anywhere in the generator.** They
  are not exactly specified by IEEE-754, so two engines may disagree in the
  last bit and hand two players subtly different coastlines from the same
  seed — a determinism failure that would surface months later as a save that
  fails to reload identically. `Math.sqrt` is correctly rounded and is used
  instead: a patch's orientation is a normalised random vector, never an
  angle.
- **C02's checkerboard and C09's four hand-placed discs moved to
  `tests/fixtures/world-fixtures.ts`** rather than being deleted. Both chunks
  said C19 would delete them, and it has — from `src/`. A test of the build
  system or the terrain layer wants a world it can state facts about ("the
  pond is at (14, 3)"), and a procedurally generated one cannot offer that
  without pinning a seed and re-pinning it on every tuning pass.
- **A dev tool, not a dev page** (task 7). `npm run minimap` writes a PNG —
  one seed, or a contact sheet of twenty — and prints the terrain histogram
  and the starting-area report beside it. `tools/` runs under Node with
  `--experimental-transform-types` and a twenty-line resolver hook, because
  `src/**` imports `./thing.js` the way the module specification wants and
  Node will not resolve that to a `.ts` file. The alternative was a dependency
  (`tsx`) for twenty lines of work, which §3's policy exists to refuse.

**Deviations.**

- **Task 3's "thresholded noise" became a jittered grid plus two noise
  fields.** See the first decision above. The plan's stated *goal* for the
  task — per-patch variation in size, shape and richness — is met more
  directly this way than the mechanism it suggested could have met it.
- **Balance numbers are provisional and belong to C20.** Terrain thresholds,
  patch densities, radii, richness and the distance curve are all tuned to
  "different every seed, playable at the start", which is C19's bar. Water
  averages 13% of tiles and varies from 8% to 23% across seeds; ore covers
  about 15% of the starting area. Whether that is *fun* is the next chunk's
  question, and it is asked at the stop-and-tune gate rather than here.

**Acceptance, as verified.**

- *The same seed produces byte-identical worlds, regardless of exploration
  order.* Pass — a generator walks a thousand world chunks before reaching
  (5, 5) and matches one that goes straight there; a shuffled 7×7 exploration
  matches a row-major one; two `Simulation`s exploring in opposite directions
  hash identically under C18's state hash.
- *100 random seeds all pass starting-area validation within the retry
  budget.* Pass — 100 widely spread seeds, mean 2.25 attempts, worst well
  inside half the budget. Measured separately: 47% of raw seeds pass
  unperturbed, so exhausting all 64 has probability around 10⁻¹⁶.
- *20 seeds inspected by eye produce visibly different resource layouts.*
  Pass — `npm run minimap -- --seed=7000 --count=20 --chunks=8`. Lake-locked
  spawns, stone plateaus, copper-heavy country and near-barren ground all
  appear in the twenty.
- *Generating 40×40 world chunks takes < 500 ms.* Pass — **304 ms** mean,
  319 ms worst, over five iterations (`npm run bench`, case
  `worldgen-40x40`). One world chunk costs 0.20 ms; a validated starting
  world, seed retries included, costs 7.6 ms.

**Noticed, not fixed.**

- **§11's `--if-iron` (`#7d94ad`) and `--if-stone` (`#9aa3ad`) are hard to
  tell apart**, and iron ore on stone terrain (`#55606e`) is low contrast.
  Invisible while the only ore was four hand-placed discs; obvious on a
  generated map. It is a §11 decision, so C20's balance pass or C29's art
  pass owns it.
- **`npm run bench:baseline` rewrites every baseline**, so adding a benchmark
  file forces the unrelated committed numbers to be restored by hand or
  silently replaced with numbers from a different machine. The C18 baselines
  were restored from git for this commit. Scoping the write is a one-flag
  change and belongs to C28.
- **A frame at minimum zoom costs ~10.5 ms with nothing built**, composing 96
  cached terrain bitmaps. Not a regression — the same 96 bitmaps were
  composed before — but it is the first time the number has been looked at,
  and it is C29's.

---

## C20 — Content & balance pass  ⛔ **STOP-AND-TUNE GATE**

**Goal.** Make it *fun*. Add no new systems in this chunk.

**Depends on.** C19.

This chunk exists because the failure mode of an agent-built game is infinite
infrastructure and no game. **Adding systems is forbidden here.**

**Tasks.**
1. Fill out the content bible in §15 to its v1 target: 11 buildings, 13 items,
   20 recipes.
2. Play the game for at least 60 minutes of real time. Write down every moment of
   friction and every moment of satisfaction.
3. Tune rates so the ratios in §15 hold and the early game is neither a grind nor
   trivially fast. Target: first automated plate within **10 minutes** of a new
   game; first assembler within **25 minutes**.
4. Fix the top five friction points found in play.
5. Add quality-of-life that play revealed as necessary: belt drag-build refinement,
   copy-settings (shift-click a machine to copy its recipe), an "alt mode" overlay
   showing what each machine makes, and clear stall alerts.

**Acceptance — answer honestly, in writing, in the chunk report:**
- Can the player automate something within 10 minutes of starting?
- Is improving throughput satisfying rather than fiddly?
- Does at least one stall force a layout change rather than a number tweak?
- Do two different seeds produce two different factories?
- **Would you start another run?**

> If two or more answers are weak, **stay in C20**. Do not proceed to C21.
> Adding power and research to a factory loop that is not yet fun makes a bigger
> game that is still not fun.

**Tests.** Balance assertions as tests: a reference 10-machine factory produces a
known items/minute within tolerance. These fail loudly when a rate is tweaked
without re-deriving the ratios.

**Out of scope.** Everything that is not tuning.

**Decisions taken while implementing this chunk.**

- **The building recipes are the whole chunk.** Task 1 says "fill out the
  content bible", and the thing that was actually missing was not a row in a
  table: it was that a `chest` was a string in a second bag the player carried
  beside their real inventory, because no item table had ever heard of it. C08
  recorded that as a deviation, C16 said it would fix it and did not, and until
  it was fixed **no building in the game could be made by the game**. Twenty
  chunks of factory and the only source of a belt was a kit `main.ts` handed
  out at boot. Seven building items, seven building recipes and a merged
  inventory later, `tests/integration/factory-builds-itself.test.ts` runs ore
  into an assembler and takes a placeable chest out of the other end. That is
  §15's "the factory eventually builds itself", and it is the pillar-1 moment
  the plan promised.

- **`ItemCounts` is deleted; `items/build-materials.ts` replaces it.** A build
  cost is authored as `{ itemId: 'chest' }` because that is how a human writes
  content, and an inventory counts in the numeric ids a hot loop compares. One
  file translates, with the surface the build system and the controller already
  spoke, and it owns nothing: every count comes from the player's one bag.

- **The player's bag can now be full, and that is the point.** Thirty slots
  hold ore, plates and buildings together. Two consequences were decided rather
  than inherited: a **demolition is refused** when the refund will not fit,
  because §7's rule is that nothing is silently deleted (the same rule C16's
  `setRecipe` follows); and a player who fills their bag with plates has to put
  them somewhere before they can carry a hundred belts, which is what makes a
  chest something to want rather than something to have.

- **The starting kit shrank by about three quarters**, to 2 miners, 40 belts,
  6 inserters, 2 furnaces, 1 assembler and 4 chests — and **no splitter**,
  because the splitter is the one building whose recipe needs a circuit and
  C17's layout puzzle is worth more built than given. Every chunk from C13 to
  C17 grew that list because a building the player could not make had to be
  given; with recipes it becomes a decision about the first five minutes
  instead.

- **A machine's input buffer is takeable by the player and still not by an
  inserter.** C15 built the port split so a furnace between two inserters could
  not become a place items shuffle back and forth in, and that rule is
  untouched — `InserterSystem` asks `outputPortOf` and only ever will. What C15
  did not intend is that the rule also caught the *player*, who is standing in
  front of the machine with their hand in it. `handSourceOf` is the second
  question, asked by the hand alone, and the INPUT section's rows grew TAKE
  buttons. Closes C15's and C16's notes.

- **`MachineStatus` gained an eighth member, `NoDestination`.** The enum was
  meant to be complete on day one and this is the one it was missing: seven of
  them answer "why has this machine stopped" and the eighth answers "it has not
  stopped, it was never going to start". An inserter aimed at a splitter, at a
  miner or at bare ground used to report `OutputFull` — a condition that clears
  itself, and never did. Appending is safe; no existing number moves.

- **Two new alerts, and only two.** The rule, written into `views/alert.ts`, is
  that an alert is earned when the player has to *do* something and the
  condition will not clear on its own: `no_destination` ("turn it round") and
  `no_recipe` ("you never told it what to make"). `output_full` gets nothing,
  deliberately — it is what a working factory looks like the moment a chest
  fills, and a toast every time would train the player to ignore the corner of
  the screen the important ones appear in.

- **The rate window is a range, not a number.** C15 and C16 both filed the same
  complaint and both deferred it here: at 300 ticks a plate furnace has three
  items in its window and reads 12/min, then 24, then 18, while doing exactly
  the same thing. The window now runs from 300 ticks to 900 and widens until it
  holds five items — which is precisely where C12 drew its line without saying
  so, since a miner puts five items in ten seconds. Miners, inserters, belts
  and assemblers keep C12's window and C12's responsiveness untouched; the
  furnaces widen. The first attempt trimmed to "the shortest span holding five
  items" and read 14% high, because a window whose edge is chosen by looking at
  the items always ends just after one; it is two fixed spans instead.

- **Alt mode is a toggle, not a hold.** The genre holds the key and a browser
  cannot honour that: `Alt` belongs to the window manager on two platforms, and
  a key held while the pointer leaves the canvas is never seen released — so a
  held alt mode would stick on. Bound to both alts and to `V`.

- **Copy-settings is shift-right to copy, shift-left to paste**, the genre's
  split. Copying a machine that is making *nothing* copies null and pasting it
  clears the destination, which is the only way to stop a row of assemblers
  without opening every panel; a copy click that hits bare ground leaves the
  clipboard alone.

**Deviations.**

- **The v1 content target is not met, and cannot be without breaking the
  chunk's own rule.** §15 wants 11 buildings, 13 materials and 20 recipes; C20
  ships 7, 11 and 14. The remainder are gated on systems C20 is forbidden to
  add:

  ```text
               §15 v1   C20 ships   waiting on
  buildings        11           7   generator, power_pole (C21), lab (C22), radar (C23)
  materials        13          11   frame, data_core (C22's lab consumes them)
  recipes          20          14   4 building recipes, make_frame, make_data_core
  ```

  This is the rule `data/items.ts` has followed since C08: content no building
  in the game can produce or consume is a row no test can tell is wrong.
  `tests/balance/content.test.ts` asserts the three counts, so the day C21 adds
  a generator the test fails and points the reader at the table.

- **Hand-crafting is not implemented.** §15 lists five hand-craftable buildings
  "so a new game is never soft-locked". It is a system — a craft queue, a
  command, a readout — and is therefore out of scope here. The soft-lock is
  unreachable anyway: the kit contains an assembler, demolition refunds in
  full, and the recipe graph is provably closed over the raw resources. §15 now
  says so. **This is the single most consequential thing C20 did not do**; see
  the acceptance answers.

- **Task 3's two time targets are met by a factor of twenty, which means they
  were measuring something else.** `tests/balance/first-factory.test.ts` plays
  a real new game on four generated seeds — a bot that walks on the game's own
  legs and places every building through a validated `build` command — and
  reaches its first automated plate in **22–35 simulated seconds**, not ten
  minutes. The targets assumed an opening spent hand-crafting the first miner.
  Rather than nudge a number, the milestone was re-derived: the test now also
  measures **the first building the factory made for itself**, which is the
  thing C20's recipes created and which lands at **58–71 seconds**. Both
  numbers are asserted as ceilings with room in them, and the *floor* is
  asserted too — under three minutes — so that a later chunk lengthening the
  opening has to mean to.

- **Adding a building now takes two content rows, not one.** C06's acceptance
  was "zero code changes elsewhere", and that still holds: a building needs an
  entry in `data/buildings.ts`, an entry in `data/items.ts`, a recipe and a
  palette token, none of which is code. The alternative — deriving the item
  from the building definition — would have put a buildings-to-items dependency
  in the registry layer and made item ids depend on building order, which is
  exactly what the persisted id mapping exists to prevent. A test asserts the
  correspondence in both directions instead.

- **`tests/balance/` is a fourth test directory.** §17 names unit, integration
  and determinism. These are simulation tests by every mechanical measure and
  run in the same project; what makes them worth separating is *what a failure
  means* — a balance test that goes red is a content decision to re-derive, not
  a defect to fix.

- **Belt drag-build was not refined.** Task 5 names it and this pass found
  nothing in it to fix: C13 implemented task 7 in full, and the rejection
  spam a drag across occupied tiles produces is bounded by `MAX_TOASTS` and was
  a **deliberate** C07 decision ("collapsing repeats into ×3 would make a fast
  drag look like one event when it was thirty"). What the pass found instead is
  that `rotate` has been in §7's command union since C04 and **has no
  implementation at all** — so a belt laid the wrong way must be demolished and
  rebuilt. That is the real friction, it is a new command arm, and it is
  recorded below rather than smuggled in here.

**Acceptance — answered honestly, in writing.**

- **Can the player automate something within 10 minutes of starting?**
  Yes, in about thirty seconds, measured on four seeds. That is the *wrong
  side* of the target: the early game is closer to "trivially fast" than to a
  grind, and it is because the starting kit is a working factory in a bag. The
  fix is hand-crafting — earn the first miner rather than be handed it — and
  that is a system, so it is C21+'s. **Weak.**

- **Is improving throughput satisfying rather than fiddly?**
  Yes, and more so than before this chunk. The measurable reason is the sixth
  derived ratio: a gear assembler eats exactly one inserter's throughput, so
  the obvious build runs at 89% and the fix is a second inserter rather than a
  bigger number. That is a layout decision with a visible payoff, which is what
  the pillar asks for. The alt-mode overlay is what makes it *findable* — the
  question "which of these forty furnaces is on copper" could not be asked
  before it. **Strong.**

- **Does at least one stall force a layout change rather than a number tweak?**
  Yes, and it is asserted: the reference factory's four furnaces feed an
  assembler that wants 3.2 of them, the surplus fills the assembler's buffer,
  the belt fills behind it and the furnaces stop with a full output. Nothing
  can be tuned to fix that — the consumer has to be widened or the producer
  narrowed. **Strong.**

- **Do two different seeds produce two different factories?**
  Yes. The four seeds the opening test plays put the nearest solid iron between
  5 and 19 tiles from spawn and the nearest coal between 9 and 16, in different
  directions, and one of them puts the coal across an inlet the first
  greedy-walking bot could not get round. The factories those starts produce
  differ in shape, not only in coordinates. **Strong.**

- **Would you start another run?**
  Yes — and the honest reason is that C20 is the first chunk where a run has
  somewhere to go. Before it, the loop ended at "a chest fills with gears";
  after it, the loop ends at "the factory is making its own belts and the
  question is how many". What would make the *second* run different from the
  first is the thing that is missing: the opening is identical every time
  because the kit is identical every time. **Adequate, with the opening as the
  known weakness.**

> **Gate decision.** One weak answer, four strong-to-adequate. The rule is
> "stay in C20 if two or more are weak", so C21 is open. The weak one is a
> single, named, well-understood thing — the opening is given rather than
> earned — and its fix is a system, which is precisely what C20 may not add.
> It is carried forward as the first item below.

**Tests.** `tests/balance/` is C20's, and it is three files.

- `content.test.ts` — the content bible checked against itself: every building
  is a registered item and every building item is placeable, in the same order;
  every non-raw item is made by exactly one recipe; the recipe graph is closed
  over the raw resources, so nothing in the game is unreachable; and the three
  v1 counts, so the day a system lands the table's shortfall is a failing test
  rather than a comment.
- `ratios.test.ts` — §15's five derived ratios plus C20's sixth, computed from
  the content tables rather than written down; then the **reference factory**,
  which is C20's "10-machine factory producing a known items/minute": four
  miners, four furnaces, an assembler and a chest, wired with twelve inserters
  and a sixteen-tile belt, making **exactly 30 gears a minute** over ten
  measured simulated minutes after a five-minute warm-up. It also asserts the
  backpressure that surplus causes, because the stall is the design.
- `first-factory.test.ts` — the opening, played. Four generated seeds, a bot
  that routes breadth-first over walkable tiles and walks with `movePlayer`
  commands, every building placed through a validated `build`. Both milestones
  timed; both ceilings and one floor asserted.

Elsewhere: `factory-builds-itself.test.ts` is the pillar-1 chain end to end,
including the player taking a crafted chest out and placing it, and the full
bag refusing a demolition; `alt-mode.test.ts` covers what the overlay labels
and — the one a later chunk could break silently — what it does not;
`stall-alerts.test.ts` covers the two new alerts, the one that deliberately
gets none, and the hand-versus-inserter split on a machine's input buffer;
`production-rate.test.ts` gained the slow-machine and fast-machine window
cases; `inserter-system.test.ts` now asserts `no_destination` where it used to
assert a lying `output_full`.

**Noticed, not fixed.**

- **The opening is given, not earned, and that is C20's one weak acceptance
  answer.** Without hand-crafting the starting kit *has* to contain a working
  factory, so the first automated plate costs a walk and four clicks. The whole
  of the fix is one system — a craft queue and a `craftItem` command — and
  §15 already specifies exactly which five buildings it covers. Whichever chunk
  takes it should re-run `tests/balance/first-factory.test.ts`, whose floor
  assertion exists to make that change visible.
  **C21A built the system and stopped there.** The queue, the command and the
  panel exist; the starting kit is untouched, so `first-factory.test.ts` still
  passes unchanged and this answer is still weak. What is left is a content
  change and two re-derived numbers — see C21A's "Noticed, not fixed".
- **`rotate` is in §7's command union and has no implementation.** Declared in
  C04, never built, and nothing produces it — so a belt, an inserter or a
  miner placed facing the wrong way can only be demolished and rebuilt. It is
  the most-felt missing interaction in the game and it is what "belt drag-build
  refinement" would actually be built on: a drag crossing a belt that faces the
  wrong way should re-aim it. The work is a `BuildSystem.rotate` plus a
  decision about the one building whose footprint changes shape with rotation
  (the 1×2 splitter) and about what happens to items on a belt that turns.
- **`steel` has no consumer.** `smelt_steel` makes it, nothing spends it, and
  the recipe that would — `make_frame` — belongs to C22's lab. A player can
  smelt it and has nothing to do with it. `content.test.ts` carries it as a
  named exception and fails when that stops being true, so the exception cannot
  rot.
- **A demolished building's *contents* are still lost.** C20 made the refund
  honest — a full bag refuses the removal rather than voiding it — but a chest
  full of plates still goes with the chest. That is a bigger decision than a
  refund (where do fifty plates go when the bag holds thirty?) and belongs with
  whatever chunk gives the player somewhere to put them.
- **The alt-mode badge is drawn per machine per frame, unculled.** It walks the
  whole entity store and allocates one object per labelled machine, which is
  the shape `describeEntities` already has and the same answer applies: C28
  measures it, C29 makes it incremental. It only runs while the mode is on.
- **The reference factory is refuelled by hand, once a minute.** Fifty coal is
  400 simulated seconds and the measurement is fifteen minutes, so a fuel belt
  would be a second chain between the measurement and the thing measured. It is
  a seam a later chunk could close by feeding it from a coal miner, and C21's
  generator will want the same fixture.
- **`ProductionRate` now keeps up to 900 samples in two arrays**, up from 300,
  and still drops the oldest with `shift()`. C12 called that "nothing" at 301
  and it is three times nothing now; a ring buffer is still more code than it
  saves until a profiler says otherwise (§19 rule 20).
- **A machine that stops takes up to thirty seconds to read zero** if it was
  slow enough to earn the wide window. The status says "stalled" immediately
  and the rate is a different question, but it is a real consequence of the
  window change and worth knowing before C28 measures anything against a rate.

---

## C21 — Power

**Goal.** A resource that constrains layout rather than adding arithmetic.

**Depends on.** C20 (and only after C20's gate passes).

**Tasks.**
1. `power-system.ts`, phase 2 — first, so every machine sees one consistent ratio.
2. Entities: **generator** (burns coal, 900 kW), **power pole** (connects, with a
   supply area and a wire reach). Machines gain `powerConsumption` kW; generators
   gain `powerProduction` kW.
3. Networks by connected components over pole adjacency, rebuilt **incrementally**
   on pole/generator/machine add-remove — a full rebuild per tick is a needless
   O(n) cost, and the network is derived state (§10), rebuilt on load.
4. Satisfaction ratio = `min(1, supply / demand)`, applied uniformly:
   a machine at 60% satisfaction advances 0.6 ticks-worth of progress. Because
   progress is integer (§6 R3), accumulate a **fixed-point** progress numerator
   rather than a float.
5. Status `no_power` and a distinct `low_power` (< 100% satisfaction) with a
   visible HUD indicator, per the reference sheet's power icon.
6. Electric miner and electric furnace variants unlocked by research, giving a
   real choice: fuel logistics vs. power infrastructure.

**Acceptance.**
- Machines outside a network do not run and say so.
- Under-supply slows every machine on the network equally and visibly.
- Adding a generator restores full speed within one tick.
- Network rebuild after loading a 20,000-entity save takes < 100 ms.
- Power satisfaction never produces a float in authoritative state.

**Tests.** Connected-component correctness including disjoint networks; ratio
application in fixed point; incremental rebuild equals full rebuild; determinism
of partial satisfaction.

**Out of scope.** Accumulators, brownout priority, transformers, realistic
electrical simulation.

### What C21 shipped, and where it departs from the tasks above

Five departures. Three are refinements of a task; two are scope, and both are
recorded in §15 as well because they move the content table.

**1. The satisfaction ratio has no stored numerator (task 4).** The task asks
for "a fixed-point progress numerator rather than a float", and the shipped
answer is the same arithmetic with nothing to store. A machine at 60% must
advance 0.6 ticks of progress per tick; since progress is integer (§6 R3), that
means working on 60% of the ticks, and *which* ticks is a Bresenham step over
the tick counter:

```text
works this tick  <=>  floor(t * sat / SCALE) > floor((t-1) * sat / SCALE)
```

The long-run rate is exact, every machine on a network skips the same ticks —
which is the second acceptance criterion taken literally rather than
approximately — and because the tick counter *is* saved, a world reloaded
mid-brownout resumes on the same schedule (§6 R8). An accumulator per machine
would have been a new field on three entity shapes and a new way for a save to
be subtly wrong. `SCALE` is 1000; the whole of power's contact with fractions
is that constant.

**2. "Incrementally" means the poles, not the machines (task 3).** The task
forbids a full rebuild per tick and the shipped system is stronger than that:
the pole graph is rebuilt only when the **set of poles** changes, and
consumers and generators are not indexed at all — they look their network up
from the coverage map on the same pass that has to sum them anyway. So adding
a belt, a machine or a generator costs nothing, and the cost of any change is
proportional to the poles rather than to the entities. The once-per-tick work
is a comparison of the live pole ids against the ones the graph was built from:
a few hundred integer comparisons, chosen over a change feed because a
bookkeeping hook missed on one code path would leave a network quietly wrong
for the rest of a session. `PowerSystem.rebuild()` is the full path, it is what
a load will call, and a test asserts the two agree after a session of building
and demolishing.

**3. Fuel follows the load.** Not in the task list, and it is the difference
between a generator being a tool and a tax. Supply is the capacity of every
generator that *could* run; fuel is then spent at `demand / supply`, by the
same Bresenham step. A 900 kW generator over a network asking for 150 kW burns
a sixth of its 0.75 coal/s — which is what makes an electric furnace cost
exactly the coal a burner furnace would at **any** load, not only at a full
one. Without it the smallest worthwhile power plant would be six furnaces
wide. It is not an accumulator: an item already alight is never put out, and
nothing is banked.

**4. The power column is charged only from `power_1` onward (task 2).** §15's
table gives the miner 90 kW, the inserter 13 kW and the assembler 150 kW, and
the tech tree in the same section unlocks the assembler two tiers before the
generator. Charging them would make the first four technologies unplayable.
C21 charges the electric furnace and leaves the other three free; reconciling
the column with the tree is C22's, because C22 owns the tree. §15 carries the
full argument.

**5. No electric miner (task 6).** The tier-1 miner burns nothing, so an
electric variant of it is not "fuel logistics vs. power infrastructure" — it is
the same miner with a bill, or a faster one, and either way a number rather
than a decision. The electric *furnace* is the whole of task 6's choice and it
is exact: 150 kW is `FUEL_REFERENCE_KW`, so what the player buys with the poles
and the generator is one coal line instead of six, at identical coal. §15 says
which chunk the miner belongs to.

**Also worth knowing.**

- A pole's **wire reach is a radius and its supply area is a square**, and the
  gap between eight and five is the layout puzzle: a line of poles laid at the
  edge of its reach leaves unpowered gaps. Distances are compared squared, so
  there is no float anywhere in the graph.
- Everything joins the network of the **lowest-id pole** covering any tile of
  its footprint (§6 R6). With the shipped numbers two poles whose squares
  overlap are always already wired together, so the tie-break is unreachable
  from content — it is tested against a one-tile-reach pole, because the rule
  has to hold whatever the content says.
- **Demand is what is built, not what is running.** A machine draws its rating
  even while starved. The alternative is circular — whether a machine runs is
  decided in phases 3 and 4 out of a ratio phase 2 has already had to produce
  — and it is also the wrong game: a power budget the player can read off what
  they have built is something to plan against.
- A generator with fuel and no pole reports **`no_power`**, the same word its
  machines use, and raises the same `no_power_network` alert. `low_power` gets
  no toast: it is a working factory that has outgrown its generators, and the
  HUD's power tile carries it continuously instead.
- The acceptance criterion about a 20,000-entity save is measured as what a
  load actually costs this system — one full rebuild — since C24 is what will
  load one. It runs in single-digit milliseconds with a thousand poles.

**What it cost, measured.** C21 is the first chunk to put work in front of
*every machine in the factory*, so the benchmarks were run before and after and
the difference chased down. The first honest number was **+40% on a
thousand-furnace tick**, and none of it was the power phase — which costs
0.2 µs a tick with no poles in the world. It was two things, both now fixed and
both worth knowing about:

- `generatorPort` was a second object shape implementing the same interface as
  `containerPort`, and `production-system.ts` reads three ports per machine per
  tick. §16 now carries the rule.
- Reading `PowerGate` at all on the path of a machine that burns fuel. The
  whole gate now lives inside `if (electric)`, so a furnace never touches the
  power system or its enum.

What is left is **~3%**, measured A/B on one machine in one sitting, which is
what a phase and a per-machine branch ought to cost. The committed baselines in
`tests/bench/baseline/` were recorded on a different day and are not a
like-for-like comparison — three of the six read *faster* than them now — so
they were left alone rather than rewritten to match; C28 owns the profiler and
the re-baselining.

---

## C21A — Inventory panel & hand-crafting

**Goal.** The player can see what they are carrying, and turn it into something.

**Depends on.** C12, C20, C21.

**Why it exists, and why it is not numbered C22.** It is not in the original
chunk list. It is two pieces of work the plan had already committed to and
never scheduled, and they arrived together because a player asked for them in
the same sentence:

- §13's structure diagram has listed an **`InventoryPanel`** since revision 1.
  C10 noted its absence in as many words — "**No inventory panel.** §13 lists
  one and C10 does not schedule it" — and deferred it to C12's inspector,
  which then built a panel for *machines* and left the player's own bag with a
  single total in the corner of the HUD. Twelve chunks later, mining something
  by hand still put it somewhere the player could not look at.
- **Hand-crafting** is C20's single weak acceptance answer and the first item
  in its "Noticed, not fixed": *"The opening is given, not earned… The whole of
  the fix is one system — a craft queue and a `craftItem` command — and §15
  already specifies exactly which five buildings it covers."*

It is lettered rather than numbered because C22–C30 are a planned sequence with
dependencies on each other, and renumbering nine chunks to insert one would
make every existing cross-reference in this document wrong.

**Tasks.**
1. `handCraftable` on `RecipeDefinition`: §15's hand-craft list as a column of
   the content table, not a list in a system. `RecipeRegistry.handCraftable()`
   indexes it; a hand-craftable **smelting** recipe is refused at registry
   build, because smelting is what a furnace is for.
2. `CraftDurations.handTicksFor(recipe)`: the recipe's duration at
   `HAND_CRAFTING_SPEED`, rounded once at startup (§6 R3) exactly as the
   per-machine table is.
3. `craftItem` and `cancelCraft` on §7's command union; `PlayerState.crafts`,
   an ordered queue of `CraftOrder`, serialized with the player.
4. `systems/crafting-system.ts`, phase 8. Ingredients leave the bag when the
   order is **queued**; one order is worked at a time; a finished craft with
   nowhere to go parks at its finish line and raises one alert.
5. `views/inventory-view.ts` and `GameController.getInventoryView()`: the bag,
   the craft options with what the bag holds against each bill, and the queue.
6. `ui/inventory.ts` — §13's `InventoryPanel`. Built once from content, three
   ways in: `I`/`E`, the toolbar's BAG button, and the HUD's ITEMS tile.

**Acceptance.**
- Mining an ore puts a row on screen that names it and counts it. *(Met.)*
- A hand-craft takes exactly `durationTicks / HAND_CRAFTING_SPEED` ticks,
  rounded once, and is identical at 10 fps and 144 fps. *(Met — it is a phase-8
  system counting integers, and the test asserts the exact tick.)*
- Cancelling returns every ingredient, including the craft in progress.
  *(Met, and it is refused rather than partial when the bag has no room.)*
- Nothing the panel does reaches the simulation except through a command.
  *(Met — `tests/unit/ui-boundary.test.ts` covers the file like every other.)*
- No panel rebuilds its subtree on update. *(Met — checked with a real
  `MutationObserver`, the same bar C07 set.)*

**Decisions.**

- **`HAND_CRAFTING_SPEED` is 0.5 — the same as a tier-1 assembler.** The
  genre's usual answer is the opposite: hand-crafting *faster* than the first
  machine, so early automation is a sacrifice. It is rejected here for the
  reason C20's report names. The opening is the weak part of this game and it
  is weak because nothing in it costs time; making the hand exactly as fast as
  the machine means the assembler's whole value is **automation**, which is
  pillar 1 stated as a number.
- **Ingredients are spent when the order is queued, not per item.** The
  alternative has a stalled state in it — an order whose ingredients were
  spent elsewhere sits in the queue doing nothing — and a silent stall is what
  pillar 3 forbids. Spending up front means an order in the queue is an order
  that *will* complete, and it puts `unaffordable` on the click rather than
  forty seconds into a batch. The cost is that cancelling must refund, and
  that refund is refused outright rather than made partial: nothing in this
  game is deleted to make an interaction convenient (C16's rule for
  `setRecipe`, one interaction over).
- **A finished craft with a full bag waits rather than vanishing.** Progress
  parks at the duration, the order stays at the head, one `craft_blocked`
  alert fires, and the item lands the tick a slot frees. It is C11's
  `output_full` one level down, and the queue row turns amber so the panel
  explains the bar that stopped (§13).
- **Repeated clicks merge into the tail order.** Ten presses make one order of
  ten, not ten of one — so `MAX_CRAFT_ORDERS` counts *kinds* of work rather
  than clicks, and the cap is unreachable by leaning on a button.
- **The panel takes the middle of the screen and closes the build menu.** It
  is the one panel the player stops to read, the two want the same space, and
  they answer the same question from opposite ends — "what can I build" and
  "what am I made of".

**Deviations.**

- **§15's hand-craft list does not survive contact, and the shipped set is
  eight rows rather than five.** §15 says `belt`, `chest`, `inserter`, `miner`,
  `furnace` "and the plates/gears they need". Taken literally that is a list
  that stops one ingredient short of its own entries: the inserter and the
  miner each want a **circuit**, so `make_wire` and `make_circuit` are in too,
  and `make_gear` is "the gears they need" said out loud. The **plates are
  not**, and cannot be — a plate is smelted, and `RecipeRegistry` now refuses
  a hand-craftable smelting recipe as a content error.
- **Hand-crafting therefore does not bootstrap a factory from nothing, and
  §15's soft-lock sentence is still carried by the starting kit.**
  `make_furnace` takes brick, brick is baked *in a furnace*, and the loop
  closes only because the player is given two. What hand-crafting removes is
  the dependence on the kit's **assembler**, which is the gate §15 actually
  cares about. This is written into `data/recipes.ts` beside the flag.
- **The opening was not re-tuned, and `first-factory.test.ts` still passes
  unchanged.** C20 asks whichever chunk takes hand-crafting to re-run it,
  "whose floor assertion exists to make that change visible". It was re-run and
  it is green — because the starting kit is untouched. The system is here; the
  *balance* decision to make the opening earn its first miner is a separate,
  deliberate change to `STARTING_MATERIALS`, and it belongs to whoever is
  willing to re-derive the milestone numbers with it. See "Noticed, not fixed".
- **Three new rejection reasons and one new alert.** `not_craftable`,
  `craft_queue_full` and `nothing_queued`; `craft_blocked`. The first is
  separate from `unknown_recipe` because "there is no such thing" and "your
  hands cannot make that" send the player to different places.
- **Phase 8 gained a second system and the phase table now names it.** §8's
  phase 8 read "movement, manual mining progress"; it is now "movement, manual
  mining and hand-crafting". Crafting runs **first** within the phase, so a
  craft that completes this tick is in the bag before a step of walking or a
  swing of the pick is judged against it.
- **The HUD's ITEMS tile became a button.** A `div` with `role="button"` and a
  tab stop rather than a `<button>`, because the tile is laid out by
  `.if-hud__tile` and its sibling-border rule, and swapping the element would
  put a second set of button defaults through that rule for one tile in eight.
- **The panel keeps its own copy of `TPS`.** §4 lets `ui/**` import the
  controller, the view models and plain command data — `simulation-clock.ts`
  is none of those. The view carries ticks, because ticks are what the
  simulation is exact in; the one division into seconds happens on the
  presentation side, and a test asserts the copy still agrees.

**Tests.**

- `tests/unit/crafting-system.test.ts` — the bargain the system makes with the
  bag: ingredients taken whole at queue time and nothing taken on a refusal;
  exact tick counts for one craft, for a batch and for the one recipe that
  makes two; orders worked one at a time in queue order; the merge; the cap;
  cancel refunding everything including the craft in progress, and refusing
  rather than voiding; the blocked craft that waits, warns once and lands when
  room appears; the queue in `toJSON` and the copy that stops a snapshot
  editing it; and the hand-craftable set asserted against §15's list, against
  the category rule and against the duration table.
- `tests/unit/inventory-panel.dom.test.ts` — the panel through the real
  `GameUI`: what the bag shows, the slot arithmetic, the full-bag warning, all
  three ways in, the build menu stepping aside, the repaint-on-open that works
  while paused, the craft grid's contents and greyed rows, click and
  shift-click going out as commands, the queue's bar on the head order only,
  the blocked row saying why, cancel refunding, and a `MutationObserver`
  proving no subtree is rebuilt.

**Noticed, not fixed.**

- **The opening is still given rather than earned.** The system that C20 said
  would fix it now exists; the *content* change that would use it does not.
  The kit still contains two miners, an assembler and six inserters, so the
  first thirty seconds of a run are unchanged. Whoever takes it should cut the
  kit to roughly "a furnace, some plates and a pick" and re-derive both
  milestones in `tests/balance/first-factory.test.ts`, whose floor assertion
  is there precisely to make the change visible. It is one content table and
  two numbers, and it is the last thing standing between C20's weak answer and
  a strong one.
- **`rotate` is still in §7's command union with no implementation.** C20
  named it as the most-felt missing interaction and it stayed that way here:
  this chunk touched the command union and deliberately did not widen its
  scope to a second unrelated system.
- **The craft queue has no save migration.** `SerializedPlayer.crafts` is new,
  so a save written before this chunk has no such field. Nothing loads a save
  yet — C24 owns that — but the field is the first piece of authoritative
  state added *after* a shipped shape existed, and C24's first migration is
  now a known one rather than a hypothetical.
- **A recipe that stops being hand-craftable strands its orders.** The system
  parks an order whose duration is `CANNOT_CRAFT` rather than deleting it, and
  `cancelCraft` still refunds it — so the player is never robbed, but the
  queue can hold something that will not move. It is unreachable without a
  content change between two versions, which is a save-migration problem and
  is C24's.

---

## C22 — Research & progression

**Goal.** Unlocks that create new problems, not bigger numbers.

**Depends on.** C21.

**Tasks.**
1. ```ts
   interface TechnologyDefinition {
     readonly id: string;
     readonly prerequisites: readonly string[];
     readonly cost: readonly ItemStack[];      // science items
     readonly durationTicks: number;
     readonly unlocks: readonly Unlock[];      // building | recipe | modifier
   }
   ```
2. A **lab** building consuming science items over time; `research-system.ts` in
   phase 7 advancing the active technology.
3. Science item: `data_core` = `1 gear + 1 copper_plate`, 2.5 s.
4. The v1 tech tree from §15. Every node must justify itself against the pillar-1
   test: *does this create a new decision?*
5. Research panel: tree layout, prerequisites, costs, current progress, and a
   queue. Locked buildings appear greyed in the build menu with their unlocking
   technology named — visible locks are motivating; invisible ones are confusing.
6. Unlock application is a pure function over research state so it is trivially
   rebuilt on load (derived, §10).

**Acceptance.**
- Prerequisites are enforced; an unreachable technology cannot be started.
- Completing a technology immediately makes its unlocks buildable.
- Research progress consumes science at the specified rate and pauses when starved.
- Unlock state after loading a save exactly matches the pre-save state.

**Tests.** Prerequisite graph validation (no cycles, no dangling ids — assert at
registry build); unlock application idempotence; research rate; save/load of
research state.

**Out of scope.** Infinite research, research productivity, branching exclusive
choices (a strong post-v1 replayability lever — note it, do not build it).

### What C22 shipped

**Acceptance, one by one.**

- Prerequisites are enforced; an unreachable technology cannot be started.
  *(Met. A prerequisite that is merely **queued ahead** counts, which is what
  makes the queue worth having — it is still enforced, because the
  prerequisite will be done first, and cancelling it takes the technologies
  that depended on it out with it.)*
- Completing a technology immediately makes its unlocks buildable. *(Met, and
  it is a property of the phase order rather than of a callback: the unlock is
  applied inside phase 7, so phase 8 and the next tick's phase 1 both see it.
  Asserted from both ends — a `checkPlacement` that answers `locked` and then
  `null`, and a recipe picker that gains a row.)*
- Research progress consumes science at the specified rate and pauses when
  starved. *(Met. One science item per research unit, taken when the unit
  starts; a starved lab reports `no_input` and carries on the tick something
  arrives.)*
- Unlock state after loading a save exactly matches the pre-save state.
  *(Half met, and the half that exists is the one C24 will build on: there is
  no save format yet, so the test round-trips `ResearchState` through its own
  `toJSON` and asserts the derived unlock tables come back identical from the
  restored state alone. The determinism hash gained a `research` root.)*

**Decisions.**

- **A technology is researched in *units*, and a unit is one of each item in
  its cost plus `durationTicks` of one lab's time.** So the count in §15's
  "automation_1 (10 data_core)" *is* the unit total, and the registry refuses a
  bill whose counts disagree — a bill of 10 of one pack and 20 of another would
  run out of the first halfway through with nothing to call the stall (§13). A
  second lab is a second unit in flight rather than a faster one, which is what
  keeps every rate in the system a whole number of items per lab per unit.
- **Every v1 technology takes five seconds a unit.** The cost is the lever
  (10 cores to 100) and the duration is the constant, so a lab's rate is
  something a player can hold in their head — twelve units a minute, always.
  It also lands §15's cleanest ratio without anyone choosing it: `make_data_core`
  is 2.5 s at a tier-1 assembler's speed 0.5, so **one assembler feeds exactly
  one lab**.
- **A research unit is anonymous.** A lab's `progressTicks` does not say which
  technology it is for; the unit lands on whatever is at the head of the queue
  when it finishes. Switching research mid-unit therefore costs nothing and
  loses no science, and a lab left running with an empty queue parks its
  part-finished unit until there is something to spend it on. A field naming
  the technology would have made both of those into stalls that had to be
  explained.
- **Progress is remembered per technology, not per session.** Cancel a
  half-researched technology, research something else, come back, and the units
  already paid for are still there. The alternative would make the queue a trap
  and would destroy science the player watched a lab consume.
- **Locked is the exception, not the rule.** `computeUnlocks` starts with every
  building and recipe available and turns off what an *unfinished* technology
  claims, so the tech tree is the whole lock list in one place and nothing in
  `data/buildings.ts` or `data/recipes.ts` says a word about research. A
  building unlock carries the recipe that makes its item with it, and the
  registry refuses a tree that claims that recipe separately.
- **A locked recipe is refused at the machine's *port*, not only at the
  system.** A furnace fed iron plates before `smelting_2` would otherwise
  quietly start making steel, and an inserter would silt it up with an
  ingredient for a recipe it may not run — C14 task 6's failure. `RecipeGate`
  is the narrow interface that carries the answer into `RecipeRegistry`'s two
  selection questions.
- **The lab is not a `MachineEntity`.** It makes no item, so it has no output
  buffer and nothing to hold when one is full; it burns nothing; and what it is
  working on is not its own. Three fields — an input buffer, a tick count and a
  status — are the whole of it.

**Deviations.**

- **§15's technology tree was re-derived, and four of its nine nodes are gone.**
  The full reasoning is in §15, which now carries the shipped tree. In short:
  research is entered through a building, so nothing on the path to the first
  technology may be behind a technology — which struck `electronics_1`
  (circuits are in the lab, the inserter and the miner), took `steel`'s
  companion `brick` off `smelting_2` (a furnace is twelve brick), and struck
  `automation_1` for as long as the starting kit contains the assembler it
  would unlock. `logistics_1` and `exploration_1` unlocked C23's buildings and
  are C23's to fill in; `logistics_2` waits for a renderer that can draw two
  belt tiers apart. The five that shipped keep §15's names and §15's costs.
- **`make_lab`'s bill lost its four frames.** A frame is two steel, steel is
  `smelting_2`'s, and a lab made of frames is a lab you need research to build.
  Twelve brick replaced them; the frame's consumer is now `make_assembler_2`,
  unlocked by the same node, so nothing is a material with nowhere to go.
- **Three buildings were added that §15's building table does not list**: the
  lab, which §15 owed, and `miner_2` and `assembler_2`, which §15's *tree* has
  always named as unlocks without giving them rows. §15's table now has all
  three.
- **`Unlock` has no `modifier` member.** C22 task 1 writes the kind as
  "building | recipe | modifier" and no technology in v1 changes a number, so a
  third member would be a shape with no producer, no consumer and no test —
  §19 rule 10 exactly. The machinery a modifier needs is real (every derived
  content table would have to be rebuilt when one landed) and belongs to the
  chunk that has one to apply.
- **`cancelResearch` was added to §7's command union**, recorded there, for the
  reason C10 added `stopMining`: `startResearch` fills a queue and a queue
  needs a way out.
- **The power column decision C21 deferred was taken by striking it.** The
  miner, the inserter and the assembler stay free; the lab is what makes the
  grid mandatory. Recorded in §15.

**Tests.**

- `tests/unit/technology-registry.test.ts` — the content table and every way
  it can be wrong: dangling prerequisites, cycles, duplicate ids, unlocks that
  name nothing, two technologies claiming one unlock (in both orders), a
  non-science cost, a bill whose counts disagree, tiers as the longest path
  from a root, and the shipped tree asserted node for node.
- `tests/unit/unlocks.test.ts` — the pure function: what the tree locks and
  what it leaves alone, a building bringing its recipe, idempotence, order
  independence, monotonicity as the tree completes, and the holder whose
  identity survives a rebuild.
- `tests/unit/research-system.test.ts` — the two commands and all their
  refusals, the queue that chains, a cancel that keeps its units, a lab's
  consumption tick by tick, starvation, no power, the anonymous unit that
  survives an empty queue, two labs in parallel, the in-flight guard that stops
  a wasted core, the unlock landing on the tick, what a lock actually stops
  (build, hand-craft, `setRecipe`) and what it does not (demolition), the
  state's JSON round trip, and three determinism assertions over the hash.
- `tests/integration/plates-to-research.test.ts` — the chunk's acceptance
  chain, unattended: assembler → inserter → lab → a technology → a splitter
  that can be placed where one could not be a moment earlier, plus the
  one-assembler-one-lab ratio measured as time the lab spends starved.
- `tests/unit/research-panel.dom.test.ts` — the panel through the real
  `GameUI`: every node drawn whatever its state, both ways in, the queue and
  its cancels, commands and nothing else, a `MutationObserver` proving no card
  is rebuilt, and the build menu's half of the same sentence.
- `tests/unit/production-system.test.ts` gained the other half of the port
  gate: a furnace that will not pick `smelt_steel` until `smelting_2` lands,
  and gets straight on with it when it does.

**Noticed, not fixed.**

- **The opening is *still* given rather than earned, and research is now the
  reason it matters.** C21A named this and C22 has made it sharper:
  `automation_1` — the strongest first unlock the genre has — is unavailable
  because the starting kit hands the player an assembler. Cutting the kit to
  roughly "a furnace, some plates and a pick" would let the assembler be the
  first technology, and the work is one content table, two numbers and a
  rewrite of the second milestone in `tests/balance/first-factory.test.ts`.
  It also needs `make_assembler` to become hand-craftable, or the first
  assembler could never be made.
- **The fast belt and the fast inserter have no way to be drawn.** They are the
  only two v1 unlocks that are blocked by the *renderer*: `beltSprite` and
  `inserterSprite` carry a rotation and a phase and no tier. Adding one is
  perhaps eighty lines across the atlas and its test, and it would bring
  `logistics_2` back into the tree.
- **`rotate` is still in §7's command union with no implementation.** Named by
  C20 and by C21A, and untouched again for the same reason: this chunk widened
  the union once already and a second unrelated system is not its scope.
- **Research state has no save migration.** `SerializedResearch` is new, like
  C21A's craft queue before it. C24 owns the format; both fields are now known
  migrations rather than hypothetical ones.
- **A `MutationObserver` cannot see `hidden`.** The panel tests assert that no
  *element* is added, which is the bar C07 set, but a panel that toggled
  `hidden` on the wrong rows would pass. Nothing has done so; it is worth a
  sharper assertion the day one does.

---

## C23 — Expansion, map & radar

**Goal.** Make leaving the starting area necessary and navigable.

**Depends on.** C19, C22.

**Tasks.**
1. Scarcity: starting-area patches must be exhaustible in roughly 2–4 hours of
   play, forcing a second mining outpost. Tune against C20's numbers.
2. Long-distance logistics with what already exists: long belt runs, and the
   underground-belt unlock (a paired entity with a validated span of ≤ 6 tiles).
3. **Radar** building (from the reference sheet): reveals world chunks around
   itself on the map and keeps a low-rate refresh. Cheap to implement, high value.
4. Map panel: rendered from the explored-world-chunk set, showing terrain colour,
   resource patches, and the player's entities as dots. Click to jump the camera.
5. Explored-world-chunk set is authoritative and persisted (§14).

**Acceptance.**
- The map shows explored terrain and updates as the player travels.
- A radar reveals a documented radius and its coverage persists across a save.
- A starting-area-only factory visibly runs out of ore in a bounded time.
- Underground belts validate their span and refuse invalid placements clearly.

**Tests.** Explored-set persistence; radar reveal radius; underground-belt span
validation and item transit determinism.

**Out of scope.** Trains, waypoints, blueprint-based outpost stamping.

**What C22 leaves here.** Two technology nodes and their content. C23 adds
`exploration_1` (radar, map panel) as a **leaf** hanging off `power_1` —
appending a node needs no save migration, where adding a prerequisite to an
existing one would — and adds the underground belt as a second unlock on
`logistics_1`, which is where §15 always put it. Both are content rows in
`data/technologies.ts`; the machinery is in place.

### What C23 shipped

**Acceptance, one by one.**

- The map shows explored terrain and updates as the player travels. *(Met.
  Phase 9 reveals the 3x3 block of world chunks around the player each time
  they cross into a new one, and the panel is handed a fresh snapshot on the
  5 Hz lane and on the way open. Asserted through the view model rather than
  through pixels — see the map panel's test on why.)*
- A radar reveals a documented radius and its coverage persists across a save.
  *(Half met, and the half that exists is the one C24 will build on. The radius
  is documented and asserted: a 5-world-chunk square, 121 chunks, one every
  half a second. There is no save format yet, so persistence is tested the way
  C22 tested research — `ExploredChunks` round-trips through its own key list,
  in the wrong order, and comes back identical. The determinism hash gained an
  `explored` root, so the day C24 writes it, §6 R8 is already watching.)*
- A starting-area-only factory visibly runs out of ore in a bounded time.
  *(Met, in two halves that were already apart. "Visibly" is C11's — a dry
  miner reports `no_resource` and raises exactly one alert. "In a bounded
  time" is C23's, and it is measured rather than asserted by construction: see
  §15's new scarcity section.)*
- Underground belts validate their span and refuse invalid placements clearly.
  *(Met. `span_too_long` is the refusal, it is a real sentence in the toast
  table, and the ghost goes red on the same answer — `validate` is one path
  with two callers, exactly as C06 built it.)*

**Decisions.**

- **A buried run is exactly as fast as the belt it replaces.** One lane,
  `(span + 1)` tiles long, so transit is distance over speed with nothing added
  and nothing saved. The alternative — teleport at the exit — would make
  burying a line a *throughput* upgrade, and the only way a player would find
  out is by racing two lines in a finished factory. Recorded in §9.
- **The pairing rule, and the one arbitrary number in it.** Placing a mouth
  scans **backwards** along its own facing for the nearest unpaired mouth
  facing the same way, stopping at the first *paired* one — a finished run is a
  wall, or a third mouth would steal its entrance and orphan its exit. Within
  `maxSpan` it pairs; beyond it, `span_too_long`. The scan window is
  `2 * maxSpan`, and that is the arbitrary number: within a second run's length
  of an unfinished run, in line with it and facing the same way, the player is
  finishing it and deserves to be told. Beyond that they are starting a new run
  on the same line, and refusing would make a long belt impossible to bury in
  two hops.
- **A lone mouth is an entrance with a span of zero**, so it is an ordinary
  belt tile until its partner arrives. There is no "unpaired" state to explain
  (pillar 3), and pairing is simply a run getting longer. Demolishing one end
  loses whatever was still in the tunnel — the same bargain a belt tile makes
  when it is removed with items on it, said one tile further, and the
  alternative would compact items backwards into a lane too short to hold them
  and put negative positions into authoritative state (§6 R7).
- **The map panel is not gated on research.** §15's tree writes
  `exploration_1` as unlocking "radar, map", and only the radar is behind it:
  the explored set fills from the player's own legs from the first tick, and a
  map you cannot open until the fifth technology is an hour of walking with
  nothing to show for it. Recorded in §15.
- **A radar sweeps one world chunk at a time.** Revealing is idempotent, so a
  radar *could* mark its whole coverage every tick and nothing observable would
  change. The cursor exists for two reasons that are not correctness: 121
  chunks per radar per tick is work §12 would notice, and a radar that fills
  the map in over a minute is a building doing something where one that
  completes the instant it is powered is a switch. The cursor wraps, which is
  what task 3's "low-rate refresh" is.
- **The explored set holds packed keys, not a flag on `WorldChunk`.** Reading a
  tile *generates* a world chunk, so a flag would be set by looking at the map;
  and a radar reveals ground nobody has visited, so it would have to generate a
  hundred world chunks to mark them. Recorded in §14.
- **The underground belt is not hand-craftable, though the belt is.** §15's
  hand-craft column exists so a new game is never soft-locked, and nothing
  behind a technology can be on that path by definition — which is why the
  other half of `logistics_1`, the splitter, needs an assembler too.

**Deviations.**

- **§8 gained a phase.** Exploration is phase 9, **appended**, so cleanup is
  the only phase whose number moved. The full reasoning is in §8; in short, its
  two producers want opposite ends of the tick and running after phase 8 gives
  both. This is the changelog entry §8 asks for.
- **A fifteenth building, and it is one §15's table never named.** The
  `underground_belt` belongs to §9's belt model rather than to §15's building
  table, which is why `EntityType` had a reserved number for the radar from day
  one and none for this. It takes the next free one, like every latecomer since
  C21. §15's table now has a row for it.
- **`EntityType` is full.** Every one of its fifteen members now has a
  definition, which means a test can no longer borrow "a type nothing has
  implemented yet" — `tests/unit/build-system.test.ts` has borrowed one three
  times since C17. The fixture now takes the radar's number and the radar steps
  out of the table for the length of the test, rather than adding an enum
  member for the tests' benefit that every save migration would have to learn.
- **`span_too_long` was added to §7's rejection vocabulary.** The one refusal in
  the game that is about a *pair*.
- **`laneAccept` and `laneEntryPosition` gained an optional lane length.** The
  only change C23 made to C13's belt code, and it closed a latent inconsistency
  as well as enabling the tunnel: an empty lane would accept an item "as far
  forward as it fits" and mean one tile by that, however long the lane was.
- **`BuildingCategory` gained `exploration`**, a seventh and a category of one.
  The radar is not `research` — nothing it does touches the tech tree — and not
  `logistics`, because it moves nothing.
- **`GameController` reads `WorldChunk.revision`**, which `world.ts` documents
  as presentation-facing and read by nothing in `game/`. It is the map's
  per-chunk cache key, it is the same signal the renderer's terrain cache uses,
  and the alternative is a second change counter beside the first. The worst a
  stale entry can do is draw a stale map cell.

**Tests.**

- `tests/unit/underground-belt.test.ts` — pairing and every way it can go
  wrong (off the axis, facing the other way, past a finished run, out of
  reach), the lock, and the transit half: a buried run and a surface belt of
  the same length fed the same item arrive on the **same tick**, a run holds a
  belt's density and no more, a belt run into the far end backs up, and a
  demolished far end leaves a working one-tile belt.
- `tests/unit/exploration-system.test.ts` — the set (bounds, idempotence,
  ascending keys, a rejected key, and revealing costing no world chunks), the
  player's reveal and the fact that standing still reveals nothing, the radar's
  documented radius chunk by chunk, no power, the lock, the wrap, and phase 9
  running after phase 8.
- `tests/unit/map-panel.dom.test.ts` — the panel through the real `GameUI`:
  both ways in, exclusivity against the other three panels, the empty state,
  the view growing as the player travels, names rather than colours, whole
  cells, dots only on explored ground, the revision cache, and click-to-jump
  landing on the tile under the pointer.
- `tests/integration/belt-underground-chest.test.ts` — §17's chain for this
  chunk, and the only one in that list that is a *comparison*: a buried line
  and a surface line of the same length, saturated for a minute, deliver the
  same count. Plus backpressure propagating back through six tiles of ground.
- `tests/balance/scarcity.test.ts` — the measurement §15 now records, across
  24 seeds.
- `tests/determinism/state-hash.ts` gained an `explored` root, so the set is
  covered by every determinism test that already exists.
- `tests/unit/sprite-atlas.test.ts` — the two mouths are different pictures at
  every facing, which is C22's argument against the fast belt one building on.

**Noticed, not fixed.**

- **A locked hand-craftable recipe would be invisible for ever.** C22 filters
  locked recipes out of `InventoryView`, and `InventoryPanel` sizes its button
  pool from the first view — so a recipe that is both hand-craftable and locked
  gets no button, and researching it would never give it one. Nothing has been
  both until now, and C23 kept it that way by making the underground belt
  machine-only *for its own reasons*. The day one genuinely needs to be both,
  the fix is to pool from `recipes.handCraftable()` and hide the locked rows.
- **An inserter cannot reach into an underground belt**, because `asBelt` tests
  the entity type. That is the same answer C17 gave for the splitter and it is
  right for the same reason — a mouth is a belt fitting, not a place items are
  loaded — but it is now true of two buildings rather than one, and the day a
  player expects otherwise it will read as a bug rather than as a rule.
- **`rotate` is still in §7's command union with no implementation.** Named by
  C20, C21A and C22, and untouched again: three chunks in a row have declined
  it, which is starting to look like a decision that should be written down as
  one.
- **The map does not draw the camera's viewport.** A player who jumps the
  camera has no mark on the map saying where they just went. Cheap to add and
  deliberately left out — the camera is the renderer's and the panel would need
  a second injected reading beside `onJumpTo` for a rectangle C29 may move.

---

# Milestone D — Persistence

> **Result:** a factory survives a browser reinstall and moves between machines.

Note this milestone is *cheap* because C05 made every entity a plain, cloneable
object and §14 decided the delta strategy in advance. That was the point.

---

## C24 — Save state model & serializer

**Goal.** A versioned, plain-data snapshot of authoritative state.

**Depends on.** C23.

**Tasks.**
1. Define `save-format.ts` per §14, with `SerializedGameState`:
   ```ts
   interface SerializedGameState {
     readonly generatorVersion: number;
     readonly seed: number;
     readonly rngPosition: number;
     readonly tick: number;
     readonly nextEntityId: number;
     readonly itemIdMap: readonly string[];      // numeric id -> string id
     readonly player: SerializedPlayerState;
     readonly entities: readonly SerializedEntity[];
     readonly chunkDeltas: readonly SerializedChunkDelta[];
     readonly exploredChunks: readonly number[];
     readonly research: SerializedResearchState;
   }
   ```
2. `save-serializer.ts`: `serialize(sim): SerializedGameState` and
   `deserialize(state): Simulation`. Both pure, both testable headlessly.
3. World chunk deltas: only `dirty` world chunks, and within them only tiles that
   differ from generator output. Store as parallel index/value arrays, not objects.
4. `rebuildDerived()` after deserialize: occupancy index, power networks, belt
   connectivity, unlock set, rate averages reset.
5. Serialization runs **between ticks only**; the game loop pauses for it.
6. Entity arrays are written in id order so two equivalent states serialize
   identically (needed for the §6 R8 hash).

**Acceptance.**
- §6 R8 round-trip passes on a 5,000-entity factory: save at tick N/2, load, run
  to N, state hash equals an uninterrupted run.
- The reference factory (§12) serializes in < 300 ms and to < 2 MB gzipped.
- Deserializing a save whose world chunks were never regenerated produces
  identical terrain.
- No class instance, `Map`, `Set`, `undefined`-valued key or cycle appears in the
  serialized output (assert with a structural validator).

**Tests.** Round-trip determinism (unskip the C15 test); delta correctness against
a regenerated world; size and time budgets; the structural purity assertion.

**Out of scope.** Storage, files, UI.

---

## C25 — IndexedDB repository & autosave

**Goal.** Saves that persist across sessions, safely.

**Depends on.** C24.

**Tasks.**
1. ```ts
   interface SaveRepository {
     list(): Promise<SaveMetadata[]>;
     save(id: string, save: SaveFile): Promise<void>;
     load(id: string): Promise<SaveFile>;
     delete(id: string): Promise<void>;
   }
   ```
   `IndexedDbSaveRepository` (~120 lines of promisified requests, no wrapper
   library) and `MemorySaveRepository` for tests.
2. Two object stores: `saves` (the blob) and `metadata` (name, tick, playtime,
   timestamp, thumbnail). Listing must not deserialize save blobs.
3. Store the state as a compressed blob using `CompressionStream('gzip')` where
   available, with an uncompressed fallback and a flag in the metadata.
4. Autosave per §14: every 3 minutes and on `visibilitychange → hidden`, into
   3 rotating slots, never touching a manual save.
5. Handle every failure mode in §14's table. Each one gets a specific, actionable
   player-facing message — never a silent failure, never a bare `catch {}`.
6. Multi-tab lock via `BroadcastChannel`; the second tab warns before it can save.
7. Save menu UI: list with timestamps and playtime, save, load, delete with
   confirmation, and rename.

**Acceptance.**
- A factory survives a full browser restart, bit-for-bit.
- With IndexedDB blocked (private mode), the game starts, warns clearly, and
  remains playable with export/import.
- A simulated `QuotaExceededError` does not destroy the existing save.
- Autosave never blocks a frame for more than 300 ms *(serialize between ticks;
  write asynchronously)*.
- Listing 50 saves takes < 50 ms and does not deserialize any state.

**Tests.** Repository contract tests run against both implementations; quota and
unavailability failure paths with a mocked IDB; autosave rotation; the multi-tab
lock.

**Out of scope.** Cloud sync, save sharing, a save browser with screenshots.

---

## C26 — Export / import & validation

**Goal.** Portable saves, and total distrust of imported data.

**Depends on.** C25.

**Tasks.**
1. Export: `ironflow-save-<name>-<timestamp>.ifsave` — gzipped JSON with a magic
   header and the schema version in plain sight. Download via an object URL.
2. Import: `<input type="file">` plus drag-and-drop onto the window.
3. **A full validator, because an imported save is untrusted input.** Validate:

   ```text
   magic header and format string        every entity id unique and < nextEntityId
   schema version known and <= current   every entity type known
   every string item id known            every coordinate a finite integer in range
   every building id known               every amount a finite non-negative integer
   every recipe id known                 every inventory count <= stackSize * slots
   every technology id known             every array length within a sane cap
   no prototype-polluting keys           no duplicate entity occupancy
   rngPosition finite                    generatorVersion known
   ```
4. Reject with a specific, listed reason. Never partially import. Never
   `JSON.parse` into an object that is then spread into game state — construct
   validated objects field by field.
5. Cap decompressed size (e.g. 64 MB) to avoid a decompression bomb.
6. A malformed save must never be able to crash the game or produce `NaN` state.

**Acceptance.**
- A save exported on one browser imports on another and continues correctly.
- A truncated file, a file with an unknown item id, a file with a 10⁹-length
  array, and a file with `__proto__` keys are each rejected with a clear reason
  and zero state mutation.
- A fuzz test of 1,000 randomly corrupted saves produces zero crashes and zero
  non-finite values in game state.

**Tests.** The validator against a corpus of hand-crafted malicious and malformed
saves; a corruption fuzz test; export→import round-trip equality.

**Out of scope.** Save encryption, signing, cheat detection.

---

## C27 — Save migrations

**Goal.** Old saves keep working.

**Depends on.** C26.

**Tasks.**
1. `migrateSave(save: SaveFile): SaveFile` chaining pure `vN → vN+1` functions.
2. Each migration is its own file, independently unit-tested against a **stored
   fixture save** committed to `tests/fixtures/saves/`. Generate a fixture at every
   version bump — a migration without a fixture is untested by definition.
3. Handle the two content-drift cases explicitly:
   - **Item/building id renamed or removed**: the migration maps old ids to new
     ones, or converts the affected entities/stacks to a documented fallback.
     The persisted `itemIdMap` (C08) is what makes this tractable.
   - **`generatorVersion` changed**: either pin the old generator (keep old
     generators in the codebase, selected by version) or, if that is impractical,
     migrate by baking the old world's terrain into chunk deltas at migration time.
     Decide per change; document the decision in the migration file.
4. Refuse saves newer than the current schema version, with a clear message.

**Acceptance.**
- Every historical fixture save loads and plays after migration.
- A migration chain of 3+ steps applies in order and is idempotent when re-run
  from its own output version.
- A future-version save is refused clearly rather than crashing.

**Tests.** One test per migration against its fixture; chain application;
future-version refusal.

**Out of scope.** Downgrade migrations.

---

# Milestone E — Scale & polish

> **Result:** the reference factory in §12 runs at 60 fps and the game looks like
> `ironflow_visual_reference.png`.

---

## C28 — Performance instrumentation

**Goal.** Measure before optimising. This chunk unlocks permission to optimise.

**Depends on.** C24 (needs saves to build the benchmark fixture).

**Tasks.**
1. `Profiler`: per-system timers with a rolling window, zero-cost when disabled.
   Guard with a compile-time-ish flag so the release build has no overhead in the
   tick loop.
2. Debug overlay (F3) showing everything in the §12 budget table, plus per-phase
   timings:
   ```text
   FPS  frame ms  sim ms  render ms  ticks/frame  accumulator
   entities  belts  belt items  machines  inserters  visible chunks
   phase: commands / power / mining / production / belts / inserters / research
   heap (where performance.memory exists)
   ```
3. Build the **reference factory save fixture** (§12) — generate it with a script
   that places entities programmatically, and commit it.
4. Headless benchmark suite (`vitest bench`) that loads the fixture and reports
   per-system tick cost, with committed baselines.
5. Wire the budgets in as assertions: the benchmark fails CI if a hard-fail
   threshold is crossed.

**Acceptance.**
- The overlay reports every §12 metric, and the numbers are trustworthy
  (validated against manual `performance.now` measurement).
- The reference fixture loads and runs headlessly.
- Baselines are committed; a deliberate 2× slowdown in one system is detected.
- The profiler costs < 0.1 ms/tick when enabled and 0 when disabled.

**Tests.** Benchmark harness reproducibility (< 5% variance across runs);
threshold assertions.

**Out of scope.** Actually optimising anything. That is C29.

---

## C29 — Renderer optimisation & art pass

**Goal.** Hit the §12 budgets, and look like the reference sheet.

**Depends on.** C28. **Do not start any item here without a profiler measurement
justifying it.**

**Sanctioned optimisation paths, in order of expected value:**

```text
1. Terrain world-chunk canvas caching     (already in C03 — verify it is working)
2. Sprite atlas as a single image         + drawImage from one source
3. Entity spatial index for culling       instead of scanning all entities
4. Belt networks                          contiguous belt runs as one segment
                                          with shared item arrays; O(items) not
                                          O(tiles). See below.
5. Dirty-rectangle rendering              only when panning is stationary
6. Typed-array hot data                   belts and machine progress in SoA form
7. WebGL2 renderer                        last resort; the Renderer interface
                                          from C03 makes it a replacement
8. Web Worker simulation                  requires the plain-data contract from
                                          C05 to hold; postMessage a snapshot
```

**Belt network transformation** — the most likely single win:

```text
before:  N belt entities, each with its own item list
         cost O(tiles) per tick

after:   BeltNetwork { segments[], itemIds: Int32Array, positions: Int32Array }
         a straight run of belts is one segment; items are a compacted array;
         only the head and tail need per-tick work
         cost O(items) per tick, with far better cache behaviour
```

Implement this **only** if C28 shows belts exceeding ~4 ms in the reference
factory. It is a significant complexity increase and must preserve every C13
test unchanged — the tests are the contract.

**Art pass tasks.**
1. Produce or commission sprites for the asset list in
   `ironflow_visual_reference.png`; pack into an atlas with a JSON descriptor.
2. `ImageAtlas implements SpriteAtlas` — swap it in at the composition root.
   No renderer code changes.
3. Animation: belt item flow, inserter pick-and-place, miner extraction, and the
   player's idle/walk/work cycle — all driven by **render-side** time (§6).
4. Zoom-dependent detail: drop animation and small details below zoom 0.5.

**Acceptance.**
- Every §12 target metric is met on the reference factory on a mid-range laptop.
- All C13/C14/C17 tests pass unchanged after any belt refactor.
- The game visually matches the reference sheet's style at zoom 1.
- No regression in the determinism hashes from C18.

**Tests.** The full existing suite must pass unchanged — that is the point of
having written it. Plus updated benchmark baselines.

**Out of scope.** Optimising anything the profiler did not flag.

---

## C30 — Audio, UX & accessibility polish

**Goal.** The last 10% that makes it feel finished.

**Depends on.** C29.

**Tasks.**
1. Audio via `AudioContext` (no library): placement, removal, machine hum
   (positional, count-limited), belt ambience, research complete, alert. A global
   volume and a mute, persisted in `localStorage` (UI preference — **not** game
   state).
2. Hard-cap concurrent sources and cull by distance; a thousand humming machines
   must not become a thousand oscillators.
3. Accessibility:
   - Full keyboard control including build, rotate and panel navigation.
   - Rebindable keys (the `keybindings.ts` from C04 already makes this data).
   - Respect `prefers-reduced-motion` — disable belt/arm animation.
   - Colour-blind-safe status indication: never colour alone; pair every status
     colour with an icon or a shape.
   - Minimum 14 px UI text; a UI scale setting.
4. Onboarding: a short, skippable, non-modal objective list for the first run
   ("mine 20 iron", "place a miner", "connect a belt"). Not a scripted tutorial —
   objectives that teach by being achievable.
5. Pause (the reference sheet's pause icon), a speed control for testing, and a
   confirm-on-close guard when there are unsaved changes.

**Acceptance.**
- Every action is reachable without a mouse.
- `prefers-reduced-motion` visibly reduces motion.
- Status is distinguishable in greyscale.
- Audio never exceeds the source cap and never clicks or pops.
- A new player reaches their first automated plate without external instruction.

**Tests.** Keyboard-navigation smoke tests in jsdom; audio source-cap unit test;
settings persistence.

**Out of scope.** Music, voice, localisation *(design the UI so strings are
centralised, but do not translate in v1)*.

---

## C31 — Enemies  ⚠️ **GATED — do not implement by default**

The previous revision listed enemies as "optional" and then omitted them from
every milestone. Here is an explicit decision procedure instead.

**Go/no-go test, evaluated after C23:**

> Does the player currently face a meaningful cost for expanding, or is expansion
> purely free upside?

If expansion already carries real cost — travel time, logistics complexity,
power infrastructure, defended chokepoints of terrain — then **enemies add
nuisance, not decisions. Do not build them.**

Implement only if the answer is "expansion is free" *and* the player has
explicitly asked for combat.

**Evaluated after C23: NO-GO.** Expansion is not free, and C23 is the chunk
that made it cost. Four things the player now pays:

```text
  ore runs out          §15's scarcity section: the starting area's iron is a
                        median 2.6 hours of a reference factory, so the second
                        outpost is compulsory rather than optional
  distance costs        a far patch is a belt run or a second smelting column;
                        §19's generator makes distant deposits richer but
                        *rarer*, so there is no second one behind the first
  looking costs         a radar is 300 kW, the poles to reach it, and a minute
                        of sweeping before it has told the player anything
  the route costs       terrain, and now the six-tile span that gets a line
                        past what is in the way — which is a decision rather
                        than a detour
```

Enemies on top of that would add nuisance, not decisions, which is exactly
what the test above exists to prevent. Re-evaluate only if a later chunk makes
expansion cheap, or if the player asks for combat.

**If greenlit, the minimum viable version:**

```text
nests spawn at worldgen, far from spawn, deterministic from seed
pollution-free trigger: expansion into a nest's radius provokes it
behaviour: spawn -> move toward nearest player structure -> attack -> die
defence: a wall building and a turret consuming ammunition from a belt
```

Explicit constraints: no flocking, no pathfinding beyond greedy movement with
obstacle avoidance, no adaptive difficulty, no attack waves on a timer. Enemies
must make **placement** decisions interesting (defend a chokepoint, route ammo)
and must never make the player babysit.

**Out of scope even if greenlit.** Enemy evolution, biter variants, artillery,
military research trees.

---
---

# PART III — REFERENCE

---

## §15 Content bible v1

Starting numbers, chosen so the ratios are clean. The previous revision deferred
all of this to playtesting, which left the agent with nothing to implement. These
are a **coherent starting point**, to be tuned in C20 — but tuned as a system, by
re-deriving the table, not by nudging one number.

### Anchors

```text
TPS               = 30 ticks/second
belt tier 1       = 8.0 items/s        belt tier 2 = 16.0 items/s
inserter std      = 1.0 items/s        inserter fast = 2.5 items/s
miner tier 1      = 0.5 items/s
manual mining     = 0.5 items/s        (C10; 60 ticks per item)
assembler tier 1  = crafting speed 0.5
furnace           = crafting speed 1.0 (C16; smelting times are already a
                                        furnace's, so its speed is the identity)
player walk       = 4.0 tiles/s        (C10; 32 subtiles/tick of 240)
player mine reach = 6 tiles            player build reach = 8 tiles
player bag        = 30 slots
```

### Items

| id | name | stack | category |
|---|---|---|---|
| `iron_ore` | Iron Ore | 50 | raw |
| `copper_ore` | Copper Ore | 50 | raw |
| `coal` | Coal | 50 | raw |
| `stone` | Stone | 50 | raw |
| `iron_plate` | Iron Plate | 100 | plate |
| `copper_plate` | Copper Plate | 100 | plate |
| `steel` | Steel | 100 | plate |
| `brick` | Brick | 100 | plate |
| `gear` | Gear | 100 | intermediate |
| `copper_wire` | Copper Wire | 200 | intermediate |
| `circuit` | Circuit | 200 | intermediate |
| `frame` | Structural Frame | 50 | intermediate |
| `data_core` | Data Core | 200 | science |

13 items, and **all thirteen exist from C22**: C16 added `gear`, `copper_wire`
and `circuit` with the recipes that make them, and C22 added `frame` and
`data_core` with the lab that consumes them. Add the 14th only if a recipe
needs it.

`frame` and `data_core` are at the **end** of `data/items.ts` rather than in
this table's row order, because that file is append-only — the runtime ids are
its order, and sliding two rows up would renumber every building item below
them for no gain.

**Building items (C20).** The thirteen above are the *materials*. Every
building in the table below is also an item — that is what "placed by consuming
their item" means — and C20 registered the seven that exist, in building-table
order, with `category: 'building'`:

| id | stack |
|---|---|
| `miner` | 50 |
| `belt` | 100 |
| `splitter` | 50 |
| `inserter` | 50 |
| `furnace` | 50 |
| `assembler` | 50 |
| `chest` | 50 |
| `generator` | 50 |
| `power_pole` | 50 |
| `electric_furnace` | 50 |
| `lab` | 50 |
| `miner_2` | 50 |
| `assembler_2` | 50 |

A hundred belts and fifty of everything else: belts are spent a dozen at a time
and a stack that runs out mid-drag reads as a bug (C13); fifty of anything else
is past what a player carries before they run out of somewhere to put it. Both
are **balance numbers**. C21 added the generator, the pole and the electric
furnace; C22 added the lab §15 owed and the two tier-2 buildings its tech tree
unlocks. **C23 added the last two**: the `radar` this table has owed since
revision 2, and an `underground_belt` at the belt's hundred — for the belt's
reason, since a run of them is laid in one go.

**Ten buildings is one more than the hotbar.** C21 is the chunk that overflows
`HOTBAR_SLOTS`, and the tenth entry is reached through the build menu with no
number beside it. That is why C21 *appended* its three rather than slotting the
generator and the pole into §15's table order beside the assembler: content
order is hotkey order, and inserting a row renumbers a hotbar the player has
already learned. The chest is the earlier departure from table order, for the
same reason.

Adding a building is therefore now **two** content rows and not one: an entry in
`data/buildings.ts`, an entry in `data/items.ts`, a recipe, and a palette token
named after the item id. C06's "zero code changes elsewhere" still holds — none
of those is code — and `tests/balance/content.test.ts` fails if any is missing.

**Recipe selection.** A machine either reads its own input buffer and runs
whatever the items in it name (`auto` — the furnace) or makes what the player
told it and nothing else, through an empty buffer included (`player` — the
assembler). It is a field on the building, `recipeSelection`, because neither
the recipe nor its category can decide it: `copper_plate` names exactly one
crafting recipe, and an assembler fed one must still wait to be told (C16).

**Fuel.** `coal` burns for **8 s** in any machine with a fuel buffer. It is a
property of the item (`fuelSeconds` in `data/items.ts`), not of the furnace, so
C21's generator burns it without a table of its own (C15). Nothing else in v1
burns.

**What "8 s" means, settled in C21.** The sentence above and the generator row
below disagreed: eight seconds a coal is 0.125 coal/s, and the building table
says a generator burns 0.75. Only one number can be free, and the one that is
free is the *reference power* the eight seconds are measured at:

```text
900 kW / 0.75 coal per second  =  1200 kJ per coal
1200 kJ / 8 s                  =   150 kW      <- FUEL_REFERENCE_KW
```

So `fuelSeconds` is a burn time **at 150 kW**, and a burner that draws more
gets through an item proportionally faster. Both §15 rows survive, C15's
furnace is unchanged — it has no power rating, so it burns at the reference
rate, which is the eight seconds it always had — and C21's electric furnace
lands on 150 kW by derivation rather than by choice. The constant lives in
`systems/power-system.ts` with this arithmetic beside it.

### Recipes

| id | inputs | output | time | machine |
|---|---|---|---|---|
| `smelt_iron` | 1 `iron_ore` | 1 `iron_plate` | 3.2 s | furnace |
| `smelt_copper` | 1 `copper_ore` | 1 `copper_plate` | 3.2 s | furnace |
| `smelt_steel` | 5 `iron_plate` | 1 `steel` | 16.0 s | furnace |
| `bake_brick` | 2 `stone` | 1 `brick` | 3.2 s | furnace |
| `make_gear` | 2 `iron_plate` | 1 `gear` | 1.0 s | assembler |
| `make_wire` | 1 `copper_plate` | 2 `copper_wire` | 0.5 s | assembler |
| `make_circuit` | 3 `copper_wire` + 1 `iron_plate` | 1 `circuit` | 1.0 s | assembler |
<!-- The three above ship in C16. `make_frame` and `make_data_core` wait for
     C22's lab, which is what consumes what they make. -->
| `make_frame` | 2 `steel` + 4 `brick` | 1 `frame` | 4.0 s | assembler |
| `make_data_core` | 1 `gear` + 1 `copper_plate` | 1 `data_core` | 2.5 s | assembler |
| `make_belt` | 1 `gear` + 1 `iron_plate` | 2 `belt` | 0.5 s | assembler |
| `make_inserter` | 1 `gear` + 1 `circuit` + 1 `iron_plate` | 1 `inserter` | 0.5 s | assembler |
| `make_miner` | 4 `gear` + 2 `circuit` + 4 `iron_plate` | 1 `miner` | 2.0 s | assembler |
| `make_generator` | 8 `gear` + 10 `iron_plate` + 6 `brick` | 1 `generator` | 3.0 s | assembler |
| `make_power_pole` | 1 `copper_wire` + 2 `iron_plate` | 1 `power_pole` | 0.5 s | assembler |
| `make_electric_furnace` | 12 `brick` + 5 `circuit` + 3 `steel` | 1 `electric_furnace` | 3.0 s | assembler |
| `make_lab` | 10 `gear` + 10 `circuit` + 12 `brick` | 1 `lab` | 5.0 s | assembler |
| `make_miner_2` | 6 `gear` + 4 `circuit` + 4 `steel` | 1 `miner_2` | 3.0 s | assembler |
| `make_assembler_2` | 10 `gear` + 6 `circuit` + 4 `frame` | 1 `assembler_2` | 5.0 s | assembler |
| `make_radar` | 5 `gear` + 5 `circuit` + 10 `iron_plate` | 1 `radar` | 3.0 s | assembler |
| `make_underground_belt` | 2 `gear` + 4 `iron_plate` | **2** `underground_belt` | 1.0 s | assembler |

A time in this table is the **recipe's own**. What a machine takes is that
divided by its `craftingSpeed`, rounded to whole ticks once at startup (C16):
`make_gear` is 1.0 s and a tier-1 assembler takes 60 ticks over it.

The building rows are exactly that: every building in the table below has one,
taking the ingredients in its "crafted from" column. Total v1 recipe count:
**9 processing + 15 building = 24**, and as of C23 **all of them exist**. The
fifteenth building recipe is `make_underground_belt`, which §15 never listed
because §9 owned that building rather than this section.

**`make_lab`'s bill is not the one the building table below used to give.** It
said 10 gear, 10 circuit and **4 frame**, and the frames are gone: a frame is
two steel, steel is what `smelting_2` unlocks, and `smelting_2` is a
technology — so a lab made of frames would be a lab you needed research to
build and research you needed a lab to do. That is C22's **entry-path rule**,
and the twelve brick that replaced them cost the same detour through stone
that a furnace does. The frame's consumer is now `make_assembler_2`, which is
the other half of what `construction_1` unlocks, so it is never a material
with nowhere to go. Its five seconds make it the longest single craft in the
game, taking that title from `make_assembler` on C20's rule that a craft time
tracks the size of its bill.

C20 shipped seven of the eleven — one per building that exists — and authored
the four times this table did not give. They are **balance numbers**, chosen so
a building's craft time tracks the size of its bill rather than being flat:

| id | time | why |
|---|---|---|
| `make_splitter` | 1.0 s | twice a belt's pair-worth, plus a circuit |
| `make_furnace` | 2.0 s | a miner's, and its twelve bricks are the real cost |
| `make_assembler` | 4.0 s | the biggest bill; at speed 0.5 it is eight seconds, the longest single craft in the game |
| `make_chest` | 0.5 s | four plates, the cheapest thing in the table |

`make_furnace` is the only consumer `brick` has, and therefore the only reason
to bake one — which is the only reason to mine `stone`.

**`steel` has one from C21.** C20 listed it as a dead end and predicted C22's
`make_frame` would close it; `make_electric_furnace` got there first, which is
why `tests/balance/content.test.ts` now carries an empty exception list. Its
three ingredients are C21's and they are **balance numbers**: the twelve brick
echo the furnace it replaces, the five circuits are what make it electric, and
the three steel — 15 plates and 48 s of smelting — are what stop a player
converting their whole smelting column the afternoon they unlock it.
`make_generator` and `make_electric_furnace` take 3.0 s apiece on C20's rule
that a craft time tracks the size of its bill; `make_power_pole` takes the
chest's 0.5 s, because it is three items and poles are laid by the dozen.

Building items being craftable is what lets the factory eventually build itself —
a strong pillar-1 moment, and the reason `make_miner` is worth its cost.

### Derived ratios (verify these in C20's balance tests)

```text
1 miner (0.5 ore/s)          feeds  1.6 furnaces smelting plates
1 plate furnace (0.3125/s)   feeds  1.0 steel furnace exactly (5 plates / 16 s)
1 gear assembler (0.5 gear/s at speed 0.5, 1.0 s recipe)
                             needs  1.0 plate/s  =  3.2 plate furnaces
1 belt tier 1 (8 items/s)    saturated by 16 miners, or 8 std inserters
1 std inserter (1 item/s)    feeds  3.2 plate furnaces
1 gear assembler             eats   1.0 plate/s  =  exactly 1 std inserter
```

The last three lines are the interesting ones: a single inserter cannot saturate
a belt, and a single belt can carry the output of an implausible number of
miners. That asymmetry is where layout decisions live.

**The sixth line is C20's, and it is the sharpest ratio in the game.** A gear
assembler consumes exactly 1.0 plate/s and a standard inserter moves exactly
1.0 item/s. They are *equal*, so one inserter can only feed a gear assembler if
it never misses a swing — and it always misses some, because the belt slot
under it is sometimes empty. Measured in the reference factory, one inserter
delivers about 0.89 plates/s and the assembler runs at 89% of its rate for ever,
with no stall, no alert and nothing on screen to say why. **Two inserters per
gear assembler** is the answer; a player who has not worked that out has a
factory that is quietly a ninth slow.

That is a feature, not a defect — it is the layout puzzle arriving at the
smallest scale it can — but it is written down so that a later tweak to either
number makes a decision about it rather than an accident.
`tests/balance/ratios.test.ts` holds all six.

**C22 adds a seventh, and it is the cleanest in the game:**

```text
1 assembler making data cores    1 core / 5 s   (2.5 s recipe at speed 0.5)
1 lab                            1 unit / 5 s   (every v1 technology, uniform)
                                 ->  one assembler feeds exactly one lab
```

Nothing in either number is chosen to make that true twice: §15 already gave
`make_data_core` its 2.5 s and the tier-1 assembler its speed 0.5, and C22's
uniform five seconds a unit is what falls out of them. The consequence a
player can act on is that a science line scales in whole assemblers, and that
one standard inserter — 1.0 items/s against a core wanted every five seconds —
has four seconds of slack in every five, which is the first ratio in the game
with room in it.

### Buildings

Buildings are **placed by consuming their item** from the player's inventory.
That item is crafted by the corresponding recipe above (or hand-crafted early
game). So `buildCost` is always a single stack of the building's own item — the
interesting cost lives in the recipe, and the factory eventually builds itself.

| id | size | crafted from | power | notes |
|---|---|---|---|---|
| `miner` | 2×2 | 4 gear, 2 circuit, 4 iron_plate | — *(see below)* | needs ≥1 resource tile under footprint |
| `belt` | 1×1 | 1 gear + 1 iron_plate → **2 belts** | — | 4 rotations, 8 items/s |
| `splitter` | 1×2 | 2 gear, 1 circuit, 2 iron_plate | — | 4 rotations, deterministic round-robin, 8 items/s per lane (C17) |
| `inserter` | 1×1 | 1 gear, 1 circuit, 1 iron_plate | — *(see below)* | 4 rotations, 1 item/s |
| `chest` | 1×1 | 4 iron_plate | — | 24 slots |
| `furnace` | 2×2 | 12 brick | — | burns coal, 8 s per coal; buffers 50 in / 50 fuel / 50 out, 4 rotations (C15) |
| `assembler` | 3×3 | 8 gear, 4 circuit, 6 iron_plate | — *(see below)* | recipe selectable, speed 0.5; buffers 50 in / 50 out, 4 rotations (C16) |
| `generator` | 3×3 | 8 gear, 10 iron_plate, 6 brick | **−900 kW** | burns 0.75 coal/s **at full load**, pro rata below it (C21) |
| `power_pole` | 1×1 | 1 copper_wire, 2 iron_plate | — | wire reach 8 (a radius), supply area 5 (a square) |
| `electric_furnace` | 2×2 | 12 brick, 5 circuit, 3 steel | 150 kW | smelting, speed 1.0, **no fuel buffer**; buffers 50 in / 50 out, 4 rotations (C21) |
| `lab` | 3×3 | 10 gear, 10 circuit, **12 brick** | 180 kW | consumes data cores; one research unit per 5 s (C22) |
| `radar` | 2×2 | 5 gear, 5 circuit, 10 iron_plate | 300 kW | reveals a 5-world-chunk square, one chunk every 0.5 s (C23) |
| `underground_belt` | 1×1 | 2 gear, 4 iron_plate → **2 mouths** | — | 4 rotations, 8 items/s, span ≤ 6 tiles (C23) |
| `miner_2` | 2×2 | 6 gear, 4 circuit, 4 steel | — | 1.0 items/s; unlocked by `mining_2` (C22) |
| `assembler_2` | 3×3 | 10 gear, 6 circuit, 4 frame | — | speed 1.0; unlocked by `construction_1` (C22) |

Hand-craftable without a machine (so a new game is never soft-locked):
`belt`, `chest`, `inserter`, `miner`, `furnace`, and the plates/gears they need.
Everything else requires an assembler.

**Implemented in C21A, and the list above is eight rows rather than five.**
Taken literally, "the plates/gears they need" stops one ingredient short of its
own entries: the inserter and the miner each want a **circuit**, so `make_wire`
and `make_circuit` are hand-craftable too, and `make_gear` is the "gears" said
out loud. The shipped set is therefore `make_gear`, `make_wire`, `make_circuit`,
`make_miner`, `make_belt`, `make_inserter`, `make_furnace`, `make_chest`, and it
is a column of `data/recipes.ts` rather than a list in a system.

**The plates are not among them, and cannot be.** A plate is smelted, smelting
is what a furnace is *for*, and `RecipeRegistry` now refuses a hand-craftable
smelting recipe outright as a content error. The consequence is worth stating
plainly, because this paragraph used to imply otherwise: **hand-crafting alone
does not bootstrap a factory from nothing.** `make_furnace` takes brick, brick
is baked in a furnace, and the loop closes only because the player is given
two. The soft-lock guarantee still rests on the starting kit and on demolition
refunding in full, exactly as C20 said it already did. What hand-crafting
removes is the dependence on the kit's **assembler**, which is the gate this
section actually cares about.

**Hand-craft speed is `HAND_CRAFTING_SPEED` = 0.5** — the same as a tier-1
assembler, so the assembler's whole value is automation rather than speed. See
C21A's decisions for why that is the opposite of the genre's usual answer and
why it is the right one here.

15 buildings, and **as of C23 every one of them exists**. Eleven are distinct
verbs, which is what the previous revision's "5–8" was protecting; four are
variants, and each one is there because a **technology needed something to
unlock**. The twelfth is C21's `electric_furnace`; the thirteenth and
fourteenth are C22's `miner_2` and `assembler_2`, which §15's own tech tree has
always named (`mining_2` unlocks "miner tier 2 (1.0/s)", `construction_1`
unlocks "assembler tier 2") without giving them rows, and C22 gave them rows.
The fifteenth is C23's `underground_belt` — the one building in the game §15
never named, because §9's belt model owned it from revision 2.

**The fast belt and the fast inserter are not among them**, and the reason is
the renderer rather than the tree: the procedural atlas draws a belt as a lane
of chevrons and an inserter as an arm, and neither sprite id has a way to say
which tier it is. Two buildings on the map the player cannot tell apart is a
worse answer than one technology fewer, so `logistics_2` waits for the chunk
that gives the renderer that vocabulary. See C22's deviations.

### The power column, as C21 charges it

Three rows above used to carry a kilowatt figure and now read "see below": the
miner's 90 kW, the inserter's 13 kW and the assembler's 150 kW. **Nothing in
v1 charges them**, and the reason is two paragraphs of this same section
contradicting each other.

The tech tree unlocks the assembler at `automation_1` and the generator at
`power_1`, two tiers later, and it starts the player with a miner and an
inserter. A power column taken literally therefore makes the first four
technologies unplayable: every machine the player can build needs a grid they
cannot build for another two tiers. Whichever of the two is wrong — the column
or the tree — **is C22's decision**, because C22 owns the tree and the unlock
machinery, and C21 is forbidden from implementing either (§19 rule 4).

So C21 charges power to the buildings §15 unlocks *at or after* `power_1`, and
leaves the rest free:

```text
draws power    electric_furnace 150 kW      (C21)
               lab              180 kW      (C22)
               radar            300 kW      (C23, and it is charged)

free in v1     miner, inserter, assembler   struck by C22 — see below
```

This is a real reduction in what power *touches* in v1, and it is worth being
honest about: with only the electric furnace drawing on it, C21's grid is
optional. What makes it worth building anyway is the logistics trade below,
and what will make it mandatory is C22's lab.

**C22 made the decision C21 left it, and it struck the three figures.** The
miner, the inserter and the assembler run for free in v1. The alternative —
charge them and move `power_1` to the front of the tree — was considered and
rejected: it would make a generator the price of the *first* miner, which
inverts §15's own progression and makes the opening more given rather than
less. What replaces it is the lab. Every technology in the game goes through a
building that draws 180 kW and will not turn over without a pole in reach, so
the grid stops being optional the moment the player wants anything from the
tech tree — which is exactly the sentence C21 wrote and could not yet keep.
The generator and the pole are therefore **start content** (see the tree
below), because nothing on the path to the first technology may be behind one.

### The electric furnace, and the electric miner that is not here

C21 task 6 asks for "electric miner and electric furnace variants … giving a
real choice: fuel logistics vs. power infrastructure". The furnace delivers
exactly that and the miner cannot, for a reason that is about what the two
base buildings are:

- A **burner furnace** needs a coal belt and two inserters. Its electric twin
  needs one inserter and no coal at the machine, and — because 150 kW *is*
  `FUEL_REFERENCE_KW` — six of them cost a generator precisely the coal six
  burner furnaces would have burned. The trade is purely logistical: **one
  coal line to one generator instead of one to every furnace.** Nothing is
  cheaper and nothing is faster; what changes is the shape of the factory,
  which is pillar 4.
- A **tier-1 miner burns nothing**. It runs for free today, so an "electric"
  variant of it is not a choice between two supply chains — it is the same
  miner with a bill attached, or a faster one, and either way it is a number
  rather than a decision. C21 does not ship it.

It belongs to whichever chunk makes tier-1 mining cost fuel — at which point
the furnace's trade is available to the miner unchanged — or to C22's
`mining_2`, which already owes a tier-2 miner and could make that tier the
electric one. Turning the base miner into a burner is a content change the
size of C20's pass and is not C21's to make.

### Technology tree v1

**Rewritten by C22.** The tree drawn in revision 2 does not survive contact
with §15's own building table, and the rule that resolves it is worth stating
before the tree itself:

> **Nothing on the path to the first technology may be behind a technology.**

Research is entered through a *building*, so the lab, the grid that powers it,
and every recipe that goes into a data core have to exist before any of them
can be researched. Four of the nine nodes as drawn broke that, or else unlocked
something no chunk has built:

```text
  node            unlocked                 why it could not
  automation_1    assembler, splitter      C20's starting kit contains an
                                           assembler; a locked building the
                                           player is given is one they cannot
                                           place
  electronics_1   circuit, wire            the inserter, the miner and the lab
                                           are all made of circuits
  smelting_2      steel, brick             a furnace is twelve brick, and a
                                           furnace is a starting building
  logistics_1     underground belt         C23's building (§19 rule 4)
  exploration_1   radar, map               C23's, likewise
```

The shipped tree keeps five of the nine names, all of §15's costs, and the
shape of a spine: every node unlocks something that exists and creates a
decision rather than a number.

```text
          [start: miner, belt, inserter, chest, furnace,
                  generator, power pole, LAB, and every recipe
                  on the path to a data core]
                                |
                    logistics_1 (10 data_core)
                    unlocks: splitter, underground belt  (C23)
                    -> one line, two ways, and a line that
                       goes under whatever is in the way
                                |
                    smelting_2 (20 data_core)
                    unlocks: steel
                    -> a second smelting chain, 16 s a unit, and
                       the material everything below is made of
                                |
                    power_1 (40 data_core)
                    unlocks: electric furnace
                    -> one coal line to one generator, or one to
                       every furnace (C21's trade)
                                |
                +---------------+---------------+
                |                               |
        exploration_1 (50)              mining_2 (60)
        unlocks: radar          (C23)   unlocks: miner tier 2 (1.0/s)
        -> find the next patch          -> every ratio re-derived
           before you need it                       |
                                        construction_1 (100)
                                        unlocks: frame, assembler tier 2
                                        -> the machine §15's recipe times
                                           were actually written for
```

Six technologies, 280 data cores in total, and at one lab that is about
twenty-five minutes of research spread across a game that has to build the
science line to pay for it. `construction_1` requires `mining_2`, so the spine
is a chain with two leaves hanging off it rather than a diamond — a tree with
three ways in would be a menu, not a progression.

**C23's node is a leaf, and that is the whole of why it is where it is.**
Appending a node needs no save migration; inserting one into the spine would
renumber what depends on what. Its fifty cores sit between `power_1`'s forty
and `mining_2`'s sixty, and the *ordering* is the point rather than the number:
a player who has just electrified their smelting should find the next patch
before they double the rate at which they empty the current one.

**What became of the other four names.** `electronics_1` is **struck**:
everything it unlocked is on the path to the first lab, and a node that
unlocks nothing fails C22's own test. `automation_1` is **struck** for as long
as the starting kit contains an assembler — it is the strongest first unlock
in the genre and it is unavailable while the player is handed the thing it
would grant, which is a *content* decision about the kit and is named in C22's
"Noticed, not fixed". `logistics_2` (fast belt, fast inserter) waits for a
renderer that can tell two belt tiers apart. **`exploration_1` came back in
C23**, and it unlocks the radar alone: the **map panel is not gated**, because
the explored set fills from the player's own legs from the first tick and a map
you cannot open until the fifth technology is an hour of walking with nothing
to show for it. What the radar unlocks is ground the player has *not* walked,
which is the part worth earning. C23 also added the underground belt to
`logistics_1` — appending an unlock to an existing node, which needs no save
migration, rather than adding a prerequisite to one, which would.

**Only `mining_2` is a numerical upgrade**, and §15's original claim about it
holds: doubling a miner to 1.0 items/s re-derives every ratio downstream of it,
so a line built for tier-1 miners becomes short of furnaces rather than short
of ore. Everything else unlocks a **new verb**.

### How long the starting area lasts (C23)

C23 task 1 asks that "starting-area patches must be exhaustible in roughly 2–4
hours of play". That is a claim about a number nobody had measured, so C23
measured it before changing anything — and **nothing needed changing**, which
is the finding.

The starting area is C19's disc: `START_RADIUS` tiles around spawn. Its budget
is every resource tile in it; the draw it is measured against is a **reference
starting factory**, and these four are **balance numbers** derived from §15's
own chains rather than chosen:

```text
                 miners    draw      median across 24 seeds
  iron              4      2.0/s     2.6 h      <- binding
  copper            2      1.0/s     4.9 h
  coal              2      1.0/s     3.4 h
  stone             1      0.5/s     4.0 h
```

Four iron miners is what §15's ratios make a plausible first factory: one
miner feeds 1.6 plate furnaces, so four feed six — about the smelting column a
player has built by the time they are researching. Copper's draw is half
iron's because copper only reaches wire and circuits; stone's is a quarter
because brick's only consumer is `make_furnace`.

**Iron is the binding resource, and that is the point.** It runs out first by a
wide margin, because it is the material every recipe in §15 eventually reaches
— so the "2–4 hours" is a statement about *iron*, and iron is what sends the
player out of the starting area. A start that ran out of everything at once
would be a start that ended rather than one that moved.

`tests/balance/scarcity.test.ts` holds all of it: the band on iron's median,
a per-seed ceiling on iron, a floor and a looser ceiling on the rest, and a
guard that the reference draw is a whole number of tier-1 miners. The "visibly
runs out" half of C23's acceptance was already tested — C11's miner reports
`no_resource` and raises exactly one alert when its tiles are dry.

---

## §16 Performance strategy & optimisation paths

### The rule

```text
1. Write the readable version.
2. Ship it.
3. Measure it (C28).
4. Optimise only what the measurement flagged.
5. Re-measure. Keep the change only if it actually helped.
```

### What to be careful about anyway

Being unmeasured is not a licence to be careless in the tick loop. In
`simulation.tick()` and the systems it calls:

- Avoid allocating per entity per tick — no `map`/`filter`/`flatMap`, no object
  or array literals, no closures created inside the loop. Hoist scratch objects.
- Avoid `try/catch` in the innermost loops.
- Avoid megamorphic property access — keep entity shapes monomorphic per type
  (always initialise every field, never `delete` a property).
- **The same rule applies to object *literals* that implement an interface.**
  Two literals with different key sequences are two hidden classes, and every
  call site that reads one turns polymorphic. C21 learned this the expensive
  way: a six-key wrapper around `containerPort` written in a different key
  order cost **~15% of a thousand-furnace tick**, because
  `production-system.ts` reads three ports per machine per tick. The fix was
  to reorder six lines. If a second constructor for a hot interface is
  unavoidable, give it the same keys in the same order and say so in a comment
  beside both.
- Prefer `for (let i = 0; i < n; i++)` over `for...of` on hot arrays.

Outside the tick loop — UI, worldgen, serialization, setup — write whatever is
clearest. These rules are not a global style guide, and applying them everywhere
is its own kind of damage.

### Typed arrays

Good candidates: world chunk terrain and resources (already), belt item arrays,
machine progress in an SoA layout, the occupancy grid.

Bad candidates: entity definitions, registries, view models, anything the UI
touches, anything with fewer than a few thousand elements.

Do not introduce a typed array because it is theoretically faster. Introduce it
because C28 said so.

### Renderer path

```text
Canvas 2D + cached terrain world chunks     <- C03, should carry to ~20k entities
        + image sprite atlas                <- C29
        + spatial-index culling             <- C29 if needed
        + dirty rectangles                  <- C29 if needed
        v
WebGL2 + batched sprite rendering           <- only if all of the above fails
```

The simulation must be **completely unchanged** by any of this. If a renderer
optimisation requires a simulation change, the layering is wrong.

---

## §17 Testing strategy

### Layers

| Layer | Environment | What |
|---|---|---|
| Unit | node | inventory, recipes, belts, inserters, collision, depletion, prerequisites, command validation, serialization, migration, worldgen, projection |
| Integration | node, **no DOM, no canvas** | full production chains |
| Balance | node | §15's ratios against the content tables, and against a factory that runs (C20) |
| Determinism | node | hash equality across reruns, frame patterns, build orders, save round-trips |
| Benchmark | node | per-system tick cost against committed baselines |
| UI | jsdom | panel mount/update, no-subtree-rebuild, controller boundary |
| Manual | browser | feel, art, acceptance criteria that say "visibly" |

### Required integration chains

Each is a headless test asserting exact item counts after an exact tick count:

```text
miner -> chest                                    (C11)
miner -> belt -> chest                            (C13)
miner -> belt -> inserter -> chest                (C14)
miner -> belt -> inserter -> furnace -> inserter -> chest      (C15)
ore -> smelt -> assemble -> chest                 (C16, tests/integration/ore-to-gears.test.ts)
belt -> splitter -> 2 belts -> 2 chests           (C17, tests/integration/belt-splitter-chests.test.ts)
ore -> smelt -> assemble -> a placed building     (C20, tests/integration/factory-builds-itself.test.ts)
coal -> belt -> generator -> poles -> electric furnace          (C21, tests/integration/coal-to-power.test.ts)
full chain with power browning out                (C21, tests/unit/power-system.test.ts)
full chain producing data cores -> lab -> research complete    (C22)
belt -> underground run -> belt -> chest          (C23, tests/integration/belt-underground-chest.test.ts)
```

C23's chain is the only one in this list that is a **comparison** rather than a
count: it runs a buried line and a surface line of the same length side by side
for a saturated minute and asserts they deliver the same number. An exact count
would have pinned §9's fixed-point arithmetic; what must never change is that
the two are equal.

### The four tests that must never be deleted

1. `no-dom-in-game.test.ts` (C00) — protects the architecture.
2. Determinism rerun hash (C18) — protects the simulation.
   (`tests/determinism/determinism.test.ts`, with the harness beside it.)
3. Save round-trip equality (C24) — protects saves.
4. The C15 vertical-slice chain — protects the game.
   (`tests/integration/vertical-slice.test.ts`, written in C15.)

A fifth joined them in C20 and is named separately because it protects
something the other four do not — the **content**, rather than the code:
`tests/balance/ratios.test.ts`. Every rate in §15 is derived from every other,
and a number changed without re-deriving the table produces a game that still
runs and is no longer balanced, which no defect test can see. If it fails, the
answer is to re-derive §15, not to widen the tolerance.

If a refactor breaks one of these, the refactor is wrong. Do not update the test
to match the new behaviour without an explicit, reasoned decision recorded in the
chunk report.

### What not to test

Renderer pixel output, animation timing, exact DOM structure, or anything whose
assertion would have to be rewritten every time the design changes. Verify those
by eye against the acceptance criteria.

---

## §18 Risk register

| # | Risk | Likelihood | Impact | Mitigation | Chunk |
|---|---|---|---|---|---|
| 1 | Belt simulation becomes the bottleneck | High | High | Readable version first; belt-network path pre-designed; benchmarks from C28 | C13, C29 |
| 2 | Isometric depth sorting breaks with tall multi-tile buildings | High | Medium | Explicit depth key with entity-id tie-break; overlays drawn last | C03 |
| 3 | Isometric mouse picking feels imprecise | Medium | High | Ground-tile transform plus reverse-depth entity hit test; tested round-trip | C04 |
| 4 | Determinism drifts silently | High | High | Contract in §6; lint rules from C00; hash tests from C18; round-trip from C24 | C18, C24 |
| 5 | Save files balloon | Medium | Medium | World-delta strategy decided up front (§14); size budget asserted | C24 |
| 6 | Canvas 2D fill rate at zoom-out | Medium | Medium | Terrain world-chunk caching from C03, not retrofitted | C03 |
| 7 | The game is not fun | Medium | **Fatal** | C20 is a hard gate with honest written answers | C20 |
| 8 | Scope creep into excluded features | High | High | §2 exclusion table with reasons; Rule 12 | all |
| 9 | Art blocks mechanics | Medium | Medium | Procedural placeholders from C03; `SpriteAtlas` swap at C29 | C03, C29 |
| 10 | Content balance is incoherent after tweaks | Medium | Medium | §15 ratios as balance tests, re-derived not nudged | C20 |
| 11 | Infinite infrastructure, no game | High | High | C20 gate; the governing metric in §1; Rule 4 | all |
| 12 | Background-tab time accumulation freezes the game | Medium | High | Accumulator clamps in §8, tested in C00 | C00 |
| 13 | IndexedDB unavailable or full | Medium | High | §14 failure table, each with a tested path | C25 |
| 14 | Worldgen change invalidates old saves | Medium | Medium | `generatorVersion` in saves from C24; migration policy in C27 | C24, C27 |

---

## §19 Rules for the implementing agent

**Process**

1. **One build chunk at a time.** Complete it, report, then move on.
2. **The application must run at the end of every chunk.** No half-migrated states
   committed.
3. **Every chunk ships its tests.** A chunk without tests is not done.
4. **Do not implement future chunks in advance.** Not even "while I'm here".
5. **Do not refactor unrelated systems inside a chunk** unless they directly block
   the work. If you find something wrong elsewhere, note it in the report.

**Architecture**

6. **Never import DOM, Canvas or Vite into `game/`.** The C00 test enforces it.
7. **The renderer never mutates authoritative state.**
8. **The UI never mutates authoritative state.** It dispatches commands.
9. **Never add a framework** to solve something browser APIs and TypeScript do
   cleanly.
10. **Never create an abstraction for a hypothetical future feature.** The
    `SpriteAtlas`/`Renderer` interfaces are the two sanctioned exceptions, and
    both have two real implementations planned.
11. **Do not touch the projection contract (§5).** No projection math outside
    `projection.ts`; no isometric concepts inside `game/`.

**Simulation**

12. **Progress is integer ticks.** Never accumulate floats (§6 R3).
13. **No `Math.random`, `Date.now` or `performance.now` in `game/`** (§6 R1).
14. **Never iterate a `Map` or `Set` in a simulation system** (§6 R4).
15. **Resolve contention by entity id** (§6 R6).
16. **Every player action is a command** (§7), validated inside the simulation,
    rejected with a visible reason.

**Content**

17. **Content lives in `data/`, logic lives in systems.** A system with a
    per-recipe or per-building special case is a defect.
18. **Update §15 when content changes**, and re-derive the ratios rather than
    nudging one number.

**Scope**

19. **Do not implement anything from the §2 exclusion table** without an explicit
    instruction.
20. **Profile before optimising** (§16).

**Repository**

21. **Commit directly to `main`.** No feature branches, no pull requests, no
    branch-per-chunk. This is a solo project and that ceremony does not earn its
    keep here. *(Decided 2026-09-10; this overrides the usual default of
    branching before committing.)*
22. **One commit per chunk**, made once the §20 checklist passes — not a stream
    of work-in-progress commits.
23. **Match the existing message style:** an uppercase `ADD:` / `FIX:` /
    `REWRITE:` prefix, then a subject line. The body explains decisions,
    deviations from this plan, and anything surprising. It does not restate the
    list of changed files, which git already knows.
24. **Record every deviation from this plan in the plan itself**, in the section
    it deviates from, in the same commit that makes it. A refinement that lives
    only in a commit message will be "fixed" back by a later chunk.

---

## §20 Definition of done

### Per chunk

- [ ] `npm run typecheck` — zero errors
- [ ] `npm run lint` — zero errors, including boundary and determinism rules
- [ ] `npm run test` — all green, including the four protected tests (§17)
- [ ] `npm run build` — succeeds
- [ ] Every acceptance criterion in the chunk verified, by test or by hand
- [ ] The feature works in the running application, not only in tests
- [ ] No new runtime dependency, or an explicit justification against §3
- [ ] No console errors or warnings during normal play
- [ ] Architecture rules (§19) intact
- [ ] Chunk report written (below)

### Chunk report format

```text
CHUNK Cxx — <name>

Files created/changed
Architecture decisions made (and any §-contract implications)
Tests added, and what they protect
Build / typecheck / lint / test results
Acceptance criteria: each one, pass or fail, with evidence
Known issues and deliberate omissions
Anything noticed but not fixed (per Rule 5)
Recommended next chunk
```

### Milestone gates

| Gate | Condition |
|---|---|
| After C07 | The prototype is navigable and buildings can be placed. **Passed.** |
| After C15 | **The vertical slice runs unattended.** If it does not, nothing after this matters. **Passed** — twenty simulated minutes, two mining chains, plates at 0.3125/s ±2%. |
| After C18 | **Determinism holds.** Do not build worldgen on a nondeterministic simulation. |
| After C20 | **The game is fun.** Answered honestly, in writing. Failing this means staying in C20. |
| After C24 | The save round-trip determinism test passes. |
| After C29 | Every §12 budget is met on the reference factory. |

---

## §21 Future architecture

The boundaries in Part I exist so that each of these is a *replacement*, not a
rewrite. None of them may be built now.

```text
Current                                Enabled by
-------------------------------------  ----------------------------------------
Pure TS simulation                     §4 dependency rules
Canvas 2D renderer                     Renderer interface (C03)
DOM UI                                 GameController facade (C07)
IndexedDB persistence                  SaveRepository interface (C25)

Possible later
-------------------------------------  ----------------------------------------
WebGL2 renderer                        Renderer interface; §16 path
Web Worker simulation                  plain-data entities (C05), plain commands (C04)
Replay system                          determinism contract (§6), plain commands
Multiplayer (lockstep)                 determinism + command queue + replay
Blueprints                             plain-data entities, command architecture
Mod / content packages                 data-driven registries (C06, C15, C22)
Fluids, trains, circuits               nothing blocks them; nothing anticipates them
```

The goal is to preserve clean boundaries, **not** to build tomorrow's systems today.

---

## §22 First instruction

Begin with:

> ### **C00 — Project foundation & test harness**

Read Part I in full first. Then implement C00 and only C00.

When it is done, produce the chunk report from §20 and stop for review before
starting C01.

---

## Appendix — what changed in revision 2

For anyone comparing against the original document (git `565f17b`):

**Resolved contradictions**
- The plan said "top-down grid"; the art sheet says "isometric". Resolved in §5:
  projection-agnostic simulation, isometric renderer, one transform file.
- Rule 10 required acceptance criteria for every chunk; only 4 of 28 had them.
  All 31 chunks now do, and they are concrete.
- Chunks 21 (power) and 22 (enemies) appeared in no milestone. Power is now C21
  in Milestone C; enemies are C31, explicitly gated with a decision procedure.

**Added contracts**
- §6 determinism contract with 8 numbered, testable rules — including the two
  hazards most likely to bite: `Map` iteration order differing after a load, and
  float progress accumulation.
- §5 projection contract, including depth sorting and the three isometric hazards.
- §9 belt model decided up front (one lane, 4 slots/tile, fixed-point positions,
  belt items are not entities) because it constrains everything downstream.
- §8 loop clamps (`MAX_FRAME_MS`, `MAX_STEPS_PER_FRAME`, debt shedding) and the
  intra-phase ordering rules that the original's phase list omitted.
- §12 numeric performance budgets and a defined reference factory, replacing
  "good performance at reasonably large factory sizes".
- §14 world-delta persistence strategy and a table of seven failure modes
  (IndexedDB blocked, quota, corruption, multi-tab, autosave) — none of which the
  original mentioned.
- §11 design tokens and a placeholder-first art pipeline, derived from the two
  reference images the original never referenced.
- §15 a complete, ratio-coherent content bible, replacing "balance to be
  determined through playtesting" with numbers an agent can actually implement.
- §18 a risk register with mitigations mapped to chunks.

**Added chunks**
- C00 now includes the test harness, lint boundary enforcement and scripts — the
  original required tests and a "tests pass" definition of done while never
  setting up a test runner.
- C10 player character and manual gathering — the original's progression section
  opened with "Phase 1: manual gathering" and no chunk ever implemented it.
- C17 splitters — the highest decisions-per-complexity building available, and
  present on the art sheet.
- C20 is now an explicit stop-and-tune gate with written, honest questions.
- C28 separates instrumentation from optimisation, so "profile before optimising"
  becomes a schedulable step rather than advice.
- C30 audio, accessibility and onboarding, which the original left as "polish".

**Restructured**
- Three parts (contracts / chunks / reference) instead of 60 flat sections with a
  confusing dual numbering where "§10" meant "Chunk 00".
- Build chunks are `C00`–`C31` and world chunks are "world chunks", ending the
  collision between two meanings of the same word.
- Every chunk has the same seven-field shape, so the agent always knows where to
  look for scope boundaries.
