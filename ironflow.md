# AI Implementation Plan --- Browser Factory Game (Vite + Pure TypeScript)

## 0. Purpose

This document is a practical roadmap for an AI coding agent implementing
a small, replayable 2D factory/automation game for the browser.

The project deliberately avoids a game engine and a UI framework.

The application should be built from:

-   TypeScript
-   Vite
-   DOM APIs
-   Canvas 2D initially
-   IndexedDB
-   Browser APIs
-   small, purpose-specific utilities only when justified

The architecture must keep the game simulation independent from the
browser UI and renderer as much as practical.

The objective is **not** to reproduce Factorio. The goal is to create an
original factory-building game with a satisfying automation loop and
enough procedural variation to make repeated runs interesting.

------------------------------------------------------------------------

# 1. Product priorities

Priority order:

1.  Fun factory-building loop
2.  Replayability
3.  Clear and satisfying automation
4.  Meaningful factory-layout decisions
5.  Stable simulation
6.  Good performance at reasonably large factory sizes
7.  Persistence and portability
8.  Visual polish

Do not sacrifice gameplay iteration in order to prematurely build
sophisticated infrastructure.

------------------------------------------------------------------------

# 2. Explicit v1 scope

## Included

-   Single-player
-   2D top-down/grid-based world
-   Procedurally generated world
-   Resource patches
-   Mining
-   Belts
-   Inserters
-   Machines
-   Production recipes
-   Research/progression
-   Basic power system
-   Expansion/exploration
-   Save/load
-   IndexedDB persistence
-   Export/import save files
-   Basic enemies only if they improve the core loop
-   Custom rendering
-   Deterministic seeded world generation

## Excluded from v1

Do not implement unless explicitly requested:

-   Multiplayer
-   Networking
-   Backend
-   Accounts
-   Cloud saves
-   Modding API
-   Blueprint system
-   Trains
-   Complex circuit networks
-   Complex fluid simulation
-   Robots/logistic bots
-   Massive AI systems
-   Workshop/content marketplace
-   Server-side simulation

These may become future features, but should not shape the
implementation prematurely.

------------------------------------------------------------------------

# 3. Technology stack

## Required

``` text
TypeScript
Vite
Canvas 2D
DOM
IndexedDB
```

## Later option

``` text
WebGL2
```

The renderer must be abstracted sufficiently that Canvas 2D can
eventually be replaced by WebGL2.

## Avoid initially

``` text
Angular
React
Vue
Svelte
game engines
ECS frameworks
physics engines
large state-management libraries
large UI component libraries
```

Vite is only the build/dev tool. It must not become part of the game
architecture.

------------------------------------------------------------------------

# 4. Fundamental architectural rule

The project consists of five major areas:

``` text
                Browser
                   |
          +--------+--------+
          |                 |
         UI              Renderer
          |                 |
          +--------+--------+
                   |
                 Game
                   |
              Simulation
                   |
        +----------+----------+
        |          |          |
      World    Entities   Systems
                   |
              Persistence
```

More explicitly:

``` text
src/
  game/
  renderer/
  input/
  ui/
  persistence/
  main.ts
```

## Dependency rules

### Game core

Must not import:

-   DOM
-   Canvas
-   Vite
-   UI code

### Renderer

May consume game/render state but must not mutate authoritative
simulation state.

### UI

May issue commands through the game facade/controller.

UI must not directly mutate machines, belts, inventories, etc.

### Persistence

Serializes/deserializes plain game state.

Do not persist class instances.

### Input

Converts browser input into game commands/actions.

------------------------------------------------------------------------

# 5. Why pure TypeScript

Do not build a custom UI framework.

Use normal browser APIs:

``` ts
document.createElement(...)
element.append(...)
element.addEventListener(...)
element.textContent = ...
element.classList.toggle(...)
```

Use HTML/CSS for menus and panels.

Use Canvas for the actual game world.

The UI should update explicitly when relevant state changes.

Do not build a virtual DOM.

Do not build a generic signal/reactivity system.

Do not build a component framework.

------------------------------------------------------------------------

# 6. Recommended project structure

Start with:

``` text
src/
  main.ts

  game/
    game.ts
    game-loop.ts
    simulation.ts
    simulation-clock.ts

    world/
      world.ts
      chunk.ts
      tile.ts
      coordinates.ts
      world-generator.ts

    entities/
      entity.ts
      entity-store.ts
      entity-types.ts

    buildings/
      building-definition.ts
      building-instance.ts
      building-registry.ts
      building-system.ts

    items/
      item-definition.ts
      item-registry.ts
      inventory.ts

    recipes/
      recipe-definition.ts
      recipe-registry.ts

    logistics/
      belt.ts
      belt-system.ts
      inserter.ts
      inserter-system.ts

    production/
      production-system.ts

    research/
      technology-definition.ts
      research-system.ts

    player/
      player-state.ts

    commands/
      command.ts
      command-processor.ts
      build-command.ts
      remove-command.ts
      rotate-command.ts

    save/
      game-state.ts
      save-serializer.ts
      save-migrator.ts

  renderer/
    renderer.ts
    canvas-renderer.ts
    camera.ts
    sprite-atlas.ts
    render-state.ts

  input/
    input-manager.ts
    mouse-input.ts
    keyboard-input.ts

  ui/
    ui.ts
    hud.ts
    build-menu.ts
    inspector.ts
    inventory-panel.ts
    research-panel.ts
    save-menu.ts
    notifications.ts

  persistence/
    save-repository.ts
    indexeddb-save-repository.ts
    export-import.ts

  debug/
    debug-overlay.ts
    profiler.ts

  styles/
    main.css
```

Do not create all files at once. Create them as their corresponding
chunks require them.

------------------------------------------------------------------------

# 7. Core runtime architecture

The central runtime should look approximately like:

``` ts
const simulation = new Simulation(...);
const renderer = new CanvasRenderer(canvas);
const input = new InputManager(canvas);
const ui = new UI(...);

const game = new Game({
  simulation,
  renderer,
  input,
  ui,
});

game.start();
```

The `Game` coordinates systems but should not contain their detailed
business logic.

------------------------------------------------------------------------

# 8. Game loop

Use `requestAnimationFrame`.

Simulation must use a fixed timestep.

Example:

``` ts
const SIMULATION_DT = 1 / 30;
```

Conceptually:

``` text
requestAnimationFrame
        |
        v
 accumulate elapsed time
        |
        +--> simulation.tick(dt)
        |
        +--> simulation.tick(dt)
        |
        v
 renderer.render(...)
```

Rendering frequency and simulation frequency must be independent.

Never make production speed depend directly on FPS.

------------------------------------------------------------------------

# 9. Simulation phases

Define and document a deterministic update order.

Initial recommendation:

``` text
1. process commands
2. resource extraction
3. machine production
4. belt movement
5. inserter transfers
6. machine state transitions
7. research/progression
8. power calculations
9. cleanup
```

The exact order can change as mechanics evolve.

The important rule is:

> Every simulation tick has a documented and deterministic order.

------------------------------------------------------------------------

# 10. Chunk 00 --- Vite + TypeScript foundation

## Goal

Create a minimal runnable project.

## Tasks

1.  Initialize Vite.
2.  Select TypeScript.
3.  Configure strict TypeScript settings.
4.  Create `src/main.ts`.
5.  Create a full-screen game canvas.
6.  Create basic CSS reset/layout.
7.  Create a `Game` class.
8.  Create a `GameLoop`.
9.  Render a plain background.
10. Add basic FPS/debug text.

## Acceptance criteria

-   `npm run dev` starts the application.
-   Production build succeeds.
-   Canvas fills the intended viewport.
-   Game loop runs.
-   No framework other than Vite is required.
-   TypeScript strict mode is enabled.

------------------------------------------------------------------------

# 11. Chunk 01 --- Camera and coordinates

## Goal

Create the coordinate foundation.

World coordinates:

``` text
+X = right
+Y = down
```

Define:

``` ts
interface TileCoord {
  x: number;
  y: number;
}
```

Camera:

``` ts
class Camera {
  x: number;
  y: number;
  zoom: number;

  worldToScreen(...);
  screenToWorld(...);
}
```

Implement:

-   pan
-   zoom
-   screen-to-world
-   world-to-screen
-   cursor-centered zoom if practical

## Acceptance criteria

-   Camera pans.
-   Camera zooms.
-   Mouse position resolves to a tile.
-   Grid remains aligned at different zoom levels.

------------------------------------------------------------------------

# 12. Chunk 02 --- World and chunk storage

## Goal

Support a large world efficiently.

Use chunks.

Initial chunk size:

``` text
32 × 32
```

Use numeric tile IDs.

Example:

``` ts
enum TileType {
  Grass = 0,
  Dirt = 1,
  Stone = 2,
  Water = 3,
}
```

Chunk:

``` ts
interface Chunk {
  cx: number;
  cy: number;
  tiles: Uint16Array;
}
```

The world lazily creates chunks.

## Acceptance criteria

-   Positive and negative world coordinates work.
-   Chunks are created lazily.
-   Tile lookup works.
-   Visible chunks can be calculated.
-   Only visible chunks are rendered.

------------------------------------------------------------------------

# 13. Chunk 03 --- Canvas renderer

## Goal

Create a renderer abstraction.

``` ts
interface Renderer {
  resize(width: number, height: number): void;
  render(state: RenderState, camera: Camera): void;
  destroy(): void;
}
```

Implement:

``` ts
CanvasRenderer
```

Render:

-   terrain
-   grid
-   optional chunk boundaries
-   camera-relative view

Keep rendering code separate from game logic.

## Acceptance criteria

-   World renders correctly while camera moves.
-   Zoom works.
-   Renderer has no dependency on UI.
-   Simulation does not directly call Canvas APIs.

------------------------------------------------------------------------

# 14. Chunk 04 --- Browser input

## Goal

Convert browser input into game actions.

Implement:

-   mouse movement
-   click
-   right-click
-   wheel
-   keyboard
-   camera dragging

Create an input manager.

Do not let arbitrary DOM callbacks mutate the simulation.

Prefer:

``` text
DOM event
  ->
InputManager
  ->
GameCommand
  ->
Simulation
```

------------------------------------------------------------------------

# 15. Chunk 05 --- Entity store

## Goal

Introduce stable entity IDs.

``` ts
type EntityId = number;
```

Basic entity:

``` ts
interface Entity {
  id: EntityId;
  type: EntityType;
  x: number;
  y: number;
  rotation: number;
}
```

Create:

``` ts
EntityStore
```

Operations:

``` ts
create()
get()
has()
remove()
forEach()
```

Do not implement a full ECS.

Use ordinary TypeScript objects initially.

Optimize only after profiling.

------------------------------------------------------------------------

# 16. Chunk 06 --- Data-driven building definitions

## Goal

Define buildings as data.

``` ts
interface BuildingDefinition {
  id: string;
  size: {
    width: number;
    height: number;
  };
  category: string;
  buildCost: ItemStack[];
  rotationCount: number;
}
```

Create:

``` text
BuildingRegistry
```

First buildings:

``` text
miner
chest
```

Implement:

-   selection
-   ghost preview
-   placement
-   rotation
-   collision
-   removal

Initially building can be instant.

------------------------------------------------------------------------

# 17. Chunk 07 --- UI foundation

## Goal

Build the minimal HTML UI without a framework.

Create:

``` ts
class UI
```

Responsibilities:

-   create static UI structure
-   update HUD
-   open/close panels
-   show selected entity
-   show build menu

Use DOM APIs directly.

Example:

``` ts
const panel = document.createElement('div');
panel.className = 'building-panel';
```

Do not update the whole UI every simulation tick.

Use explicit update calls.

------------------------------------------------------------------------

# 18. Chunk 08 --- Items and inventories

## Goal

Create the item system.

Item definition:

``` ts
interface ItemDefinition {
  id: string;
  name: string;
  stackSize: number;
}
```

Inventory:

``` ts
class Inventory {
  add(itemId, amount): number;
  remove(itemId, amount): number;
  count(itemId): number;
  canAdd(itemId, amount): boolean;
}
```

First items:

``` text
iron_ore
copper_ore
coal
stone
iron_plate
copper_plate
```

Inventory must enforce stack limits.

------------------------------------------------------------------------

# 19. Chunk 09 --- Resource patches

## Goal

Create mineable resources.

Each resource tile stores:

``` text
resource type
remaining amount
```

Use compact storage where practical.

First resources:

``` text
iron
copper
coal
stone
```

Implement:

-   generation
-   rendering
-   depletion
-   resource lookup

------------------------------------------------------------------------

# 20. Chunk 10 --- Mining

## Goal

Create the first productive machine.

Miner:

``` text
resource tile
    ->
mining interval
    ->
output buffer
```

Miner has:

-   mining speed
-   target resource
-   output buffer
-   progress

First automation milestone:

``` text
resource patch
    ->
miner
    ->
output inventory
```

------------------------------------------------------------------------

# 21. Chunk 11 --- Inspector UI

Clicking a machine should display:

``` text
Machine
Status
Progress
Output
Production rate
```

The UI should obtain a read-only view model.

Example:

``` ts
interface MachineView {
  name: string;
  progress: number;
  output: ItemStack[];
}
```

Do not expose mutable simulation objects directly to UI code.

------------------------------------------------------------------------

# 22. Chunk 12 --- Belts

## Goal

Implement logistics.

A belt occupies one tile and has a direction.

Logical belt state:

``` text
direction
speed
items
input/output connectivity
```

Do not represent belt items as general entities unless profiling proves
that necessary.

A possible initial representation:

``` ts
interface BeltItem {
  itemId: string;
  position: number;
}
```

Implement:

-   insertion
-   movement
-   blocking
-   output
-   connection
-   direction
-   belt-to-belt transfer

First logistics chain:

``` text
miner -> belt -> chest
```

------------------------------------------------------------------------

# 23. Chunk 13 --- Inserters

## Goal

Move items between belts and machines.

State machine:

``` text
Idle
  ->
Pickup
  ->
Carry
  ->
Drop
  ->
Idle
```

Implement:

-   pickup position
-   drop position
-   rotation
-   speed
-   source validation
-   destination validation

First complete chain:

``` text
miner
  ->
belt
  ->
inserter
  ->
chest
```

------------------------------------------------------------------------

# 24. Chunk 14 --- Furnace

## Goal

Create processing.

Recipe model:

``` ts
interface RecipeDefinition {
  id: string;
  inputs: ItemStack[];
  outputs: ItemStack[];
  duration: number;
}
```

Furnace:

``` text
input
fuel
output
recipe
progress
```

First recipe:

``` text
iron_ore + coal
    ->
iron_plate
```

Complete chain:

``` text
iron patch
  ->
miner
  ->
belt
  ->
inserter
  ->
furnace
  ->
inserter
  ->
chest
```

This is the first major vertical slice.

------------------------------------------------------------------------

# 25. Chunk 15 --- Assembler

## Goal

Support multi-input production.

Assembler:

-   input inventories
-   output buffer
-   selected recipe
-   progress
-   blocked output handling

First intermediate recipe:

``` text
iron_plate + copper_plate
    ->
gear
```

Make recipes data-driven.

The assembler should not contain special cases for individual recipes.

------------------------------------------------------------------------

# 26. Chunk 16 --- First gameplay loop

Stop adding systems temporarily.

Tune the following:

``` text
collect
  ->
build
  ->
automate
  ->
increase throughput
  ->
unlock
  ->
rebuild
```

Target initial content:

``` text
5-8 buildings
8-15 items
8-15 recipes
```

The game should already be somewhat enjoyable before progression becomes
complex.

This milestone is more important than adding more infrastructure.

------------------------------------------------------------------------

# 27. Chunk 17 --- Fixed timestep and simulation cleanup

Formalize the simulation clock.

Recommended:

``` ts
const SIMULATION_DT = 1 / 30;
```

The game should be deterministic for a given:

``` text
seed
initial state
command sequence
number of ticks
```

Avoid `Math.random()` in simulation-critical code.

Create a seeded PRNG.

------------------------------------------------------------------------

# 28. Chunk 18 --- Procedural world generation

## Goal

Make new games meaningfully different.

Implement:

``` ts
generateWorld(seed)
```

Generate:

-   terrain
-   resource patches
-   patch size
-   richness
-   optional obstacles
-   starting area

Use deterministic randomness.

Validate generated worlds so the player cannot spawn in an impossible
location.

------------------------------------------------------------------------

# 29. Chunk 19 --- Exploration and expansion

Give the player reasons to expand.

Introduce:

-   larger world
-   resource scarcity
-   distant resource patches
-   terrain constraints
-   higher-value resources

The goal is that factory placement becomes a strategic decision.

Avoid adding enemies solely to create artificial pressure.

------------------------------------------------------------------------

# 30. Chunk 20 --- Research and progression

Technology:

``` ts
interface TechnologyDefinition {
  id: string;
  prerequisites: string[];
  cost: ItemStack[];
  unlocks: Unlock[];
}
```

Create a small technology tree.

Example:

``` text
Basic Automation
       |
Improved Mining
       |
Faster Belts
       |
Assembler
       |
Advanced Processing
```

Prefer unlocks that create new gameplay decisions over simple +5%
numerical bonuses.

------------------------------------------------------------------------

# 31. Chunk 21 --- Power

Only implement after the core loop is fun.

Start simple:

``` text
Generator
    ->
Power network
    ->
Machines
```

Machines have:

``` ts
powerConsumption
```

Generators have:

``` ts
powerProduction
```

Initial power network can be based on connected components.

Do not implement realistic electrical simulation.

------------------------------------------------------------------------

# 32. Chunk 22 --- Optional enemies

Only proceed if enemies make the game more engaging.

Initial behavior:

``` text
spawn
  ->
find target
  ->
move
  ->
attack
  ->
die
```

Do not build sophisticated AI.

Enemies should introduce meaningful factory/expansion decisions rather
than become a constant nuisance.

------------------------------------------------------------------------

# 33. Chunk 23 --- Save state model

Create a serializable representation separate from runtime classes.

``` ts
interface SaveFile {
  version: number;
  metadata: SaveMetadata;
  state: SerializedGameState;
}
```

Example:

``` ts
interface SerializedGameState {
  seed: number;
  simulationTime: number;
  player: SerializedPlayerState;
  chunks: SerializedChunk[];
  entities: SerializedEntity[];
  research: SerializedResearchState;
}
```

Never serialize arbitrary class instances.

------------------------------------------------------------------------

# 34. Chunk 24 --- IndexedDB persistence

Create:

``` ts
interface SaveRepository {
  list(): Promise<SaveMetadata[]>;
  save(save: SaveFile): Promise<void>;
  load(id: string): Promise<SaveFile>;
  delete(id: string): Promise<void>;
}
```

Implement:

``` text
IndexedDbSaveRepository
```

Store saves in a dedicated IndexedDB database.

The persistence layer must be independent of the game loop.

------------------------------------------------------------------------

# 35. Chunk 25 --- Export/import

Implement portable save files.

Initial format:

``` text
factory-save-v1.json
```

Export:

``` ts
exportSave(): Blob
```

Import:

``` ts
importSave(file: File): Promise<SaveFile>
```

Validate imported state.

Validate:

-   save version
-   known item IDs
-   known building IDs
-   valid coordinates
-   valid amounts
-   valid recipe IDs
-   research IDs
-   finite numbers
-   reasonable array sizes

Never trust imported data.

------------------------------------------------------------------------

# 36. Chunk 26 --- Save migrations

Create:

``` ts
migrateSave(save: SaveFile): SaveFile
```

Future format:

``` text
v1 -> v2 -> v3
```

Each migration should be explicit and testable.

------------------------------------------------------------------------

# 37. Chunk 27 --- Performance instrumentation

Build a developer overlay.

Display:

``` text
FPS
simulation ms
render ms
entity count
belt count
machine count
visible chunks
simulation ticks/frame
```

Also measure individual systems:

``` text
Mining
Production
Belts
Inserters
Power
Rendering
```

Use profiling results to guide optimization.

------------------------------------------------------------------------

# 38. Performance strategy

The initial implementation should be simple.

Optimize only after profiling.

## Avoid unnecessary allocations in hot loops

Be cautious with:

``` ts
map()
filter()
flatMap()
new objects
new arrays
```

inside high-frequency simulation loops.

Do not ban these operations globally.

Use readable code first.

## Typed arrays

Good candidates:

-   tile IDs
-   resource amounts
-   compact flags
-   dense chunk data

Do not introduce typed arrays everywhere simply because they are
theoretically faster.

------------------------------------------------------------------------

# 39. Belt optimization path

Belts are likely to become one of the first hotspots.

Start with readable logic.

If profiling shows belts are expensive, consider:

``` text
individual belt objects
        ->
belt networks
        ->
compact arrays
```

Potential later representation:

``` text
BeltNetwork
  segments[]
  itemIds[]
  positions[]
```

Do not implement this complexity before it is needed.

------------------------------------------------------------------------

# 40. Renderer optimization path

Start with Canvas 2D.

Use:

``` text
visible chunks
    ->
terrain
    ->
visible entities
    ->
effects
```

Potential future:

``` text
CanvasRenderer
      |
      v
WebGLRenderer
      |
sprite atlas
      |
batched rendering
```

The simulation must remain unchanged when the renderer changes.

------------------------------------------------------------------------

# 41. UI architecture

Use ordinary DOM.

Suggested UI hierarchy:

``` text
GameUI
|
+-- HUD
+-- BuildMenu
+-- Inspector
+-- InventoryPanel
+-- ResearchPanel
+-- SaveMenu
+-- Notifications
```

These are UI classes, not game entities.

Each UI element should have a clear update method.

Example:

``` ts
class InspectorPanel {
  update(view: BuildingView | null): void;
}
```

Do not query the simulation from arbitrary UI components.

Prefer a facade/controller:

``` ts
GameController
```

that translates UI actions into commands and produces read-only views.

------------------------------------------------------------------------

# 42. UI update strategy

Do not update UI every simulation tick unless necessary.

Instead:

``` text
simulation
   |
   +--> state changes
           |
           v
     controller/UI
           |
           v
      DOM updates
```

For high-frequency values such as progress bars, update at a reasonable
UI frequency rather than blindly at every simulation tick.

The game world itself is always rendered independently.

------------------------------------------------------------------------

# 43. Command architecture

User actions should become commands.

Example:

``` ts
interface BuildCommand {
  type: 'build';
  buildingId: string;
  x: number;
  y: number;
  rotation: number;
}
```

Other commands:

``` text
remove
rotate
setRecipe
research
movePlayer
```

Flow:

``` text
DOM/input
  ->
command
  ->
simulation validates
  ->
world changes
```

The UI should never directly modify authoritative state.

------------------------------------------------------------------------

# 44. Authoritative vs derived state

Authoritative:

``` text
entity positions
inventory amounts
machine recipes
machine progress
resource amounts
research state
world seed
```

Derived:

``` text
production per minute
selected building panel
visible chunks
tooltip text
render batches
power percentage
```

Persist authoritative state.

Rebuild derived state after loading.

------------------------------------------------------------------------

# 45. Testing

## Unit tests

Prioritize:

-   inventory
-   recipe processing
-   belt movement
-   inserter transfers
-   building collision
-   resource depletion
-   research prerequisites
-   command validation
-   serialization
-   migration
-   deterministic world generation

## Integration tests

At minimum:

``` text
miner -> belt -> chest
```

``` text
miner -> belt -> furnace
```

``` text
miner -> belt -> inserter -> assembler
```

These tests should be able to run without Canvas or DOM.

------------------------------------------------------------------------

# 46. Determinism tests

For a fixed seed and command sequence:

``` text
run N ticks
```

must produce the same final authoritative state.

This enables:

-   reproducible bugs
-   simulation benchmarks
-   regression tests
-   easier balancing
-   potential future replay support

------------------------------------------------------------------------

# 47. Replayability design

The game should not rely on hundreds of buildings to stay interesting.

Replayability should emerge from:

``` text
procedural world
+
resource distribution
+
factory layout
+
technology choices
+
throughput optimization
+
expansion decisions
```

Potential later mechanics:

-   branching research
-   resource scarcity
-   varied patch shapes
-   starting-condition variation
-   optional objectives
-   map-specific opportunities

Do not implement all of these at once.

------------------------------------------------------------------------

# 48. Recommended initial content

## Resources

``` text
iron
copper
coal
stone
```

## Processed items

``` text
iron_plate
copper_plate
steel
```

## Intermediate items

``` text
gear
circuit
```

## Buildings

``` text
miner
belt
inserter
chest
furnace
assembler
generator
```

## Recipes

Approximately:

``` text
8-12
```

The exact balance should be determined through playtesting.

------------------------------------------------------------------------

# 49. Gameplay progression

Target experience:

## Phase 1

Manual gathering.

## Phase 2

First miner.

## Phase 3

First belt.

## Phase 4

Automated smelting.

## Phase 5

First assembler.

## Phase 6

Factory redesign.

## Phase 7

Technology unlock.

## Phase 8

Expansion into another resource region.

## Phase 9

More complicated logistics.

Then repeat with increasing complexity.

------------------------------------------------------------------------

# 50. AI coding-agent rules

## Rule 1

Implement one chunk at a time.

## Rule 2

Keep the application runnable after every chunk.

## Rule 3

Do not introduce a framework to solve a problem that can be solved
cleanly with TypeScript and browser APIs.

## Rule 4

Do not create abstractions solely for hypothetical future features.

## Rule 5

Profile before optimizing.

## Rule 6

Never import UI/browser code into simulation core.

## Rule 7

Never let renderer mutate authoritative state.

## Rule 8

Use commands for player actions.

## Rule 9

Prefer deterministic simulation.

## Rule 10

Every chunk must have concrete acceptance criteria.

## Rule 11

Do not refactor unrelated systems during a chunk unless they directly
block implementation.

## Rule 12

Do not implement excluded v1 features without explicit instruction.

------------------------------------------------------------------------

# 51. Implementation procedure for each chunk

For every chunk, the AI must:

``` text
1. Inspect existing implementation
2. Identify relevant existing APIs
3. Define the smallest required interfaces
4. Implement core logic
5. Add/update tests
6. Integrate with the game loop
7. Integrate renderer/UI if required
8. Run TypeScript/build
9. Run tests
10. Manually verify acceptance criteria
11. Report the result
12. Proceed only after the chunk is stable
```

Report after each major chunk:

``` text
Files changed
Architecture decisions
Tests added
Build/test result
Acceptance criteria
Known issues
Next recommended chunk
```

------------------------------------------------------------------------

# 52. Definition of done

A chunk is complete when:

-   TypeScript compiles
-   build succeeds
-   tests pass
-   acceptance criteria pass
-   feature works in the running application
-   no obvious runtime errors remain
-   architecture rules remain intact
-   no unnecessary dependency was introduced

------------------------------------------------------------------------

# 53. Milestone A --- Technical prototype

Implement:

``` text
00 Foundation
01 Camera
02 World
03 Renderer
04 Input
05 Entities
06 Building placement
07 UI foundation
```

Result:

> A player can move around a large grid, zoom/pan, and place/remove
> buildings through a basic UI.

------------------------------------------------------------------------

# 54. Milestone B --- First automation

Implement:

``` text
08 Items
09 Resources
10 Mining
11 Inspector
12 Belts
13 Inserters
14 Furnace
```

Result:

> Iron ore can be automatically mined, transported and smelted.

This is the first major playable milestone.

------------------------------------------------------------------------

# 55. Milestone C --- Factory game

Implement:

``` text
15 Assembler
16 Gameplay loop
17 Simulation timing
18 Procedural generation
19 Expansion
20 Research
```

Result:

> The player can start a new seeded world and build an increasingly
> complex automated factory.

------------------------------------------------------------------------

# 56. Milestone D --- Persistence

Implement:

``` text
23 Save state
24 IndexedDB
25 Export/import
26 Migration
```

Result:

> A factory survives browser restarts and can be moved between
> browsers/devices via exported save files.

------------------------------------------------------------------------

# 57. Milestone E --- Scale and polish

Implement:

``` text
27 Performance instrumentation
38 Renderer optimization where required
additional testing
balancing
UX
audio
visual polish
```

Only begin serious optimization after the game has a fun core loop.

------------------------------------------------------------------------

# 58. Future architecture

The current architecture should leave room for:

``` text
Current
|
+-- Pure TS simulation
+-- Canvas renderer
+-- Local persistence
+-- DOM UI
|
v
Potential future
|
+-- WebGL2 renderer
+-- Web Worker simulation
+-- replay system
+-- multiplayer
+-- blueprints
+-- mod/content packages
```

Do not implement these prematurely.

The goal is to preserve clean boundaries, not to build future systems
today.

------------------------------------------------------------------------

# 59. Most important principle

The project should maximize:

> **Interesting player decisions per unit of implementation
> complexity.**

Do not measure success by:

``` text
lines of code
number of classes
number of buildings
number of systems
```

Measure it by:

``` text
Can the player automate something?
Is improving the factory satisfying?
Does the next unlock create a new problem?
Does the world force different layouts?
Does a new seed produce a meaningfully different run?
Would the player start another run?
```

If these answers are weak, stop adding infrastructure and improve the
gameplay.

------------------------------------------------------------------------

# 60. Immediate instruction to the AI agent

Start with:

**Chunk 00 --- Vite + TypeScript foundation**

Do not implement future chunks in advance.

When Chunk 00 is complete, report:

``` text
- files created/changed
- architecture decisions
- tests added
- build verification
- acceptance criteria status
- known issues
- recommended next chunk
```

Then proceed sequentially.
