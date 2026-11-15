import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { VERSION } from "../src/cli.js";
import type { CollectionJson } from "../src/core/types.js";
import { ACTOR_ENV, SESSION_ENV, TASKS_DIRNAME } from "../src/core/types.js";
import { ExitCode } from "../src/errors.js";
import type { TaskSpec } from "./fixtures.js";
import { writeTree } from "./fixtures.js";

/**
 * The entry point as a child process. The in-process runner of the other
 * suites stubs the streams, so what only the bin can get wrong is checked
 * here: that a --json answer longer than a pipe's buffer reaches the reader
 * whole, that the exit code survives the way the process ends, and that a
 * wide tree is read within the descriptor limit of the process.
 */

/** The pipe buffer of macOS, where stdout to a pipe is asynchronous. */
const PIPE_BUFFER = 65_536;
/** The default soft descriptor limit of a macOS process. */
const DESCRIPTORS = 256;
/**
 * Tasks enough for `list --json` to pass the pipe buffer several times over,
 * and for a log read per task at once to pass the descriptor limit.
 */
const WIDE = 600;

let root: string;
let outDir: string;
let bin: string;
let project: string;

interface BinResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Run the bin with stdout and stderr piped, as a harness captures them. With
 * `descriptors`, the process runs under that hard limit of open files, set
 * by the shell before it starts.
 */
async function runBin(
  args: string[],
  options: { descriptors?: number } = {},
): Promise<BinResult> {
  const env = {
    ...process.env,
    [ACTOR_ENV]: "tester",
    [SESSION_ENV]: undefined,
  };
  const [command, argv]: [string, string[]] =
    options.descriptors === undefined
      ? [process.execPath, [bin, ...args]]
      : [
          "/bin/sh",
          [
            "-c",
            `ulimit -n ${options.descriptors} && exec "$0" "$@"`,
            process.execPath,
            bin,
            ...args,
          ],
        ];
  const child = spawn(command, argv, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [stdout, stderr, code] = await Promise.all([
    collect(child.stdout),
    collect(child.stderr),
    new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode));
    }),
  ]);
  return { code, stdout, stderr };
}

function collectionOf(result: BinResult): CollectionJson {
  expect(result.stderr).toBe("");
  expect(result.code).toBe(ExitCode.Success);
  return JSON.parse(result.stdout) as CollectionJson;
}

beforeAll(async () => {
  root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agent-tasks-bin-")),
  );
  // The bundle as `tsup.config.ts` ships it, dependencies external, so it
  // is built under the package's node_modules, where they resolve from.
  const cache = fileURLToPath(
    new URL("../node_modules/.cache/", import.meta.url),
  );
  await fs.mkdir(cache, { recursive: true });
  outDir = await fs.mkdtemp(path.join(cache, "tasks-bin-"));
  await build({
    entry: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
    outDir,
    format: ["esm"],
    target: "node20",
    platform: "node",
    define: { __PKG_VERSION__: JSON.stringify(VERSION) },
    config: false,
    clean: false,
    sourcemap: false,
    silent: true,
  });
  bin = path.join(outDir, "index.js");

  project = path.join(root, "repo");
  const tasks: Record<string, TaskSpec> = {};
  for (let i = 0; i < WIDE; i += 1) {
    tasks[`item-${i}`] = { log: "## 2026-01-01T00:00:00Z tester\nnew: TODO\n" };
  }
  await writeTree(path.join(project, TASKS_DIRNAME), { tasks });
}, 60_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
});

describe("the bin", () => {
  it("delivers a --json answer longer than the pipe buffer whole", async () => {
    const result = await runBin(["-C", project, "list", "--json"]);
    expect(Buffer.byteLength(result.stdout)).toBeGreaterThan(PIPE_BUFFER);
    const collection = collectionOf(result);
    expect(collection.count).toBe(WIDE);
    expect(collection.tasks).toHaveLength(WIDE);
  });

  it("exits with the error's code, the envelope on stderr alone", async () => {
    const result = await runBin(["-C", project, "show", "nope", "--json"]);
    expect(result.code).toBe(ExitCode.NotFound);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "NOT_FOUND" },
    });
  });

  it.skipIf(process.platform === "win32")(
    "reads a wide tree within the default descriptor limit",
    async () => {
      const result = await runBin(["-C", project, "ready", "--json"], {
        descriptors: DESCRIPTORS,
      });
      expect(collectionOf(result).count).toBe(WIDE);
    },
  );
});
