import fs from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findProject, requireProject } from "../src/core/discovery.js";
import { isTaskError } from "../src/errors.js";
import type { Sandbox } from "./helpers.js";
import { makeSandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await makeSandbox();
});

afterEach(async () => {
  await sandbox.cleanup();
});

describe("discovery", () => {
  it("finds the tree in the start directory", async () => {
    await sandbox.initV2();
    expect(await findProject(sandbox.dir)).toEqual({
      root: sandbox.dir,
      tasksDir: sandbox.tasksDir,
    });
  });

  it("walks up from a subdirectory", async () => {
    await sandbox.initV2();
    const deep = path.join(sandbox.dir, "src", "deep");
    await fs.mkdir(deep, { recursive: true });
    expect((await findProject(deep))?.root).toBe(sandbox.dir);
  });

  it("stops at the nearest tree without merging trees above it", async () => {
    await sandbox.initV2();
    await sandbox.write("packages/web/.tasks/config.yml", "version: 2\n");
    const nested = path.join(sandbox.dir, "packages", "web", "src");
    await fs.mkdir(nested, { recursive: true });
    expect((await findProject(nested))?.root).toBe(
      path.join(sandbox.dir, "packages", "web"),
    );
  });

  it("starts from any directory the caller names, like -C", async () => {
    await sandbox.project("main", "../main");
    const elsewhere = path.join(sandbox.root, "worktree");
    await fs.mkdir(elsewhere);
    expect((await findProject(path.join(sandbox.root, "main")))?.root).toBe(
      path.join(sandbox.root, "main"),
    );
    expect(await findProject(elsewhere)).toBeNull();
  });

  describe("in a linked git worktree", () => {
    /** Lay out `main` as a checkout with `.git/` and `wt` as its worktree. */
    async function link(main: string, wt: string, name = "wt"): Promise<void> {
      const gitdir = path.join(main, ".git", "worktrees", name);
      await fs.mkdir(gitdir, { recursive: true });
      await fs.writeFile(path.join(gitdir, "commondir"), "../..\n");
      await fs.mkdir(wt, { recursive: true });
      await fs.writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
    }

    it("finds the main checkout's tree at the same place, not the worktree's copy", async () => {
      await sandbox.initV2();
      const wt = path.join(sandbox.root, "wt");
      await link(sandbox.dir, wt);
      await fs.mkdir(path.join(wt, ".tasks"), { recursive: true });
      await fs.writeFile(path.join(wt, ".tasks", "config.yml"), "version: 2\n");
      await fs.mkdir(path.join(wt, "src", "deep"), { recursive: true });
      await fs.mkdir(path.join(sandbox.dir, "src"), { recursive: true });

      for (const start of [
        wt,
        path.join(wt, "src"),
        path.join(wt, "src", "deep"),
      ]) {
        expect((await findProject(start, { worktree: true }))?.root).toBe(
          sandbox.dir,
        );
      }
      // A directory the caller named is taken literally.
      expect((await findProject(wt))?.root).toBe(wt);
      expect((await findProject(wt, { worktree: false }))?.root).toBe(wt);
    });

    it("keeps a nested package its own tree across the mirror", async () => {
      await sandbox.initV2();
      await sandbox.write("packages/web/.tasks/config.yml", "version: 2\n");
      const wt = path.join(sandbox.root, "wt");
      await link(sandbox.dir, wt);
      const nested = path.join(wt, "packages", "web", "src");
      await fs.mkdir(nested, { recursive: true });
      expect((await findProject(nested, { worktree: true }))?.root).toBe(
        path.join(sandbox.dir, "packages", "web"),
      );
    });

    it("falls back to the worktree's own tree when the main checkout has none", async () => {
      const wt = path.join(sandbox.root, "wt");
      await link(sandbox.dir, wt);
      await fs.mkdir(path.join(wt, ".tasks"), { recursive: true });
      await fs.writeFile(path.join(wt, ".tasks", "config.yml"), "version: 2\n");
      expect((await findProject(wt, { worktree: true }))?.root).toBe(wt);
    });

    it("leaves a submodule and a bare repository alone", async () => {
      // A submodule's .git file points into modules/ and has no commondir.
      const sub = path.join(sandbox.root, "sub");
      await fs.mkdir(path.join(sub, ".tasks"), { recursive: true });
      await fs.writeFile(
        path.join(sub, ".tasks", "config.yml"),
        "version: 2\n",
      );
      await fs.writeFile(
        path.join(sub, ".git"),
        "gitdir: ../.git/modules/sub\n",
      );
      expect((await findProject(sub, { worktree: true }))?.root).toBe(sub);

      // A worktree of a bare repository: the common dir is not a `.git`.
      const bare = path.join(sandbox.root, "repo.git");
      const gitdir = path.join(bare, "worktrees", "wt");
      await fs.mkdir(gitdir, { recursive: true });
      await fs.writeFile(path.join(gitdir, "commondir"), "../..\n");
      const wt = path.join(sandbox.root, "bare-wt");
      await fs.mkdir(path.join(wt, ".tasks"), { recursive: true });
      await fs.writeFile(path.join(wt, ".tasks", "config.yml"), "version: 2\n");
      await fs.writeFile(path.join(wt, ".git"), `gitdir: ${gitdir}\n`);
      expect((await findProject(wt, { worktree: true }))?.root).toBe(wt);
    });

    it("sends every command run in the worktree to the main checkout; -C is literal", async () => {
      await sandbox.tree({ tasks: { live: {} } });
      const wt = path.join(sandbox.root, "wt");
      await link(sandbox.dir, wt);
      await fs.mkdir(path.join(wt, ".tasks", "stale"), { recursive: true });
      await fs.writeFile(path.join(wt, ".tasks", "config.yml"), "version: 2\n");
      await fs.writeFile(
        path.join(wt, ".tasks", "stale", "task.md"),
        await sandbox.read(".tasks/live/task.md"),
      );

      const ids = (out: string): string[] =>
        (JSON.parse(out) as { tasks: Array<{ id: string }> }).tasks.map(
          (task) => task.id,
        );
      const fromWorktree = await sandbox.runWith(
        { cwd: "../wt" },
        "list",
        "--json",
      );
      expect(fromWorktree.code).toBe(0);
      expect(ids(fromWorktree.stdout)).toEqual(["live"]);

      const literal = await sandbox.runWith(
        { cwd: "../wt" },
        "list",
        "-C",
        ".",
        "--json",
      );
      expect(ids(literal.stdout)).toEqual(["stale"]);
    });
  });

  it("finds nothing from a directory that does not exist", async () => {
    await sandbox.initV2();
    expect(
      await findProject(path.join(sandbox.dir, "not-checked-out")),
    ).toBeNull();
  });

  it("ignores a .tasks that is a file", async () => {
    await sandbox.write(".tasks", "not a directory");
    expect(await findProject(sandbox.dir)).toBeNull();
  });

  it("fails as not-found, pointing at tasks init", async () => {
    try {
      await requireProject(sandbox.dir);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(isTaskError(err)).toBe(true);
      if (isTaskError(err)) {
        expect(err.exitCode).toBe(3);
        expect(err.message).toContain("tasks init");
        expect(err.details).toEqual({ cwd: sandbox.dir });
      }
    }
  });

  it("names a start directory that does not exist", async () => {
    const missing = path.join(sandbox.dir, "missing");
    await expect(requireProject(missing)).rejects.toMatchObject({
      exitCode: 3,
      message: expect.stringContaining("is not a directory"),
    });
  });
});
