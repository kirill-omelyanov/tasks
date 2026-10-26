import { Command, CommanderError } from "commander";

import { skillCommand } from "./commands/skill.js";
import { ExitCode, TaskError, isTaskError } from "./errors.js";
import { ui, writeErr } from "./output.js";

// Replaced at build time (tsup/vitest `define`) with the package.json version,
// so `tasks -v` and the published version can never disagree.
declare const __PKG_VERSION__: string;

export const VERSION = __PKG_VERSION__;

export function buildCli(): Command {
  const program = new Command();

  program
    .name("tasks")
    .description(
      "Local, git-versioned task manager for AI coding agents.\n\n" +
        "Task state lives in .tasks/ as one directory per task with a markdown\n" +
        "manifest. Every command that produces output supports --json; errors\n" +
        "are JSON on stderr under --json, and exit codes are meaningful\n" +
        "(0 ok, 2 usage, 3 not found, 4 conflict).",
    )
    .version(VERSION, "-v, --version")
    .showHelpAfterError("(run `tasks --help` for usage)")
    // Accepted before or after the command name, so a harness can append
    // them to any invocation.
    .option(
      "-C, --dir <dir>",
      "start the search for .tasks/ in this directory instead of the current one",
    )
    .option(
      "--as <actor>",
      "act as this actor; the identity that would have acted is logged as the operator",
    )
    .option(
      "--session <token>",
      "the session token, else TASKS_SESSION; recorded on claims and in log headings",
    );

  // Commands are registered here, one block per module, as they land.
  program.addCommand(skillCommand());

  return program;
}

/** True when the invocation asked for JSON, so errors match that shape too. */
function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

export function reportError(error: unknown, argv: string[]): number {
  const taskError = isTaskError(error)
    ? error
    : TaskError.internal(
        error instanceof Error ? error.message : String(error),
      );

  if (wantsJson(argv)) {
    // Structured errors go to stderr so stdout stays clean for parseable output.
    writeErr(JSON.stringify(taskError.toJSON(), null, 2));
  } else {
    writeErr(ui.error(taskError.message));
  }

  if (
    !isTaskError(error) &&
    error instanceof Error &&
    process.env.TASKS_DEBUG
  ) {
    writeErr(ui.dim(error.stack ?? ""));
  }

  return taskError.exitCode;
}

export async function run(argv: string[]): Promise<number> {
  const program = buildCli();
  program.exitOverride();
  program.configureOutput({
    writeOut: (str) => process.stdout.write(str),
    writeErr: (str) => process.stderr.write(str),
  });

  try {
    await program.parseAsync(argv, { from: "user" });
    return process.exitCode ? Number(process.exitCode) : ExitCode.Success;
  } catch (error) {
    if (error instanceof CommanderError) {
      // --help and --version are successful exits that commander models as throws.
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.help"
      ) {
        return ExitCode.Success;
      }
      if (error.code === "commander.version") return ExitCode.Success;
      if (wantsJson(argv)) {
        // Usage errors from the parser go to stderr like every other error.
        writeErr(
          JSON.stringify(
            { error: { code: "USAGE", message: error.message.trim() } },
            null,
            2,
          ),
        );
      }
      return ExitCode.Usage;
    }
    return reportError(error, argv);
  }
}
