import { TaskError } from "../errors.js";
import { assertLogText } from "./workspace.js";

/**
 * `## Notes` of `task.md`: the one edit of a body the tooling makes. A note is
 * an input for whoever works on the task next — the provenance of a decision,
 * a finding, a link — dated and attributed, appended as a list item under the
 * heading; the rest of the body is left as it is. The log is history and its
 * last entry is displaced by the next claim or priority change, so a note
 * belongs in the file the next reader opens first.
 */

const NOTES_HEADING = /^## notes\s*$/i;
const SECTION_HEADING = /^#{1,2} /;
const LIST_ITEM = /^(?:[-*+] | {2})/;

/**
 * Refuse text that would corrupt the body or the log: a markdown heading
 * would open a section of its own, a log heading or a conflict marker would
 * break the log entry. Call it before anything is written.
 */
export function assertNoteText(text: string): void {
  if (text.trim().length === 0) {
    throw TaskError.usage('A note needs text: tasks note <task> "<text>".', {
      text,
    });
  }
  text.split(/\r?\n/).forEach((line, index) => {
    if (/^#/.test(line)) {
      throw TaskError.usage(
        `Line ${index + 1} of the note reads as a markdown heading and would open a section of the body: ${JSON.stringify(line)}. Indent or rephrase it.`,
        { line: index + 1, text: line },
      );
    }
  });
  assertLogText(text);
}

/**
 * `- 2026-11-15, maria: text`, with `maria via agent` when an operator acted
 * on the actor's behalf; continuation lines are indented so the item holds
 * them. LF line ends, no blank lines at either end.
 */
export function noteItem(
  date: string,
  actor: string,
  via: string | null,
  text: string,
): string {
  const who = via === null ? actor : `${actor} via ${via}`;
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\s+$/, "")
    .split("\n");
  const [first, ...rest] = lines;
  return [
    `- ${date}, ${who}: ${first}`,
    ...rest.map((line) => (line.trim().length === 0 ? "" : `  ${line}`)),
  ].join("\n");
}

/**
 * The body with `item` appended at the end of its `## Notes` section: right
 * after a list, after a blank line otherwise, with a blank line before the
 * section that follows. A body without the heading gets it at its end.
 * Nothing else moves; the caller normalizes the ends when writing.
 */
export function appendNote(body: string, item: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const heading = lines.findIndex((line) => NOTES_HEADING.test(line));
  if (heading < 0) {
    const trimmed = body.replace(/\s+$/, "");
    return trimmed.length === 0
      ? `## Notes\n\n${item}`
      : `${trimmed}\n\n## Notes\n\n${item}`;
  }

  let end = heading + 1;
  while (end < lines.length && !SECTION_HEADING.test(lines[end]!)) end += 1;
  const section = lines.slice(heading + 1, end);
  while (section.length > 0 && section[section.length - 1]!.trim() === "") {
    section.pop();
  }
  const last = section[section.length - 1];
  const joined =
    last === undefined
      ? ["", item]
      : LIST_ITEM.test(last)
        ? [...section, item]
        : [...section, "", item];
  const rest = lines.slice(end);
  return [
    ...lines.slice(0, heading + 1),
    ...joined,
    ...(rest.length > 0 ? ["", ...rest] : []),
  ].join("\n");
}
