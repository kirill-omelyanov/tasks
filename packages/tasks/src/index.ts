import { reportError, run } from "./cli.js";
import { errnoCode } from "./core/fs-utils.js";

const argv = process.argv.slice(2);

/**
 * A reader that stops early (`tasks list --json | head`) closes the pipe, and
 * the next write fails with EPIPE: not a failure of the command, so the exit
 * is quiet, with the code the command had reached. Any other failure of an
 * output stream is reported like an internal error.
 */
function exitOnStreamError(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: Error) => {
    if (errnoCode(error) === "EPIPE") {
      process.exit(Number(process.exitCode ?? 0));
    }
    process.exit(reportError(error, argv));
  });
}

exitOnStreamError(process.stdout);
exitOnStreamError(process.stderr);

// No `process.exit` after the run. A pipe takes stdout's writes
// asynchronously, and exiting at once dropped whatever had not left the
// process yet: a --json answer longer than the pipe's buffer (64 KiB on
// macOS) ended there, with exit code 0. The code is set for the exit the
// process reaches on its own, once every stream has been flushed.
process.exitCode = await run(argv);
