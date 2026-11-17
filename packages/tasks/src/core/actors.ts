import path from "node:path";

import { TaskError } from "../errors.js";
import type { Config } from "./config.js";
import { defaultActorType } from "./config.js";
import type { Project } from "./discovery.js";
import { ACTOR_GIT_KEY } from "./sessions.js";
import type { ActorType } from "./types.js";
import { ACTOR_ENV, CONFIG_FILENAME } from "./types.js";

/**
 * The roster: the actors `config.yml` lists under `actors:`. An empty roster
 * constrains nothing. With one, a name typed for someone else — the actor of
 * `assign`, `handoff` and `new --assign`, `--as`, the hooks' `--actor` — must
 * be on it, so a misspelt name cannot create an inbox nobody reads. The
 * identity a command resolves for itself is only diagnosed: it comes from
 * the environment, and so does the remedy.
 */

/** The listed actors in configured order; empty when none are listed. */
export function listedActors(config: Config): string[] {
  return Object.keys(config.actors);
}

export function hasRoster(config: Config): boolean {
  return listedActors(config).length > 0;
}

export function isListed(config: Config, actor: string): boolean {
  return Object.hasOwn(config.actors, actor);
}

/** The line `config.yml` gives a listed actor, else `null`. */
export function descriptionOf(config: Config, actor: string): string | null {
  return isListed(config, actor)
    ? (config.actors[actor]?.description ?? null)
    : null;
}

/**
 * What the actor is: the roster's `type` when it lists the actor, else
 * `agent` for the conventional name and `person` for any other.
 */
export function actorTypeOf(config: Config, actor: string): ActorType {
  return config.actors[actor]?.type ?? defaultActorType(actor);
}

function configFileOf(project: Project): string {
  return path.join(project.tasksDir, CONFIG_FILENAME);
}

/**
 * A listed actor that differs from `actor` in case alone, or that is the
 * local part of an e-mail address `actor` fell back to, if there is one.
 */
function nearMatch(config: Config, actor: string): string | null {
  const folded = actor.toLowerCase();
  const local = folded.includes("@")
    ? folded.slice(0, folded.indexOf("@"))
    : null;
  return (
    listedActors(config).find(
      (name) => name.toLowerCase() === folded || name.toLowerCase() === local,
    ) ?? null
  );
}

function hint(config: Config, actor: string): string {
  const near = nearMatch(config, actor);
  return near === null ? "" : ` Did you mean ${near}?`;
}

/** How a person names themselves once, with the near match when there is one. */
function nameOnce(config: Config, actor: string): string {
  const near = nearMatch(config, actor) ?? "<name>";
  return `set your name once to a listed one — git config --global ${ACTOR_GIT_KEY} ${near}, or ${ACTOR_ENV} — or add ${actor} there`;
}

/**
 * Refuse a typed actor the roster does not list: a usage error naming the
 * listed actors and the file to extend. `label` is the argument or option
 * the actor came from, for the error's details; `remedy` replaces the
 * default advice when the command has a better one.
 */
export function assertListedActor(
  config: Config,
  project: Project,
  actor: string,
  label: string,
  remedy = `use one of them or add "${actor}" there`,
): string {
  if (!hasRoster(config) || isListed(config, actor)) return actor;
  const file = configFileOf(project);
  const actors = listedActors(config);
  throw TaskError.usage(
    `Unknown actor "${actor}": ${file} lists ${actors.join(", ")} under actors:; ${remedy}.${hint(config, actor)}`,
    { field: label, value: actor, actors, file },
  );
}

/**
 * The warning for an acting identity the roster does not list, or `null`
 * when it is listed or there is no roster. `role` is how the identity acts:
 * the actor itself, or the operator behind an `--as`.
 */
export function unlistedActorWarning(
  config: Config,
  project: Project,
  actor: string,
  role: "actor" | "operator",
): string | null {
  if (!hasRoster(config) || isListed(config, actor)) return null;
  const file = configFileOf(project);
  const listed = listedActors(config).join(", ");
  return role === "actor"
    ? `actor ${actor} is not listed under actors: in ${file} (${listed}); reads go on, writes are refused. ${capitalize(nameOnce(config, actor))}.${hint(config, actor)}`
    : `operator ${actor} is not listed under actors: in ${file} (${listed}); ${nameOnce(config, actor)}.${hint(config, actor)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Refuse a write under an acting identity the roster lacks: a usage error
 * with the listed actors, the file and the remedy, like a typed name the
 * roster lacks. Reads are only diagnosed, so a newcomer can look around
 * before naming themselves; a write would record a name nobody finds.
 */
export function assertActingActorListed(
  config: Config,
  project: Project,
  actor: string,
): void {
  if (!hasRoster(config) || isListed(config, actor)) return;
  const file = configFileOf(project);
  const actors = listedActors(config);
  throw TaskError.usage(
    `You act as ${actor}, which ${file} does not list under actors: (${actors.join(", ")}); a write under a name the roster lacks is refused. ${capitalize(nameOnce(config, actor))}.${hint(config, actor)}`,
    { field: "actor", value: actor, actors, file },
  );
}
