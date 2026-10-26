import type { CommandContext } from "../context.js";
import { withTreeLock } from "./lock.js";
import type { LoadedTree } from "./projects.js";
import { refreshIndexFor, snapshotFromContext } from "./snapshot.js";
import { nowIso } from "./time.js";
import type { Tree } from "./tree.js";

/** What a mutation sees inside the lock: the tree as it is right now. */
export interface Fresh {
  load: LoadedTree;
  tree: Tree;
  /** One timestamp for everything the mutation stamps and logs. */
  now: string;
}

export interface MutationOptions {
  /** Regenerate `index.md` afterwards when it exists; on by default. */
  refreshIndex?: boolean;
}

/**
 * Run a write against one tree. The tree's lock is taken, the tree is
 * re-read inside it before `fn` decides anything (whatever the command read
 * earlier may be stale), and after the write the tree is re-read again so
 * every later lookup sees the result and `index.md` follows it. A command
 * that writes several trees calls this once per tree: there are no
 * cross-tree transactions.
 */
export async function withMutation<T>(
  context: CommandContext,
  load: LoadedTree,
  fn: (fresh: Fresh) => Promise<T>,
  options: MutationOptions = {},
): Promise<T> {
  return withTreeLock(load.project.tasksDir, async () => {
    const before = await context.projects.reload(load);
    context.gates.invalidate();

    const result = await fn({ load: before, tree: before.tree, now: nowIso() });

    const after = await context.projects.reload(before);
    context.gates.invalidate();
    if (options.refreshIndex !== false) {
      await refreshIndexFor(snapshotFromContext(context), after);
    }
    return result;
  });
}
