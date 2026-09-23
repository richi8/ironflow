/**
 * What the first-run objectives ask the game (C30 task 4; the quest chain since C31).
 *
 * The objectives themselves — their words, their order, what each one is
 * waiting for — are the UI's (`ui/objectives.ts`): they are a way of talking
 * to a new player, and §4 puts that side of the line. What the UI cannot do is
 * count, because counting means reading the world. So a goal is one of three
 * questions the controller can answer from state every player can see, asked
 * in content ids:
 *
 * ```text
 *   carried     how many of this item are in the bag
 *   built       how many of this building stand in the world
 *   stored      how many of this item sit in storage — a chest — which is
 *               where a plate arrives when nobody carried it there
 *   running     how many of this building are working right now, optionally
 *               on one recipe                                          (C31)
 *   researched  1 if this technology is done, else 0                   (C31)
 * ```
 *
 * Generic questions rather than a method per objective, so that the list can
 * change without the controller learning what a tutorial is, and so that no
 * building or item is named in `game/` for it (§19 rule 17).
 *
 * C31 added the last two for the quest chain, which runs past the first plate
 * to every building and technology. Both are answered from state a save
 * already holds — a machine's status and the completed set — so the chain
 * needs no counter in the simulation. "Working" is `running` or `low_power`:
 * a lab on a short network is still doing research, slowly.
 */

export type ObjectiveGoal =
  | { readonly kind: 'carried'; readonly itemId: string }
  | { readonly kind: 'built'; readonly buildingId: string }
  | { readonly kind: 'stored'; readonly itemId: string }
  | { readonly kind: 'running'; readonly buildingId: string; readonly recipeId?: string }
  | { readonly kind: 'researched'; readonly technologyId: string };
