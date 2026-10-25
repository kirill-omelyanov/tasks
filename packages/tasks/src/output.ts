import Table from "cli-table3";
import pc from "picocolors";

export interface OutputOptions {
  json: boolean;
}

/** Successful output goes to stdout; diagnostics and errors go to stderr. */
export function writeOut(text: string): void {
  process.stdout.write(`${text}\n`);
}

export function writeErr(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function emitJson(value: unknown): void {
  writeOut(JSON.stringify(value, null, 2));
}

/** A borderless table; the renderers build on it. */
export function table(head: string[]): Table.Table {
  return new Table({
    head: head.map((h) => pc.bold(h)),
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: " ",
    },
  });
}

export const ui = {
  success: (msg: string): string => `${pc.green("✓")} ${msg}`,
  info: (msg: string): string => `${pc.cyan("•")} ${msg}`,
  warn: (msg: string): string => `${pc.yellow("!")} ${msg}`,
  error: (msg: string): string => `${pc.red("✗")} ${msg}`,
  dim: (msg: string): string => pc.dim(msg),
  bold: (msg: string): string => pc.bold(msg),
};
