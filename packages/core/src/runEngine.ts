/**
 * The shape every check/scenario type in this repo (Check, ModernCheck,
 * ChaosScenario) already had independently before this existed: something
 * with an id, a title, an optional spec reference, and a `run(ctx)` method.
 */
export interface Runnable<Ctx, Result> {
  id: string;
  title: string;
  specRef?: string;
  run(ctx: Ctx): Promise<Result>;
}

/**
 * Runs every item against the same context, in order, catching individual
 * failures so one broken item can't take down the whole run.
 *
 * This is the exact loop `@crucible/conformance`'s legacy and modern
 * engines and `@crucible/chaos`'s engine all had, independently, byte-for-byte
 * identical except for how each turns a caught error into its own Result
 * shape. Three copies of the same loop was the signal that a shared
 * generic was overdue - two was still plausibly a coincidence (see
 * docs/architecture.md's "Two protocol eras" section for why the modern
 * and legacy check families were kept apart even so), but three identical
 * copies stopped being that. `onThrow` is where each caller supplies its
 * own Result shape for the "this item threw" case; everything else about
 * the loop is now here once.
 */
export async function runEngine<Ctx, Result>(
  ctx: Ctx,
  items: Runnable<Ctx, Result>[],
  onThrow: (item: Runnable<Ctx, Result>, err: unknown) => Result,
): Promise<Result[]> {
  const results: Result[] = [];

  for (const item of items) {
    try {
      results.push(await item.run(ctx));
    } catch (err) {
      results.push(onThrow(item, err));
    }
  }

  return results;
}
