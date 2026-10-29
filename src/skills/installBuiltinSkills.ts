import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import deepReading from "./builtin/material-paper-deep-reading/SKILL.md";
import wechatEditor from "./builtin/material-paper-wechat-editor/SKILL.md";

const builtins = [
  { id: "material-paper-deep-reading", markdown: deepReading },
  { id: "material-paper-wechat-editor", markdown: wechatEditor }
];

/** Install only missing directories; an existing user's Skill is never overwritten. */
export async function installBuiltinSkills(directory: string): Promise<{ installed: number; skipped: number }> {
  await mkdir(directory, { recursive: true });
  let installed = 0;
  let skipped = 0;
  for (const skill of builtins) {
    const destination = path.join(directory, skill.id);
    try { await mkdir(destination); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") { skipped++; continue; }
      throw error;
    }
    await writeFile(path.join(destination, "SKILL.md"), skill.markdown, { encoding: "utf8", flag: "wx" });
    installed++;
  }
  return { installed, skipped };
}
