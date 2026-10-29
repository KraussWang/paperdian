import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AttachmentResolver } from "../src/attachments/VaultAttachmentResolver";
import { validateDeepReadingOutput } from "../src/skills/DeepReadingOutputValidator";

const sourcePath = "raw/articles/source.md";
const sourceFrontmatter = `---
title: "English title"
source: "https://example.com/paper"
published: 2026-08-28
---`;

const outputFrontmatter = `---
title: "Nat. Commun.: 新界面设计让二维半导体接触电阻降低"
source: https://example.com/paper
published: "2026-08-28"
---`;

function article(overrides = "", image = "![Fig. 1](../raw/assets/figure.png)"): string {
  return `${outputFrontmatter}${overrides}

<small>
论文题目：English title<br>
第一作者：First Author<br>
通讯作者：Corresponding Author<br>
通讯单位：某大学<br>
DOI：https://doi.org/10.1000/example
</small>

## 研究背景

**研究对象**面临瓶颈，本文通过**核心方法**解决问题。

## 图表解读

### Figure 1. 主题

${image}

Figure 1 说明了**核心问题**。图中显示关键证据。该图支持的核心结论是：**关键结论**。

## 实验样品制备方法

**①样品制备：** 加入原料并反应。

## 知识拓展：创新点分析

创新。

## 总结

总结。
`;
}

async function createVault(): Promise<string> {
  const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-output-"));
  await mkdir(path.join(vault, "raw", "articles"), { recursive: true });
  await mkdir(path.join(vault, "raw", "assets"), { recursive: true });
  await writeFile(path.join(vault, sourcePath), `${sourceFrontmatter}\n\n# Source\n\n![[figure.png|Fig. 1]]`, "utf8");
  await writeFile(path.join(vault, "raw", "assets", "figure.png"), "image", "utf8");
  return vault;
}

async function writeOutput(vault: string, fileName = "Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md", markdown = article()): Promise<void> {
  const output = path.join(vault, "output");
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, fileName), markdown, "utf8");
}

function request(vaultPath: string, startedAt: Date) {
  return { vaultPath, sourceNotePath: sourcePath, startedAt };
}

describe("validateDeepReadingOutput", () => {
  it("accepts one direct output Markdown with copied metadata and asset references", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault);

    await expect(validateDeepReadingOutput(request(vault, startedAt))).resolves.toEqual({
      ok: true,
      relativePath: "output/Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md",
      warnings: []
    });
  });

  it("accepts an explicit missing-DOI marker when the clipped note has no DOI", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article().replace(
      "DOI：https://doi.org/10.1000/example",
      "DOI：文中未明确说明"
    ));

    await expect(validateDeepReadingOutput(request(vault, startedAt))).resolves.toEqual({
      ok: true,
      relativePath: "output/Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md",
      warnings: []
    });
  });

  it.each(["DOI：", "DOI：未提供"])("reports a non-canonical DOI line: %s", async doiLine => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article().replace(
      "DOI：https://doi.org/10.1000/example",
      doiLine
    ));

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("论文信息区必须使用固定五行顺序，前四行以 <br> 结尾。");
  });

  it("reports a missing current-turn direct output", async () => {
    const vault = await createVault();

    await expect(validateDeepReadingOutput(request(vault, new Date()))).resolves.toEqual({
      ok: false,
      issues: ["本轮未在 output/ 根目录生成精读 Markdown。"]
    });
  });

  it("treats an empty Markdown output as a delivery failure", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, "empty.md", "  \n");

    await expect(validateDeepReadingOutput(request(vault, startedAt))).resolves.toEqual({
      ok: false,
      issues: ["本轮生成的精读 Markdown 为空。"]
    });
  });

  it("reports a sidecar directory even when the Markdown is missing", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await mkdir(path.join(vault, "output", "images"), { recursive: true });

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected validation failure");
    expect(result.issues).toContain("本轮未在 output/ 根目录生成精读 Markdown。");
  });

  it("reports a filename that does not match frontmatter title", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, "wrong-name.md");

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("文件名必须与笔记属性 title 及年份对应：Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md。");
  });

  it("rejects a legacy H1 even when it matches frontmatter title", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article().replace("\n<small>", "\n# Nat. Commun.: 新界面设计让二维半导体接触电阻降低\n\n<small>"));

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("精读文件不得包含一级总标题，请仅保留 frontmatter.title。");
  });

  it("reports metadata that differs from the source note", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article().replace("source: https://example.com/paper", "source: https://changed.example"));

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("笔记属性 source 必须与原文语义值一致。");
  });

  it("reports sidecar files and directories in output", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault);
    await mkdir(path.join(vault, "output", "images"));
    await writeFile(path.join(vault, "output", "cover.png"), "image", "utf8");

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toEqual(expect.arrayContaining([
      "本轮不应在 output/ 中创建目录：images。",
      "本轮不应在 output/ 中创建附属文件：cover.png。"
    ]));
  });

  it("reports unresolved copied or missing image references without assuming a fixed attachment folder", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article("", "![Fig. 1](images/figure.png)\n![Fig. 2](../raw/assets/missing.png)"));

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toEqual(expect.arrayContaining([
      "图片不存在或路径超出当前 Vault：images/figure.png。",
      "图片不存在或路径超出当前 Vault：../raw/assets/missing.png。"
    ]));
  });

  it("reports a Figure image placed after its interpretation", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    const misplaced = article().replace(
      "![Fig. 1](../raw/assets/figure.png)\n\nFigure 1 说明了",
      "Figure 1 说明了"
    ).replace(
      "该图支持的核心结论是：**关键结论**。",
      "该图支持的核心结论是：**关键结论**。\n\n![Fig. 1](../raw/assets/figure.png)"
    );
    await writeOutput(vault, undefined, misplaced);

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("Figure 1 图片必须是标题后的第一个非空行。");
  });

  it("reports unsupported HTML, visible bold markers, and supplementary Figure sections", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    const invalid = article()
      .replace("创新。", "<span>创新。</span>")
      .replace("总结。", "总结 **残留 **符号。")
      .replace("## 实验样品制备方法", "### Supplementary Figure 2. 补充图\n\n![Fig. 2](../raw/assets/figure.png)\n\n## 实验样品制备方法");
    await writeOutput(vault, undefined, invalid);

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toEqual(expect.arrayContaining([
      "除规范论文信息区外不得包含原生 HTML 标签。",
      "存在未被解析的 ** 粗体标记，请检查配对、空格和中文标点边界。",
      "图表解读默认不得包含 Extended Data 或 Supplementary Figure。"
    ]));
  });

  it("reports nested bold produced by a Chinese closing bracket boundary", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault, undefined, article().replace(
      "**研究对象**面临瓶颈，本文通过**核心方法**解决问题。",
      "**研究对象（GOMs）**因其特点，本文通过**核心方法**解决问题。"
    ));

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toContain("存在由中文标点边界导致的嵌套粗体，请在闭合标记后留一个空格。");
  });

  it("does not accept an output created before this turn", async () => {
    const vault = await createVault();
    await writeOutput(vault);

    await expect(validateDeepReadingOutput(request(vault, new Date(Date.now() + 60_000)))).resolves.toEqual({
      ok: false,
      issues: ["本轮未在 output/ 根目录生成精读 Markdown。"]
    });
  });

  it("accepts Nature and warns about titles without a journal or research finding", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    const nature = article().replace("Nat. Commun.: 新界面设计让二维半导体接触电阻降低", "Nature: 新界面设计让二维半导体接触电阻降低");
    await writeOutput(vault, "Nature_新界面设计让二维半导体接触电阻降低_2026.md", nature);
    await expect(validateDeepReadingOutput(request(vault, startedAt))).resolves.toMatchObject({ ok: true });

    for (const invalidTitle of ["NatCommun | 中文题目 | 2026", ": 新界面设计让二维半导体接触电阻降低", "Nature: ", "某大学 Nature: 新界面设计让二维半导体接触电阻降低"]) {
      const invalidVault = await createVault();
      const invalidStartedAt = new Date();
      const invalid = article().replace("Nat. Commun.: 新界面设计让二维半导体接触电阻降低", invalidTitle);
      await writeOutput(invalidVault, "invalid.md", invalid);
      const result = await validateDeepReadingOutput(request(invalidVault, invalidStartedAt));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected generated article");
      expect(result.warnings).toContain("笔记属性 title 必须为“期刊缩写: 通俗的研究看点”。");
    }
  });

  it("warns about absent, escaped, and incomplete source-note metadata after finding output", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault);
    await expect(validateDeepReadingOutput({ vaultPath: vault, startedAt })).resolves.toEqual({
      ok: true, relativePath: "output/Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md", warnings: ["未固定当前原文笔记，无法校验笔记属性。"]
    });
    await expect(validateDeepReadingOutput({ vaultPath: vault, sourceNotePath: "../outside.md", startedAt })).resolves.toEqual({
      ok: true, relativePath: "output/Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md", warnings: ["原文笔记路径超出当前 Vault。"]
    });
    await writeFile(path.join(vault, sourcePath), "---\ntitle: source\n---\nbody");
    await expect(validateDeepReadingOutput(request(vault, startedAt))).resolves.toEqual({
      ok: true, relativePath: "output/Nat. Commun._新界面设计让二维半导体接触电阻降低_2026.md", warnings: ["原文笔记缺少属性：source、published。"]
    });
  });

  it("treats attachment resolver failures as a visible invalid-image issue", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    await writeOutput(vault);
    const resolver: AttachmentResolver = {
      async resolve() { throw new Error("index unavailable"); },
      destinationPath() { return ""; },
      relativePath() { return ""; }
    };

    const result = await validateDeepReadingOutput({ ...request(vault, startedAt), attachmentResolver: resolver });
    expect(result).toMatchObject({ ok: true, warnings: ["图片不存在或路径超出当前 Vault：../raw/assets/figure.png。"] });
  });

  it("reports malformed frontmatter and section-specific bold violations", async () => {
    const vault = await createVault();
    const startedAt = new Date();
    const invalid = article()
      .replace(outputFrontmatter, "---\ntitle: not-a-valid-title\nextra: value\n---")
      .replace("**研究对象**面临瓶颈，本文通过**核心方法**解决问题。", "**only once**")
      .replace("**①样品制备：** 加入原料并反应。", "没有步骤标题。")
      .replace("创新。", "**不应加粗**")
      .replace("总结。", "**也不应加粗**");
    await writeOutput(vault, undefined, invalid);

    const result = await validateDeepReadingOutput(request(vault, startedAt));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected generated article");
    expect(result.warnings).toEqual(expect.arrayContaining([
      "精读文件的 frontmatter 只能包含 title、source、published。",
      "笔记属性 title 必须为“期刊缩写: 通俗的研究看点”。",
      "“研究背景”必须且只能包含 2 处粗体。",
      "“实验样品制备方法”必须使用带圈数字步骤和加粗步骤标题。",
      "“知识拓展：创新点分析”不得使用粗体。",
      "“总结”不得使用粗体。"
    ]));
  });
});
