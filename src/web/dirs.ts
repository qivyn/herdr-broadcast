/**
 * Folders on this machine, for the form's "其他目录" field: what is under the folder being typed,
 * and whether the typed folder is there. Local only: a remote machine's folders would take a
 * round trip over SSH.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveCwd } from "../engine.ts";
import { LOCAL } from "../herdr.ts";

const MAX_SUGGESTIONS = 30;

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The folders that could complete what was typed, and whether the typed path itself is a folder.
 * "~/Co" lists the folders in the home folder starting with "Co"; "~/Code/" lists all in ~/Code.
 * Hidden folders only when a dot was typed. A suggestion reads as the field should once chosen:
 * what was typed up to its last /, the name, a /.
 */
export function listDirs(typed: string): { suggestions: { value: string }[]; target: { exists: boolean } | null } {
  let text = typed.trim() || "~/";
  if (text === "~") text = "~/";
  const full = resolveCwd(LOCAL, text);
  if (!full.startsWith("/")) return { suggestions: [], target: null };
  const cut = text.lastIndexOf("/") + 1;
  const shownParent = text.slice(0, cut);
  const stem = text.slice(cut);
  const parent = resolveCwd(LOCAL, shownParent);
  let names: string[] = [];
  try {
    names = readdirSync(parent, { withFileTypes: true })
      .filter((d) => d.isDirectory() || (d.isSymbolicLink() && isDir(join(parent, d.name))))
      .map((d) => d.name);
  } catch {
    /* not there, or not ours to read */
  }
  const lower = stem.toLowerCase();
  const suggestions = names
    .filter((name) => (stem.startsWith(".") || !name.startsWith(".")) && name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => ({ value: `${shownParent}${name}/` }));
  return { suggestions, target: { exists: isDir(full) } };
}
