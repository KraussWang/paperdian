import { access, chmod, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MATERIAL_PAPER_DEEP_READING_SKILL_ID, SkillCatalog } from "../src/skills/SkillCatalog";

const skill = (name: string, description: string, instructions: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n\n${instructions}\n`;

describe("SkillCatalog", () => {
  it("stages a complete local skill for one selection callback without exposing mutations to the source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skill-bundle-"));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, "writer");
    await mkdir(path.join(source, "references"), { recursive: true });
    await mkdir(path.join(source, "scripts"), { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill("writer", "撰写文章", "先读 references/style.md，再运行 scripts/render.js。"));
    await writeFile(path.join(source, "references", "style.md"), "source style");
    const scriptPath = path.join(source, "scripts", "render.js");
    await writeFile(scriptPath, "console.log('render');\n");
    if (process.platform !== "win32") await chmod(scriptPath, 0o755);
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const listed = await catalog.list();
    const writerId = listed.skills.find(item => item.name === "writer")?.id;
    expect(writerId).toBeTypeOf("string");
    let stagedDirectory = "";

    const callbackResult = await catalog.withSelection([writerId!], async selected => {
      expect(selected).toHaveLength(1);
      stagedDirectory = selected[0]?.resourceDirectory ?? "";
      expect(stagedDirectory).not.toBe("");
      expect(stagedDirectory).not.toContain(source);
      expect(await readFile(path.join(stagedDirectory, "references", "style.md"), "utf8")).toBe("source style");
      expect(await readFile(path.join(stagedDirectory, "scripts", "render.js"), "utf8")).toContain("render");
      if (process.platform !== "win32") expect((await stat(path.join(stagedDirectory, "scripts", "render.js"))).mode & 0o111).not.toBe(0);
      await writeFile(path.join(stagedDirectory, "references", "style.md"), "staged mutation");
      return "callback result";
    });

    expect(callbackResult).toBe("callback result");
    await expect(access(stagedDirectory)).rejects.toThrow();
    expect(await readFile(path.join(source, "references", "style.md"), "utf8")).toBe("source style");
  });

  it("rejects a selected skill whose supporting files escape through a directory link", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skill-link-"));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, "linked");
    const outside = path.join(root, "outside");
    await mkdir(source, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill("linked", "链接测试", "读取 resources/secret.txt。"));
    await writeFile(path.join(outside, "secret.txt"), "must stay outside");
    await symlink(outside, path.join(source, "resources"), "junction");
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const selectedId = (await catalog.list()).skills.find(item => item.name === "linked")?.id;
    const callback = vi.fn(async () => undefined);

    await expect(catalog.withSelection([selectedId!], callback)).rejects.toThrow("越界软链接");
    expect(callback).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "broken", expected: "损坏软链接" },
    { kind: "cycle", expected: "循环软链接" }
  ])("rejects $kind supporting-file links before invoking the selection callback", async ({ kind, expected }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `paperdian-skill-${kind}-`));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, kind);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill(kind, "链接测试", "读取附属文件。"));
    if (kind === "cycle") {
      await symlink(source, path.join(source, "loop"), "junction");
    } else {
      const target = path.join(root, "temporary-target");
      await mkdir(target);
      await symlink(target, path.join(source, "missing"), "junction");
      await rm(target, { recursive: true, force: true });
    }
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const selectedId = (await catalog.list()).skills.find(item => item.name === kind)?.id;
    const callback = vi.fn(async () => undefined);

    await expect(catalog.withSelection([selectedId!], callback)).rejects.toThrow(expected);
    expect(callback).not.toHaveBeenCalled();
  });

  it("reports cleanup failures without replacing the selection callback result", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skill-cleanup-"));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, "cleanup");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill("cleanup", "清理测试", "完成任务。"));
    const warnings: string[] = [];
    let cleanupTarget = "";
    const catalog = new SkillCatalog({
      directory: skillsRoot,
      onWarning: message => warnings.push(message),
      removeDirectory: async directory => {
        cleanupTarget = directory;
        throw new Error("locked");
      }
    });
    const selectedId = (await catalog.list()).skills.find(item => item.name === "cleanup")?.id;

    const result = await catalog.withSelection([selectedId!], async () => "completed answer");

    expect(result).toBe("completed answer");
    expect(warnings).toEqual([expect.stringContaining("无法清理 Skill 临时目录")]);
    expect(cleanupTarget).not.toBe("");
    await rm(cleanupTarget, { recursive: true, force: true });
  });

  it("cleans the staged selection when the callback fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skill-callback-error-"));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, "failing");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill("failing", "回调失败测试", "完成任务。"));
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const selectedId = (await catalog.list()).skills.find(item => item.name === "failing")?.id;
    let stagedDirectory = "";

    await expect(catalog.withSelection([selectedId!], async selected => {
      stagedDirectory = selected[0]?.resourceDirectory ?? "";
      throw new Error("runtime failed");
    })).rejects.toThrow("runtime failed");

    expect(stagedDirectory).not.toBe("");
    await expect(access(stagedDirectory)).rejects.toThrow();
  });

  it("stages the material skill from its dedicated directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-material-skill-"));
    const source = path.join(root, "material-paper-deep-reading");
    await mkdir(source);
    await writeFile(path.join(source, "SKILL.md"), skill("material-paper-deep-reading", "材料精读", "编辑后的正文"));
    const removeDirectory = vi.fn(async () => undefined);
    const catalog = new SkillCatalog({
      directory: root,
      removeDirectory
    });

    await catalog.withSelection([MATERIAL_PAPER_DEEP_READING_SKILL_ID], async selected => {
      expect(selected[0]?.instructions).toBe("编辑后的正文");
      expect(selected[0]?.resourceDirectory).toBeTypeOf("string");
    });

    expect(removeDirectory).toHaveBeenCalledOnce();
  });

  it.each([
    {
      kind: "single-file",
      expected: "单文件超过 25 MB：assets/large.bin",
      populate: async (source: string) => createSparseFile(path.join(source, "assets", "large.bin"), 25_000_001)
    },
    {
      kind: "aggregate-size",
      expected: "附属资源合计超过 50 MB",
      populate: async (source: string) => {
        await createSparseFile(path.join(source, "assets", "one.bin"), 20_000_000);
        await createSparseFile(path.join(source, "assets", "two.bin"), 20_000_000);
        await createSparseFile(path.join(source, "assets", "three.bin"), 10_000_001);
      }
    },
    {
      kind: "file-count",
      expected: "附属资源文件数超过 500",
      populate: async (source: string) => {
        const directory = path.join(source, "references");
        await mkdir(directory, { recursive: true });
        await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(path.join(directory, `${index}.md`), "x")));
      }
    }
  ])("rejects a selected skill that exceeds the $kind resource limit", async ({ kind, expected, populate }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `paperdian-skill-${kind}-`));
    const skillsRoot = path.join(root, "skills");
    const source = path.join(skillsRoot, kind);
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), skill(kind, "资源限制测试", "读取附属文件。"));
    await populate(source);
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const selectedId = (await catalog.list()).skills.find(item => item.name === kind)?.id;
    const callback = vi.fn(async () => undefined);

    await expect(catalog.withSelection([selectedId!], callback)).rejects.toThrow(expected);
    expect(callback).not.toHaveBeenCalled();
  });

  it("lists only dedicated-library skills and rereads edits and deletions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-"));
    const home = path.join(root, "home");
    const userSkill = path.join(home, ".claude", "skills", "critic");
    const skillsRoot = path.join(root, ".paperdian", "skills");
    const sourceSkill = path.join(skillsRoot, "summarizer");
    await mkdir(userSkill, { recursive: true });
    await mkdir(sourceSkill, { recursive: true });
    await writeFile(path.join(userSkill, "SKILL.md"), skill("critic", "核对论证", "检查论据。"));
    await writeFile(path.join(sourceSkill, "SKILL.md"), skill("summarizer", "生成摘要", "生成结构化摘要。"));

    const catalog = new SkillCatalog({ directory: skillsRoot });
    const result = await catalog.list();

    expect(result.skills.map(item => item.name)).toEqual(["summarizer"]);
    expect(result.diagnostics).toEqual([]);
    await writeFile(path.join(sourceSkill, "SKILL.md"), skill("summarizer", "新版摘要", "编辑后的指令。"));
    expect((await catalog.list()).skills[0]).toMatchObject({ description: "新版摘要", instructions: "编辑后的指令。" });
    await catalog.withSelection([result.skills[0]!.id], async selected => {
      expect(selected[0]?.instructions).toBe("编辑后的指令。");
    });
    await rm(sourceSkill, { recursive: true });
    expect((await catalog.list()).skills).toEqual([]);
  });

  it("excludes invalid and oversized skills and enforces the selected instruction budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-"));
    const skillsRoot = path.join(root, "skills");
    await mkdir(path.join(skillsRoot, "invalid"), { recursive: true });
    await mkdir(path.join(skillsRoot, "oversized"), { recursive: true });
    await writeFile(path.join(skillsRoot, "invalid", "SKILL.md"), "No frontmatter");
    await writeFile(path.join(skillsRoot, "oversized", "SKILL.md"), skill("huge", "太大", "x".repeat(100_001)));

    const catalog = new SkillCatalog({ directory: skillsRoot });
    const result = await catalog.list();

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toHaveLength(2);
    await expect(catalog.withSelection(["missing"], async () => undefined)).rejects.toThrow("Skill 已不可用");
  });

  it("enforces the aggregate selected-instruction limit without rejecting an exact boundary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-budget-"));
    const skillsRoot = path.join(root, "skills");
    for (const name of ["first", "second"]) {
      const directory = path.join(skillsRoot, name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "SKILL.md"), skill(name, "description", "x".repeat(99_950)));
    }
    const catalog = new SkillCatalog({ directory: skillsRoot });
    const result = await catalog.list();
    const localIds = result.skills.filter(item => item.source === "local").map(item => item.id);

    await expect(catalog.withSelection(localIds, async selected => selected.length)).resolves.toBe(2);
    const extra = path.join(skillsRoot, "third");
    await mkdir(extra);
    await writeFile(path.join(extra, "SKILL.md"), skill("third", "description", "x".repeat(101)));
    const allIds = (await catalog.list()).skills.map(item => item.id);
    await expect(catalog.withSelection(allIds, async () => undefined)).rejects.toThrow("合计超过 200 KB");
  });

  it("treats a missing library as empty and rejects linked skills outside it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-home-"));
    const skillsRoot = path.join(root, "skills");
    const catalog = new SkillCatalog({ directory: skillsRoot });
    expect(await catalog.list()).toEqual({ skills: [], diagnostics: [] });
    await mkdir(skillsRoot);
    const external = path.join(root, "external");
    await mkdir(external);
    await writeFile(path.join(external, "SKILL.md"), skill("external", "outside", "do not load"));
    await symlink(external, path.join(skillsRoot, "external"), "junction");
    const result = await catalog.list();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([expect.objectContaining({ message: "Skill 文件位于专用库目录之外。" })]);
  });

  it("reports a library read error without loading fallback skills", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-unreadable-"));
    const invalidDirectory = path.join(root, "skills");
    await writeFile(invalidDirectory, "not a directory");
    const result = await new SkillCatalog({ directory: invalidDirectory }).list();
    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ path: invalidDirectory })]));
  });
});

async function createSparseFile(filePath: string, size: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "w");
  try { await handle.truncate(size); }
  finally { await handle.close(); }
}
