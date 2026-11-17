import { Command } from "commander";

import type { CommandContext } from "../context.js";
import { openContext } from "../context.js";
import { addressTree, readArchivedTask } from "../core/archive.js";
import { compareIds } from "../core/ids.js";
import { withMutation } from "../core/mutate.js";
import type { LoadedTree } from "../core/projects.js";
import { parseSince } from "../core/time.js";
import { resolveTaskArg } from "../core/tree.js";
import type { LogEntriesJson, LogEntryJson } from "../core/types.js";
import type { LogEntry } from "../core/workspace.js";
import {
  appendLogEntry,
  assertLogText,
  logEntryFor,
  readLog,
  toLogEntryJson,
} from "../core/workspace.js";
import { TaskError } from "../errors.js";
import { emitJson, renderLogEntries, ui, writeOut } from "../output.js";

interface LogOptions {
  since?: string;
  local?: boolean;
  /** Read an archived task's log, or include the archive in `--since`. */
  archived?: boolean;
  json?: boolean;
}

/** The narrative is the caller's words; only what would corrupt the log is refused. */
function entryText(words: string[]): string {
  const text = words.join(" ");
  if (text.trim().length === 0) {
    throw TaskError.usage(
      'A log entry needs text: tasks log <task> "<text>".',
      { text },
    );
  }
  assertLogText(text);
  return text;
}

async function appendNarrative(
  context: CommandContext,
  taskArg: string,
  text: string,
): Promise<void> {
  const { load, path } = await addressTree(context, taskArg);
  // History, not state: the manifest does not change, so neither does
  // `updated`, and nothing index.md renders depends on the log.
  const entry = await withMutation(
    context,
    load,
    async (fresh): Promise<LogEntryJson> => {
      const task = resolveTaskArg(fresh.tree, path);
      await appendLogEntry(
        task.dir,
        logEntryFor(context.identity, fresh.now, [text]),
      );
      // Read back, so the result is the entry as every reader will parse it.
      const entries = await readLog(task.dir);
      return toLogEntryJson(
        entries[entries.length - 1]!,
        context.projects.qualify(fresh.load, task.id),
      );
    },
    { refreshIndex: false },
  );

  if (context.json) {
    emitJson(entry);
    return;
  }
  const via = entry.via === null ? "" : ` via ${entry.via}`;
  const session = entry.session === null ? "" : ` s:${entry.session}`;
  writeOut(
    ui.success(
      `log ${entry.task}: ${entry.time} ${entry.actor}${via}${session}`,
    ),
  );
}

/**
 * `tasks log <task>` without text: one task's entries, oldest first, as the
 * entries object; with `--archived`, a task under `.archive/` by its former
 * path in full. A read, so no lock and no `updated`.
 */
async function readTaskLog(
  context: CommandContext,
  taskArg: string,
  archived: boolean,
): Promise<void> {
  const { load, path } = await addressTree(
    context,
    taskArg,
    archived ? "path" : "task",
  );
  const task = archived
    ? readArchivedTask(context, load, path)
    : resolveTaskArg(load.tree, path);
  const id = context.projects.qualify(load, task.id);
  const entries = (await readLog(task.dir)).map((entry) =>
    toLogEntryJson(entry, id),
  );
  const result: LogEntriesJson = { count: entries.length, entries };

  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderLogEntries(entries, archived ? new Set([id]) : undefined));
}

/** Canonical timestamps order correctly as text. */
function compareText(a: string, b: string): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

interface Collected {
  entry: LogEntry;
  task: string;
  /** Position of the tree among those read: local first. */
  tree: number;
  /** The id inside its tree, for ordering. */
  id: string;
  /** Position in the task's log, so equal times keep the file's order. */
  index: number;
}

interface Since {
  entries: LogEntryJson[];
  /** Qualified ids of the archived tasks among them, for the human marker. */
  archived: Set<string>;
}

/**
 * Entries at or after `since` from every live task of `trees` — and, with
 * `archived`, from every archived task too, under its former id — oldest
 * first. Equal times order by tree (local first, then listed projects in
 * configuration order), then task id, then position in the log.
 */
async function collectEntries(
  context: CommandContext,
  trees: LoadedTree[],
  since: string,
  archived: boolean,
): Promise<Since> {
  const found: Collected[] = [];
  const fromArchive = new Set<string>();
  for (const [rank, load] of trees.entries()) {
    // A manifest that does not parse still has a history worth listing.
    const dirs = [
      ...load.tree.tasks.map((task) => ({ id: task.id, dir: task.dir })),
      ...load.tree.malformed
        .filter((entry) => entry.id !== "")
        .map((entry) => ({ id: entry.id, dir: entry.dir })),
    ];
    if (archived) {
      for (const entry of [
        ...load.tree.archived,
        ...load.tree.archivedMalformed,
      ]) {
        if (entry.id === "") continue;
        dirs.push({ id: entry.id, dir: entry.dir });
        fromArchive.add(context.projects.qualify(load, entry.id));
      }
    }
    for (const { id, dir } of dirs) {
      const task = context.projects.qualify(load, id);
      (await readLog(dir)).forEach((entry, index) => {
        if (entry.time >= since) {
          found.push({ entry, task, tree: rank, id, index });
        }
      });
    }
  }
  found.sort(
    (a, b) =>
      compareText(a.entry.time, b.entry.time) ||
      a.tree - b.tree ||
      compareIds(a.id, b.id) ||
      a.index - b.index,
  );
  return {
    entries: found.map(({ entry, task }) => toLogEntryJson(entry, task)),
    archived: fromArchive,
  };
}

async function listSince(
  context: CommandContext,
  arg: string,
  options: LogOptions,
): Promise<void> {
  const since = parseSince(arg);
  const trees =
    options.local === true ? [context.projects.local] : await context.trees();
  const { entries, archived } = await collectEntries(
    context,
    trees,
    since,
    options.archived === true,
  );
  const result: LogEntriesJson = { count: entries.length, entries };

  if (context.json) {
    emitJson(result);
    return;
  }
  writeOut(renderLogEntries(entries, archived));
}

export function logCommand(): Command {
  return new Command("log")
    .summary(
      "append a narrative log entry to a task, read a task's log, or list entries since a time (--since)",
    )
    .description(
      'append a narrative entry to a task\'s log.md (tasks log <task> "<text>"),\n' +
        "print a task's entries (tasks log <task>), or list the entries since a\n" +
        "time across the local tree and every listed project, oldest first\n" +
        "(tasks log --since 7d)",
    )
    .argument(
      "[task]",
      "the task whose log.md receives the entry, or whose log is read when no text follows",
    )
    .argument("[text...]", "the entry's text")
    .option(
      "--since <when>",
      "list entries since a timestamp, a date, or a duration back from now (30m, 12h, 7d, 2w)",
    )
    .option("--local", "with --since: the local tree only")
    .option(
      "--archived",
      "read the log of a task under .archive/ (by its former path in full), or include the archive in --since",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(
      async (
        task: string | undefined,
        words: string[],
        options: LogOptions,
        command: Command,
      ) => {
        if (options.since !== undefined) {
          if (task !== undefined) {
            throw TaskError.usage(
              "Give a task and text to append an entry, or --since to list entries; not both.",
              { task, since: options.since },
            );
          }
          await listSince(await openContext(command), options.since, options);
          return;
        }
        if (task === undefined) {
          throw TaskError.usage(
            'Name a task and the text to append (tasks log <task> "<text>"), or list entries with --since.',
          );
        }
        if (options.local === true) {
          throw TaskError.usage("--local applies to log --since only.", {
            task,
          });
        }
        if (words.length === 0) {
          await readTaskLog(
            await openContext(command),
            task,
            options.archived === true,
          );
          return;
        }
        if (options.archived === true) {
          throw TaskError.usage(
            "--archived reads a log; an archived task's log is not appended to. Restore the task first.",
            { task },
          );
        }
        const text = entryText(words);
        await appendNarrative(await openContext(command), task, text);
      },
    );
}
