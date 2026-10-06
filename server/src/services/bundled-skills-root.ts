import fs from "node:fs";
import path from "node:path";

/**
 * The fork's test of a bundled-skills folder.
 *
 * Paperclip looks for its bundled skills in a `skills` folder next to the
 * module, in the working folder, and at the repository root, in that order.
 * A server started in a folder whose `skills` belongs to another repository
 * would take that folder as Paperclip's and never import the core skills.
 *
 * A folder is Paperclip's only when it holds the core skill `paperclip`
 * (the last part of the first key of `PAPERCLIP_CORE_SKILL_KEYS`) as
 * `paperclip/SKILL.md`. Synchronous, so the routes can call it as well.
 */
export function isPaperclipSkillsRoot(dir: string): boolean {
  try {
    return fs.statSync(path.join(dir, "paperclip", "SKILL.md")).isFile();
  } catch {
    return false;
  }
}
