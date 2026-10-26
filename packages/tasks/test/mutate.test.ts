import path from "node:path";

import type { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";

import type { GlobalOptions } from "../src/context.js";
import { openContext } from "../src/context.js";
import { withMutation } from "../src/core/mutate.js";
import { treeLockPath } from "../src/core/lock.js";
import { writeTask } from "../src/core/tree.js";
import type { Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox;

afterEach(async () => {
  await sandbox?.cleanup();
});

function command(options: GlobalOptions): Command {
  return { optsWithGlobals: () => options } as unknown as Command;
}

describe("withMutation", () => {
  it("re-reads the tree inside the lock, and again after the write", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const context = await openContext(command({ dir: sandbox.dir }));

    // Written behind the context's back: the mutation must see it.
    await sandbox.tree({ tasks: { b: {} } });
    expect(context.tree.byId.has("b")).toBe(false);

    const seen = await withMutation(
      context,
      context.projects.local,
      async (fresh) => {
        expect(
          await sandbox.exists(
            path.relative(sandbox.dir, treeLockPath(sandbox.tasksDir)),
          ),
        ).toBe(true);
        const task = fresh.tree.byId.get("a")!;
        await writeTask({
          ...task,
          frontmatter: {
            ...task.frontmatter,
            priority: "high",
            updated: fresh.now,
          },
        });
        return fresh.tree.byId.has("b");
      },
    );

    expect(seen).toBe(true);
    expect(context.tree.byId.get("a")?.frontmatter.priority).toBe("high");
    expect(await sandbox.exists(".tasks/.locks/tree.lock")).toBe(false);
  });

  it("regenerates index.md when it exists and leaves it alone otherwise", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const context = await openContext(command({ dir: sandbox.dir }));

    await withMutation(context, context.projects.local, async () => undefined);
    expect(await sandbox.exists(".tasks/index.md")).toBe(false);

    await sandbox.write(".tasks/index.md", "stale\n");
    await withMutation(context, context.projects.local, async () => undefined);
    expect(await sandbox.read(".tasks/index.md")).not.toContain("stale");

    await sandbox.write(".tasks/index.md", "stale\n");
    await withMutation(context, context.projects.local, async () => undefined, {
      refreshIndex: false,
    });
    expect(await sandbox.read(".tasks/index.md")).toBe("stale\n");
  });

  it("releases the lock when the mutation throws", async () => {
    sandbox = await treeSandbox({ tasks: { a: {} } });
    const context = await openContext(command({ dir: sandbox.dir }));

    await expect(
      withMutation(context, context.projects.local, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await sandbox.exists(".tasks/.locks/tree.lock")).toBe(false);
    expect(
      await withMutation(context, context.projects.local, async () => "free"),
    ).toBe("free");
  });
});

describe("withMutation on a listed tree", () => {
  it("refreshes the local index.md after the foreign write", async () => {
    sandbox = await treeSandbox({
      tasks: { a: { depends_on: ["../backend:x"] } },
      projects: { backend: "../backend" },
    });
    await sandbox.project("backend", "../backend", { tasks: { x: {} } });
    await sandbox.write(".tasks/index.md", "stale\n");
    const context = await openContext(command({ dir: sandbox.dir }));
    const backend = (await context.trees())[1]!;

    await withMutation(context, backend, async () => undefined);

    expect(await sandbox.read(".tasks/index.md")).not.toContain("stale");
    expect(await sandbox.exists(".tasks/.locks/tree.lock")).toBe(false);
  });
});
