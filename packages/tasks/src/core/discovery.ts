import fs from "node:fs/promises";
import path from "node:path";

import { TaskError } from "../errors.js";
import { errnoCode, isDirectory } from "./fs-utils.js";
import { TASKS_DIRNAME } from "./types.js";

export interface Project {
  /** Directory containing `.tasks/`: the anchor for relative references. */
  root: string;
  /** Absolute path of the `.tasks/` directory itself. */
  tasksDir: string;
}

export interface DiscoveryOptions {
  /**
   * Run from inside a linked git worktree, start at the same place in the
   * main checkout, so the live tree is found and not the snapshot committed
   * on the worktree's branch. The default for the current directory; never
   * for a directory the caller named (`-C`, a listed project's path), which
   * is taken literally.
   */
  worktree?: boolean;
}

/** The nearest `.tasks/` at or above `dir`, with no merging further up. */
async function walkUp(startDir: string): Promise<Project | null> {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, TASKS_DIRNAME);
    if (await isDirectory(candidate)) {
      return { root: dir, tasksDir: candidate };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface LinkedWorktree {
  /** The worktree's own root: where its `.git` file is. */
  root: string;
  /** The main checkout's root: the parent of the repository's `.git`. */
  mainRoot: string;
}

function isMissing(err: unknown): boolean {
  const code = errnoCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The linked git worktree `startDir` lies in, if any. Git marks one with a
 * `.git` *file* at its root, `gitdir: <main>/.git/worktrees/<name>`, and
 * writes `commondir` into that directory, naming the repository's own
 * `.git`. A `.git` directory is a main checkout; a submodule's `.git` file
 * points into `modules/` and carries no `commondir`; a bare repository has
 * no checkout to mirror. Each of those is `null`.
 */
async function linkedWorktree(
  startDir: string,
): Promise<LinkedWorktree | null> {
  let dir = startDir;
  for (;;) {
    const dotGit = path.join(dir, ".git");
    let kind: "dir" | "file" | null = null;
    try {
      const stat = await fs.stat(dotGit);
      kind = stat.isDirectory() ? "dir" : stat.isFile() ? "file" : null;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    if (kind === "dir") return null;
    if (kind === "file") {
      const pointer = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(
        await fs.readFile(dotGit, "utf8"),
      );
      if (pointer === null) return null;
      const gitdir = path.resolve(dir, pointer[1]!);
      let common: string;
      try {
        common = (
          await fs.readFile(path.join(gitdir, "commondir"), "utf8")
        ).trim();
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
      const mainGitDir = path.resolve(gitdir, common);
      if (path.basename(mainGitDir) !== ".git") return null;
      return { root: dir, mainRoot: path.dirname(mainGitDir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isAtOrBelow(dir: string, ancestor: string): boolean {
  const relative = path.relative(ancestor, dir);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Walk up from `startDir` looking for `.tasks/`, git-style. Nearest wins: the
 * first match is the tree, with no merging into or fallthrough to a tree
 * further up, which is what makes a nested package its own scope.
 *
 * With `worktree`, a start directory inside a linked git worktree is first
 * mirrored into the main checkout — the same relative place, or the main
 * root when that place does not exist there — and a tree found within the
 * main checkout wins: code lives in worktrees, the tasks about it do not,
 * and the worktree's own `.tasks/` is the snapshot its branch committed. The
 * worktree's own tree is taken only when the main checkout has none.
 *
 * A start directory that does not exist finds nothing rather than walking up
 * from where it would be: a reference to a sibling repository that is not
 * checked out must not resolve to some unrelated tree above it.
 */
export async function findProject(
  startDir: string,
  options: DiscoveryOptions = {},
): Promise<Project | null> {
  const dir = path.resolve(startDir);
  if (!(await isDirectory(dir))) return null;

  if (options.worktree === true) {
    const linked = await linkedWorktree(dir);
    if (linked !== null) {
      // The same place in the main checkout, or the nearest one that exists
      // there: a directory new on the worktree's branch still belongs to the
      // package above it.
      let mirrored = path.join(
        linked.mainRoot,
        path.relative(linked.root, dir),
      );
      while (mirrored !== linked.mainRoot && !(await isDirectory(mirrored))) {
        mirrored = path.dirname(mirrored);
      }
      const found = await walkUp(mirrored);
      if (found !== null && isAtOrBelow(found.root, linked.mainRoot)) {
        return found;
      }
    }
  }
  return walkUp(dir);
}

/** `startDir` is where discovery begins: the cwd, or the CLI's `-C <dir>`. */
export async function requireProject(
  startDir: string,
  options: DiscoveryOptions = {},
): Promise<Project> {
  const project = await findProject(startDir, options);
  if (!project) {
    const cwd = path.resolve(startDir);
    const where = (await isDirectory(cwd))
      ? `in "${cwd}" or any parent`
      : `because "${cwd}" is not a directory`;
    throw TaskError.notFound(
      `No ${TASKS_DIRNAME}/ directory found ${where}; \`tasks init\` creates one.`,
      { cwd },
    );
  }
  return project;
}
