import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installBuiltinSkills } from "../src/skills/installBuiltinSkills";
import { SkillCatalog } from "../src/skills/SkillCatalog";

const temporary: string[] = [];
afterEach(async () => { for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true }); });

describe("installing bundled Skills", () => {
  it("creates two usable Skills and never replaces existing user content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-"));
    temporary.push(root);
    const directory = path.join(root, ".paperdian", "skills");
    expect(await installBuiltinSkills(directory)).toEqual({ installed: 2, skipped: 0 });
    const catalog = await new SkillCatalog({ directory }).list();
    expect(catalog.skills).toHaveLength(2);
    expect(catalog.diagnostics).toEqual([]);
    const file = path.join(directory, "material-paper-deep-reading", "SKILL.md");
    await writeFile(file, "user-owned instructions");
    expect(await installBuiltinSkills(directory)).toEqual({ installed: 0, skipped: 2 });
    expect(await readFile(file, "utf8")).toBe("user-owned instructions");
  });
});
