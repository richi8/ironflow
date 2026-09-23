/**
 * What the first-run objectives ask the game (C30 task 4).
 *
 * The objectives themselves — their words, their order, what each one is
 * waiting for — are the UI's (`ui/objectives.ts`): they are a way of talking
 * to a new player, and §4 puts that side of the line. What the UI cannot do is
 * count, because counting means reading the world. So a goal is one of three
 * questions the controller can answer from state every player can see, asked
 * in content ids:
 *
 * ```text
 *   carried   how many of this item are in the bag
 *   built     how many of this building stand in the world
 *   stored    how many of this item sit in storage — a chest — which is
 *             where a plate arrives when nobody carried it there
 * ```
 *
 * Three generic questions rather than a method per objective, so that the
 * list can change without the controller learning what a tutorial is, and so
 * that no building or item is named in `game/` for it (§19 rule 17).
 */

export type ObjectiveGoal =
  | { readonly kind: 'carried'; readonly itemId: string }
  | { readonly kind: 'built'; readonly buildingId: string }
  | { readonly kind: 'stored'; readonly itemId: string };
