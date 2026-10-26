import { Command } from "commander";

import { openContext } from "../context.js";
import {
  addressTree,
  archiveTask,
  deleteTask,
  derivedTaskJson,
  displayPath,
  purgeArchive,
  restoreTask,
} from "../core/archive.js";
import { emitJson, renderTransitionResult, ui, writeOut } from "../output.js";

interface ForceOptions {
  force?: boolean;
  json?: boolean;
}

interface JsonOptions {
  json?: boolean;
}

export function archiveCommand(): Command {
  return new Command("archive")
    .description(
      "move a resolved task and its subtree to .tasks/.archive/, where it\n" +
        "satisfies no gate and keeps its path reserved; refused while a\n" +
        "descendant is open or live tasks reference the subtree",
    )
    .argument("<task>", "the task to archive")
    .option(
      "--force",
      "archive although live tasks reference it; they are reported as left blocked",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, options: ForceOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: rest } = await addressTree(context, arg);
      const result = await archiveTask(context, load, rest, {
        force: options.force,
      });

      if (context.json) {
        emitJson(result);
        return;
      }
      const lines = [
        ui.success(`archive ${result.id} → ${displayPath(result.path)}`),
      ];
      if (result.tasks.length > 1) {
        lines.push(`  with ${result.tasks.slice(1).join(", ")}`);
      }
      if (result.left_blocked.length > 0) {
        lines.push(
          `  ${ui.warn(`left blocked: ${result.left_blocked.join(", ")}`)}`,
        );
      }
      writeOut(lines.join("\n"));
    });
}

export function restoreCommand(): Command {
  return new Command("restore")
    .description(
      "move an archived task and its archived subtree back to the live tree;\n" +
        "never under a resolved parent, never onto a live task",
    )
    .argument(
      "<path>",
      "the task's full path under .archive/ (no suffixes); alias:path for a listed project",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, _options: JsonOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: archivePath } = await addressTree(
        context,
        arg,
        "path",
      );
      const result = await restoreTask(context, load, archivePath);
      const json = await derivedTaskJson(context, load, result.id);

      if (context.json) {
        emitJson(json);
        return;
      }
      const lines = [
        renderTransitionResult(json, { command: "restore" }),
        `  ${ui.dim(`${json.status} · ${displayPath(json.path)}`)}`,
      ];
      if (result.tasks.length > 1) {
        lines.push(`  with ${result.tasks.slice(1).join(", ")}`);
      }
      writeOut(lines.join("\n"));
    });
}

export function purgeCommand(): Command {
  return new Command("purge")
    .description(
      "delete an archive entry for good and release the path it reserves;\n" +
        "names the live tasks whose references would reach a task recreated there",
    )
    .argument(
      "<path>",
      "the entry's full path under .archive/ (no suffixes); alias:path for a listed project",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, _options: JsonOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: archivePath } = await addressTree(
        context,
        arg,
        "path",
      );
      const result = await purgeArchive(context, load, archivePath);

      if (context.json) {
        emitJson(result);
        return;
      }
      const removed =
        result.removed.length === 0
          ? "no archived task"
          : result.removed.join(", ");
      const lines = [ui.success(`purge ${result.id}: removed ${removed}`)];
      if (result.referenced_by.length > 0) {
        lines.push(
          `  ${ui.warn(`still referenced by ${result.referenced_by.join(", ")}; a task created at the path satisfies them`)}`,
        );
      }
      writeOut(lines.join("\n"));
    });
}

export function deleteCommand(): Command {
  return new Command("delete")
    .description(
      "remove a never-worked task without archiving it: only its creation in\n" +
        "the log, no state.md, nothing beneath it, no live task referencing it",
    )
    .argument("<task>", "the task to delete")
    .option(
      "--force",
      "override authorization only (a claim, an assignee); the conditions stand",
    )
    .option("--json", "emit machine-readable JSON")
    .exitOverride()
    .action(async (arg: string, options: ForceOptions, command: Command) => {
      const context = await openContext(command);
      const { load, path: rest } = await addressTree(context, arg);
      const result = await deleteTask(context, load, rest, {
        force: options.force,
      });

      if (context.json) {
        emitJson(result);
        return;
      }
      writeOut(ui.success(`delete ${result.id}`));
    });
}
