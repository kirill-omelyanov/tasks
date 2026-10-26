import type { CommandContext } from "../context.js";
import type { DerivedTask, TreeSnapshot } from "./derive.js";
import { deriveTree } from "./derive.js";
import type { GateResolver } from "./gates.js";
import { refreshIndex } from "./index-md.js";
import type { LoadedTree, Projects } from "./projects.js";
import { livenessForTree } from "./sessions.js";
import { lastLogEntry } from "./workspace.js";

/** What a command needs to see one tree: the snapshot and its derivation. */
export interface TreeDerivation {
  load: LoadedTree;
  snapshot: TreeSnapshot;
  derived: Map<string, DerivedTask>;
}

export interface SnapshotSource {
  projects: Projects;
  gates: GateResolver;
}

/**
 * Resolve gates and liveness for every live task of one tree and derive the
 * conditions for `actor` (`null` for an actor-independent view such as
 * `index.md`). This is the one place the reading modules are composed.
 */
export async function snapshotTree(
  source: SnapshotSource,
  load: LoadedTree,
  actor: string | null,
  now: Date = new Date(),
): Promise<TreeDerivation> {
  const gates = await source.gates.gatesForTree(load);
  const liveness = await livenessForTree(load.tree, now);

  const tasks = await Promise.all(
    load.tree.tasks.map(async (task) => {
      const resolved = gates.get(task.id);
      return {
        task,
        project: load.alias,
        start: resolved?.start ?? { satisfied: false, refs: [] },
        finish: resolved?.finish ?? {
          satisfied: false,
          open_children: [],
          refs: [],
        },
        liveness: liveness.get(task.id) ?? null,
        lastEntry: task.workspace.log ? await lastLogEntry(task.dir) : null,
      };
    }),
  );

  const snapshot: TreeSnapshot = {
    tree: load.tree,
    project: load.alias,
    tasks,
  };
  return { load, snapshot, derived: deriveTree(snapshot, actor) };
}

/** The local tree, then every listed tree that is available. */
export async function snapshotAll(
  source: SnapshotSource,
  actor: string | null,
  options: { local?: boolean } = {},
): Promise<TreeDerivation[]> {
  const loads = options.local
    ? [source.projects.local]
    : await source.projects.writableTrees();
  const result: TreeDerivation[] = [];
  for (const load of loads) {
    result.push(await snapshotTree(source, load, actor));
  }
  return result;
}

/** Regenerate a tree's `index.md` when it exists, from a fresh derivation. */
export async function refreshIndexFor(
  source: SnapshotSource,
  load: LoadedTree,
): Promise<boolean> {
  const { derived } = await snapshotTree(source, load, null);
  return refreshIndex(load.tree, derived);
}

export function snapshotFromContext(context: CommandContext): SnapshotSource {
  return { projects: context.projects, gates: context.gates };
}
