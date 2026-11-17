import path from "node:path";

import { pathExists } from "./fs-utils.js";
import type { Tree } from "./tree.js";
import type { DocsLocationJson } from "./types.js";

/**
 * The documentation locations `config.yml` lists, in configured order, each
 * checked for presence from the project root: a location beside the
 * repository may not be checked out on this machine, one inside it may have
 * moved since it was listed.
 */
export async function docsLocations(tree: Tree): Promise<DocsLocationJson[]> {
  return Promise.all(
    Object.entries(tree.config.docs).map(async ([name, relPath]) => ({
      name,
      path: relPath,
      present: await pathExists(docsDir(tree, relPath)),
    })),
  );
}

/** Where a configured documentation path leads on this machine. */
export function docsDir(tree: Tree, relPath: string): string {
  return path.resolve(tree.project.root, relPath);
}
