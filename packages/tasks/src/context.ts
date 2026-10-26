import path from "node:path";

import type { Command } from "commander";

import { detectTreeVersion } from "./core/config.js";
import type { Project } from "./core/discovery.js";
import { requireProject } from "./core/discovery.js";
import { GateResolver } from "./core/gates.js";
import type { LoadedTree } from "./core/projects.js";
import { Projects } from "./core/projects.js";
import {
  housekeepSessions,
  resolveIdentity,
  touchSession,
} from "./core/sessions.js";
import type { Tree } from "./core/tree.js";
import { loadTree } from "./core/tree.js";
import type { Identity } from "./core/types.js";
import { CONVENTION_VERSION, CONFIG_FILENAME } from "./core/types.js";
import { TaskError } from "./errors.js";
import { ui, writeErr } from "./output.js";

/** The options every command accepts, declared once on the program. */
export interface GlobalOptions {
  dir?: string;
  as?: string;
  session?: string;
  json?: boolean;
}

export interface CommandContext {
  /** Where discovery started: `-C` or the working directory. */
  startDir: string;
  project: Project;
  /** The local tree as of its latest reload. */
  readonly tree: Tree;
  projects: Projects;
  gates: GateResolver;
  identity: Identity;
  json: boolean;
  /** Re-read the local tree from disk and drop cached gate resolutions. */
  reload(): Promise<void>;
  /** The local tree first, then every listed tree that is available. */
  trees(): Promise<LoadedTree[]>;
}

/** Program-level options as seen from a subcommand's action. */
export function globalOptions(command: Command): GlobalOptions {
  const merged = command.optsWithGlobals() as GlobalOptions;
  return {
    dir: merged.dir,
    as: merged.as,
    session: merged.session,
    json: merged.json,
  };
}

export function startDirectory(options: GlobalOptions): string {
  return path.resolve(options.dir ?? process.cwd());
}

/** Identity without a tree: what `init` needs before anything exists. */
export async function resolveCommandIdentity(
  options: GlobalOptions,
  projectRoot: string,
): Promise<Identity> {
  return resolveIdentity({
    as: options.as,
    session: options.session,
    projectRoot,
    diagnose: (message) => writeErr(ui.warn(message)),
  });
}

/**
 * Refuse to operate on a tree that is not v2. A v1 tree names the upgrade;
 * `migrate` is the one command that opens it, through its own path.
 */
export async function assertV2Tree(project: Project): Promise<void> {
  const detected = await detectTreeVersion(project.tasksDir);
  if (detected.kind === "v2") return;
  if (detected.kind === "v1") {
    throw TaskError.usage(
      `${project.tasksDir} is a .tasks v1 tree. Run \`tasks migrate\` once to upgrade it to v${CONVENTION_VERSION}; every other command refuses a v1 tree.`,
      { tasksDir: project.tasksDir, version: 1, upgrade: "tasks migrate" },
    );
  }
  throw TaskError.usage(
    `${path.join(project.tasksDir, CONFIG_FILENAME)}: version ${detected.version} is not supported; this tasks implements .tasks convention v${CONVENTION_VERSION}.`,
    { tasksDir: project.tasksDir, version: detected.version },
  );
}

/**
 * Open the workspace for a command: discovery from `-C`, the version check,
 * the local tree, the projects it lists, the acting identity, and the
 * heartbeat that every command with a session writes before its own work.
 */
export async function openContext(command: Command): Promise<CommandContext> {
  const options = globalOptions(command);
  const startDir = startDirectory(options);
  const project = await requireProject(startDir);
  await assertV2Tree(project);

  const identity = await resolveCommandIdentity(options, project.root);
  const projects = new Projects(await loadTree(project));
  const gates = new GateResolver(projects);

  if (identity.session) {
    await heartbeat(projects, identity.session);
  }

  const context: CommandContext = {
    startDir,
    project,
    // Always the latest snapshot: a mutation that reloads through `projects`
    // is seen here without a second bookkeeping step.
    get tree() {
      return projects.local.tree;
    },
    projects,
    gates,
    identity,
    json: options.json === true,
    async reload() {
      await projects.reload(projects.local);
      gates.invalidate();
    },
    async trees() {
      return projects.writableTrees();
    },
  };
  return context;
}

/**
 * Touch the session's registry file in the local tree and in every listed
 * tree that is checked out, then tidy the local registry. Liveness of a
 * claim is judged by the registry of the tree that holds the task, which is
 * why one command reaches every tree it can see.
 */
export async function heartbeat(
  projects: Projects,
  session: string,
): Promise<string[]> {
  const touched: string[] = [];
  for (const load of await projects.writableTrees()) {
    await touchSession(load.project.tasksDir, session);
    touched.push(load.project.tasksDir);
  }
  await housekeepSessions(projects.local.tree);
  return touched;
}
