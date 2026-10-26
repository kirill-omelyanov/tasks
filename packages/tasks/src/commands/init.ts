import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import {
  assertV2Tree,
  globalOptions,
  resolveCommandIdentity,
  startDirectory,
} from "../context.js";
import { isDirectory, pathExists, writeFileAtomic } from "../core/fs-utils.js";
import { touchSession } from "../core/sessions.js";
import type { SkillInstallResult } from "../core/skill.js";
import {
  SKILLS_RELATIVE_DIR,
  SKILL_NAME,
  installSkill,
} from "../core/skill.js";
import {
  configTemplate,
  gitignoreTemplate,
  readmeTemplate,
} from "../core/templates.js";
import type { Identity } from "../core/types.js";
import {
  CONFIG_FILENAME,
  GITIGNORE_FILENAME,
  LOCKS_DIRNAME,
  README_FILENAME,
  TASKS_DIRNAME,
} from "../core/types.js";
import { TaskError } from "../errors.js";
import { emitJson, ui, writeOut } from "../output.js";

interface InitOptions {
  force?: boolean;
  /** `--no-skill` sets it to false. */
  skill?: boolean;
  json?: boolean;
}

/** What `init --json` prints. */
export interface InitJson {
  actor: string;
  via: string | null;
  tasksDir: string;
  /** Absolute paths of the files and directories this run created. */
  created: string[];
  skill: Pick<SkillInstallResult, "installed" | "dir" | "files"> | null;
}

/**
 * Decide what an existing `.tasks/` allows. A v1 or unsupported tree is
 * refused before anything else, `--force` or not: every command but
 * `migrate` refuses a v1 tree, and completing its scaffold would hide its
 * tasks from `migrate`. A directory without `config.yml` is a v1 tree by the
 * convention's rule once it holds a directory other than `.locks/` (a phase,
 * an archive); one holding only files is an interrupted `init` or a bare
 * `mkdir`, which `--force` completes.
 */
async function checkExisting(
  root: string,
  tasksDir: string,
  force: boolean,
): Promise<void> {
  if (!(await isDirectory(tasksDir))) {
    throw TaskError.conflict(
      `${tasksDir} exists and is not a directory; move it aside first.`,
      { path: tasksDir },
    );
  }
  const entries = await fs.readdir(tasksDir, { withFileTypes: true });
  const unfinished =
    !entries.some((entry) => entry.name === CONFIG_FILENAME) &&
    entries.every(
      (entry) => !entry.isDirectory() || entry.name === LOCKS_DIRNAME,
    );
  if (!unfinished) await assertV2Tree({ root, tasksDir });
  if (!force) {
    throw TaskError.conflict(
      `${TASKS_DIRNAME}/ already exists at ${tasksDir}. Use --force to add the scaffold files it lacks; existing files are kept.`,
      { path: tasksDir },
    );
  }
}

/** Write `contents` to `file` unless it exists; true when written. */
async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
  // Under --force an edited config.yml (or README) must survive.
  if (await pathExists(file)) return false;
  await writeFileAtomic(file, contents);
  return true;
}

function actorLine(identity: Identity): string {
  const via = identity.via === null ? "" : ` via ${identity.via}`;
  return `  actor: ${ui.bold(identity.actor)}${via} ${ui.dim("(heads every log entry you write; TASKS_ACTOR or --as changes it)")}`;
}

export function initCommand(): Command {
  return new Command("init")
    .description(
      `scaffold a ${TASKS_DIRNAME}/ tree in the current directory (or -C <dir>), print the actor it resolved, and install the agent skill`,
    )
    .option(
      "--force",
      "add the scaffold files an existing tree lacks; never overwrites a file",
    )
    .option(
      "--no-skill",
      `skip installing the agent skill into ${SKILLS_RELATIVE_DIR}/`,
    )
    .option("--json", "emit machine-readable JSON")
    .action(async (options: InitOptions, command: Command) => {
      const global = globalOptions(command);
      const root = startDirectory(global);
      if (!(await isDirectory(root))) {
        throw TaskError.notFound(`"${root}" is not a directory.`, {
          cwd: root,
        });
      }
      // Resolved before anything is written: an invalid --as, TASKS_ACTOR or
      // --session fails the command with nothing on disk.
      const identity = await resolveCommandIdentity(global, root);

      const tasksDir = path.join(root, TASKS_DIRNAME);
      if (await pathExists(tasksDir)) {
        await checkExisting(root, tasksDir, options.force === true);
      }

      const created: string[] = [];
      await fs.mkdir(tasksDir, { recursive: true });
      const files: ReadonlyArray<readonly [string, string]> = [
        [CONFIG_FILENAME, configTemplate()],
        [README_FILENAME, readmeTemplate()],
        [GITIGNORE_FILENAME, gitignoreTemplate()],
      ];
      for (const [name, contents] of files) {
        const file = path.join(tasksDir, name);
        if (await writeIfAbsent(file, contents)) created.push(file);
      }
      const locks = path.join(tasksDir, LOCKS_DIRNAME);
      if ((await fs.mkdir(locks, { recursive: true })) !== undefined) {
        created.push(locks);
      }
      // Every command that knows a session touches the registry of the tree
      // it runs in; the tree exists from this point on.
      if (identity.session) await touchSession(tasksDir, identity.session);

      // The skill is what makes an agent reach for the CLI unprompted, so it
      // ships with the scaffold. An existing install is left alone, as the
      // config is; refreshing it is `tasks skill install --force`.
      const skill = options.skill === false ? null : await installSkill(root);

      if (options.json) {
        const result: InitJson = {
          actor: identity.actor,
          via: identity.via,
          tasksDir,
          created,
          skill: skill && {
            installed: skill.installed,
            dir: skill.dir,
            files: skill.files,
          },
        };
        emitJson(result);
        return;
      }

      const shown = (target: string) =>
        path.relative(process.cwd(), target) +
        (target === locks ? path.sep : "");
      writeOut(
        created.length === 0
          ? ui.info(
              `${TASKS_DIRNAME}/ at ${tasksDir} is complete; nothing to create`,
            )
          : ui.success(
              `Initialized ${ui.bold(`${TASKS_DIRNAME}/`)} at ${tasksDir}`,
            ),
      );
      writeOut(actorLine(identity));
      for (const target of created) writeOut(`  ${ui.dim(shown(target))}`);
      if (skill?.installed) {
        for (const file of skill.files) writeOut(`  ${ui.dim(shown(file))}`);
      }
      writeOut("");
      if (skill?.installed) {
        writeOut(
          ui.info(
            `Installed the ${ui.bold(SKILL_NAME)} skill so agents in this repo find the CLI.`,
          ),
        );
      } else if (skill !== null) {
        writeOut(
          ui.info(
            `The ${ui.bold(SKILL_NAME)} skill is already installed at ${shown(skill.dir)}; refresh it with ${ui.bold("tasks skill install --force")}.`,
          ),
        );
      }
      writeOut(
        ui.info(
          `Create your first task: ${ui.bold("tasks new <path> <title…>")}`,
        ),
      );
    });
}
