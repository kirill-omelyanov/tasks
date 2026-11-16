import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { appendNote, noteItem } from "../src/core/notes.js";
import type { TaskWithDerivedJson } from "../src/core/types.js";
import { readLog } from "../src/core/workspace.js";
import type { TreeSpec } from "./fixtures.js";
import type { CliResult, Sandbox } from "./helpers.js";
import { treeSandbox } from "./helpers.js";

let sandbox: Sandbox | undefined;

afterEach(async () => {
  await sandbox?.cleanup();
  sandbox = undefined;
});

interface ErrorJson {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function errorOf(result: CliResult): ErrorJson["error"] {
  return result.json<ErrorJson>().error;
}

async function box(spec: TreeSpec): Promise<Sandbox> {
  sandbox = await treeSandbox(spec);
  return sandbox;
}

/** The body of a manifest as written: after the frontmatter block. */
function bodyOf(file: string): string {
  return file.split("\n---\n\n")[1] ?? "";
}

const today = (): string => new Date().toISOString().slice(0, 10);

const BODY =
  "# A task\n\n## Description\n\nWhat.\n\n## Acceptance criteria\n\n- [ ] done\n\n## Notes\n";

describe("appendNote", () => {
  it("fills an empty Notes section", () => {
    expect(appendNote("# T\n\n## Description\n\nx\n\n## Notes\n", "- n")).toBe(
      "# T\n\n## Description\n\nx\n\n## Notes\n\n- n",
    );
  });

  it("continues a list, separates prose, and keeps the next section apart", () => {
    expect(appendNote("## Notes\n\n- one\n\n## After\n\ntext", "- two")).toBe(
      "## Notes\n\n- one\n- two\n\n## After\n\ntext",
    );
    expect(appendNote("## Notes\n\nSome prose.\n", "- two")).toBe(
      "## Notes\n\nSome prose.\n\n- two",
    );
  });

  it("creates the heading at the end when it is missing", () => {
    expect(appendNote("# T\n\n## Description\n\nx\n", "- n")).toBe(
      "# T\n\n## Description\n\nx\n\n## Notes\n\n- n",
    );
    expect(appendNote("", "- n")).toBe("## Notes\n\n- n");
  });

  it("finds the heading regardless of case and trailing spaces", () => {
    expect(appendNote("## notes  \n", "- x")).toBe("## notes  \n\n- x");
  });
});

describe("noteItem", () => {
  it("dates and attributes the note, naming the operator", () => {
    expect(noteItem("2026-11-15", "maria", null, "Option (b).")).toBe(
      "- 2026-11-15, maria: Option (b).",
    );
    expect(
      noteItem("2026-11-15", "maria", "agent", "Option (b).\n\nShip it.\n"),
    ).toBe("- 2026-11-15, maria via agent: Option (b).\n\n  Ship it.");
  });
});

describe("note <task> <text>", () => {
  it("appends under ## Notes, stamps updated and logs the note", async () => {
    const s = await box({ tasks: { "x/a": { body: BODY } } });
    const before = await s.read(".tasks/x/a/task.md");

    const result = await s.run("note", "a", "Option (b), digest only.");
    expect(result.code).toBe(0);
    const out = stripVTControlCharacters(result.stdout);
    expect(out).toContain("✓ note x/a: Option (b), digest only.");
    expect(out).toContain("appended under ## Notes of task.md, and logged");

    const after = await s.read(".tasks/x/a/task.md");
    expect(bodyOf(after)).toBe(
      `${BODY}\n- ${today()}, tester: Option (b), digest only.\n`,
    );
    expect(after).not.toContain(before.match(/^updated: .*$/m)![0]);

    const entries = await readLog(path.join(s.tasksDir, "x", "a"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      actor: "tester",
      via: null,
      text: "note\nOption (b), digest only.",
    });
  });

  it("continues an existing list and leaves the sections after it alone", async () => {
    const s = await box({
      tasks: {
        a: {
          body: "# A\n\n## Notes\n\n- 2026-01-01, bob: earlier\n\n## Extra\n\ntext\n",
        },
      },
    });
    expect((await s.run("note", "a", "later")).code).toBe(0);
    expect(bodyOf(await s.read(".tasks/a/task.md"))).toBe(
      `# A\n\n## Notes\n\n- 2026-01-01, bob: earlier\n- ${today()}, tester: later\n\n## Extra\n\ntext\n`,
    );
  });

  it("creates the heading when the body lacks it", async () => {
    const s = await box({ tasks: { a: { body: "# A\n\nJust text.\n" } } });
    expect((await s.run("note", "a", "first")).code).toBe(0);
    expect(bodyOf(await s.read(".tasks/a/task.md"))).toBe(
      `# A\n\nJust text.\n\n## Notes\n\n- ${today()}, tester: first\n`,
    );
  });

  it("names the operator and keeps continuation lines in the item", async () => {
    const s = await box({ tasks: { a: { body: BODY } } });
    const result = await s.run(
      "note",
      "a",
      "Line one.\nLine two.",
      "--as",
      "maria",
    );
    expect(result.code).toBe(0);
    expect(bodyOf(await s.read(".tasks/a/task.md"))).toBe(
      `${BODY}\n- ${today()}, maria via tester: Line one.\n  Line two.\n`,
    );
    const [entry] = await readLog(path.join(s.tasksDir, "a"));
    expect(entry).toMatchObject({
      actor: "maria",
      via: "tester",
      text: "note\nLine one.\nLine two.",
    });
  });

  it("needs no authorization: a note lands on another session's live claim", async () => {
    const s = await box({ tasks: { a: { body: BODY } } });
    expect((await s.session("s1")("claim", "a")).code).toBe(0);
    const result = await s.session("s2")("note", "a", "Heads up", "--json");
    expect(result.code).toBe(0);
    const json = result.json<TaskWithDerivedJson>();
    expect(json).toMatchObject({
      id: "a",
      status: "IN_PROGRESS",
      claimed_session: "s1",
      last_entry: { session: "s2", text: "note\nHeads up" },
    });
  });

  it("writes into a listed project by alias", async () => {
    const s = await box({ tasks: { a: {} } });
    const backend = await s.project("backend", "../backend", {
      tasks: { k: { body: BODY } },
    });
    const result = await s.run("note", "backend:k", "From here", "--json");
    expect(result.code).toBe(0);
    expect(result.json<TaskWithDerivedJson>().id).toBe("backend:k");
    const file = await s.read(
      path.relative(s.dir, path.join(backend, ".tasks", "k", "task.md")),
    );
    expect(bodyOf(file)).toBe(`${BODY}\n- ${today()}, tester: From here\n`);
  });

  it("refuses an empty note, a heading line and a conflict marker", async () => {
    const s = await box({ tasks: { a: { body: BODY } } });
    const before = await s.read(".tasks/a/task.md");
    for (const [text, line] of [
      ["  ", null],
      ["# Decision", 1],
      ["fine\n## Notes", 2],
      ["<<<<<<< HEAD", 1],
    ] as const) {
      const result = await s.run("note", "a", text, "--json");
      expect(result.code, JSON.stringify(text)).toBe(2);
      if (line !== null) {
        expect(errorOf(result).details).toMatchObject({ line });
      }
    }
    expect(await s.read(".tasks/a/task.md")).toBe(before);
    expect(await s.exists(".tasks/a/log.md")).toBe(false);
  });
});
