import fs from "node:fs/promises";
import path from "node:path";

import yaml from "js-yaml";

import { TaskError } from "../errors.js";
import { findProject } from "./discovery.js";
import { yamlScalar } from "./frontmatter.js";
import { errnoCode, isDirectory } from "./fs-utils.js";
import { isMachineBoundPath, isTaskPath } from "./ids.js";
import {
  CONFIG_FILENAME,
  CONVENTION_VERSION,
  DEFAULT_SESSION_TIMEOUT_MINUTES,
  SEGMENT_PATTERN,
} from "./types.js";

export interface Config {
  version: 2;
  /** Default query scope, a group or task path; never limits addressing. */
  scope: string | null;
  sessionTimeoutMinutes: number;
  /** Days after which a resolved task is expected to be archived; `null` unset. */
  archiveResolvedAfterDays: number | null;
  /** Alias → path relative to the project root. Has no prototype. */
  projects: Record<string, string>;
}

/** What `loadConfig` returns for a v1 tree when the caller allows one. */
export interface V1Config {
  version: 1;
}

export type TreeVersion =
  | { kind: "v2"; config: Config }
  | { kind: "v1" }
  | { kind: "unsupported"; version: number };

export interface LoadConfigOptions {
  /** Return `{ version: 1 }` for a v1 tree instead of refusing it. */
  allowV1?: boolean;
}

export const CONFIG_KEYS = [
  "version",
  "scope",
  "session_timeout_minutes",
  "archive_resolved_after_days",
  "projects",
] as const;

const V1_KEY_HINTS: Record<string, string> = {
  active_phase: "; v2 calls it `scope`",
  statuses: "; the v2 lifecycle is fixed",
  roles: "; the v2 lifecycle is fixed",
  transitions: "; the v2 lifecycle is fixed",
};

export function defaultConfig(): Config {
  return {
    version: CONVENTION_VERSION,
    scope: null,
    sessionTimeoutMinutes: DEFAULT_SESSION_TIMEOUT_MINUTES,
    archiveResolvedAfterDays: null,
    projects: Object.create(null) as Record<string, string>,
  };
}

/** The configured path of `alias`, without reaching into the prototype. */
export function projectPathOf(
  config: Config,
  alias: string,
): string | undefined {
  return Object.hasOwn(config.projects, alias)
    ? config.projects[alias]
    : undefined;
}

/* ------------------------------------------------------------------------ */
/* Parsing                                                                  */
/* ------------------------------------------------------------------------ */

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  return String(value);
}

function invalid(file: string, message: string, key?: string): TaskError {
  return TaskError.usage(`${file}: ${message}`, {
    file,
    ...(key === undefined ? {} : { key }),
  });
}

function parseV2(doc: Record<string, unknown>, file: string): Config {
  for (const key of Object.keys(doc)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw invalid(
        file,
        `unknown key "${key}"${V1_KEY_HINTS[key] ?? ""}. The keys of a v2 config.yml are ${CONFIG_KEYS.join(", ")}.`,
        key,
      );
    }
  }

  const config = defaultConfig();

  // An optional key set to null reads as absent: `projects:` with every alias
  // commented out is an ordinary editing state, not an error.
  const scope = doc.scope;
  if (scope !== undefined && scope !== null) {
    if (typeof scope !== "string" || !isTaskPath(scope)) {
      throw invalid(
        file,
        `scope must be a group or task path such as auth-rework, got ${describe(scope)}.`,
        "scope",
      );
    }
    config.scope = scope;
  }

  const timeout = doc.session_timeout_minutes;
  if (timeout !== undefined && timeout !== null) {
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < 1
    ) {
      throw invalid(
        file,
        `session_timeout_minutes must be an integer of at least 1, got ${describe(timeout)}.`,
        "session_timeout_minutes",
      );
    }
    config.sessionTimeoutMinutes = timeout;
  }

  const archiveAfter = doc.archive_resolved_after_days;
  if (archiveAfter !== undefined && archiveAfter !== null) {
    if (
      typeof archiveAfter !== "number" ||
      !Number.isInteger(archiveAfter) ||
      archiveAfter < 1
    ) {
      throw invalid(
        file,
        `archive_resolved_after_days must be an integer of at least 1, got ${describe(archiveAfter)}.`,
        "archive_resolved_after_days",
      );
    }
    config.archiveResolvedAfterDays = archiveAfter;
  }

  const projects = doc.projects;
  if (projects !== undefined && projects !== null) {
    if (!isMapping(projects)) {
      throw invalid(
        file,
        `projects must be a mapping of alias to relative path, got ${describe(projects)}.`,
        "projects",
      );
    }
    for (const [alias, target] of Object.entries(projects)) {
      if (!SEGMENT_PATTERN.test(alias)) {
        throw invalid(
          file,
          `project alias "${alias}" must match ${SEGMENT_PATTERN.source}.`,
          "projects",
        );
      }
      if (typeof target !== "string" || target.length === 0) {
        throw invalid(
          file,
          `project "${alias}" must map to a relative path, got ${describe(target)}.`,
          "projects",
        );
      }
      if (isMachineBoundPath(target)) {
        throw invalid(
          file,
          `project "${alias}" maps to the absolute path "${target}"; use a path relative to the project root, so it resolves in every clone.`,
          "projects",
        );
      }
      config.projects[alias] = target;
    }
  }

  return config;
}

/**
 * Classify and parse a `config.yml` source without touching the disk. A
 * missing `version` (or an empty document, which v1 allowed) is a v1 tree.
 */
export function parseConfigText(source: string, file: string): TreeVersion {
  let doc: unknown;
  try {
    doc = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    const reason = err instanceof yaml.YAMLException ? err.reason : String(err);
    throw invalid(file, `invalid YAML: ${reason}.`);
  }

  if (doc === undefined || doc === null) return { kind: "v1" };
  if (!isMapping(doc)) {
    throw invalid(file, `expected a mapping of keys, got ${describe(doc)}.`);
  }
  if (!Object.hasOwn(doc, "version")) return { kind: "v1" };

  const version = doc.version;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw invalid(
      file,
      `version must be the integer ${CONVENTION_VERSION}, got ${describe(version)}.`,
      "version",
    );
  }
  if (version === 1) return { kind: "v1" };
  if (version !== CONVENTION_VERSION) return { kind: "unsupported", version };
  return { kind: "v2", config: parseV2(doc, file) };
}

async function realOrResolved(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Reject an alias that leads back to this tree: through discovery, a path
 * inside this project without a `.tasks/` of its own resolves here too. A
 * path that is not checked out cannot be judged and is left to the projects
 * layer as not checked out.
 */
async function rejectSelfAliases(
  config: Config,
  root: string,
  file: string,
): Promise<void> {
  const aliases = Object.entries(config.projects);
  if (aliases.length === 0) return;

  const self = await realOrResolved(root);
  for (const [alias, target] of aliases) {
    const resolved = path.resolve(root, target);
    if (!(await isDirectory(resolved))) continue;
    const found = await findProject(resolved);
    if (found && (await realOrResolved(found.root)) === self) {
      throw TaskError.usage(
        `${file}: project "${alias}" (${target}) resolves to this tree itself; an alias must name another tree.`,
        { file, key: "projects", alias, path: target },
      );
    }
  }
}

/** Which convention version the tree at `tasksDir` declares. */
export async function detectTreeVersion(
  tasksDir: string,
): Promise<TreeVersion> {
  const file = path.join(tasksDir, CONFIG_FILENAME);
  let source: string;
  try {
    source = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = errnoCode(err);
    if (code === "ENOENT") return { kind: "v1" };
    throw invalid(file, `cannot be read (${code ?? String(err)}).`);
  }

  const detected = parseConfigText(source, file);
  if (detected.kind === "v2") {
    await rejectSelfAliases(detected.config, path.dirname(tasksDir), file);
  }
  return detected;
}

/**
 * The tree's v2 configuration. A v1 tree is refused with the upgrade named,
 * unless the caller (`migrate`) allows it; an unsupported version is refused
 * outright.
 */
export async function loadConfig(tasksDir: string): Promise<Config>;
export async function loadConfig(
  tasksDir: string,
  options: { allowV1: true },
): Promise<Config | V1Config>;
export async function loadConfig(
  tasksDir: string,
  options?: LoadConfigOptions,
): Promise<Config | V1Config>;
export async function loadConfig(
  tasksDir: string,
  options: LoadConfigOptions = {},
): Promise<Config | V1Config> {
  const detected = await detectTreeVersion(tasksDir);
  switch (detected.kind) {
    case "v2":
      return detected.config;
    case "v1":
      if (options.allowV1) return { version: 1 };
      throw TaskError.usage(
        `${tasksDir} is a .tasks v1 tree (no \`version: ${CONVENTION_VERSION}\` in config.yml). Run \`tasks migrate\` to upgrade it.`,
        { tasksDir, version: 1, upgrade: "tasks migrate" },
      );
    case "unsupported":
      throw TaskError.usage(
        `${path.join(tasksDir, CONFIG_FILENAME)}: version ${detected.version} is not supported; this tasks implements .tasks convention version ${CONVENTION_VERSION}.`,
        {
          file: path.join(tasksDir, CONFIG_FILENAME),
          version: detected.version,
          supported: CONVENTION_VERSION,
        },
      );
  }
}

/* ------------------------------------------------------------------------ */
/* Serialization                                                            */
/* ------------------------------------------------------------------------ */

/**
 * Canonical `config.yml`: `version` first, then only the keys that differ
 * from their defaults, aliases in their configured order.
 */
export function renderConfig(config: Config): string {
  const lines = [`version: ${CONVENTION_VERSION}`];
  if (config.scope !== null) lines.push(`scope: ${yamlScalar(config.scope)}`);
  if (config.sessionTimeoutMinutes !== DEFAULT_SESSION_TIMEOUT_MINUTES) {
    lines.push(`session_timeout_minutes: ${config.sessionTimeoutMinutes}`);
  }
  if (config.archiveResolvedAfterDays !== null) {
    lines.push(
      `archive_resolved_after_days: ${config.archiveResolvedAfterDays}`,
    );
  }
  const aliases = Object.entries(config.projects);
  if (aliases.length > 0) {
    lines.push("projects:");
    for (const [alias, target] of aliases) {
      lines.push(`  ${yamlScalar(alias)}: ${yamlScalar(target)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
