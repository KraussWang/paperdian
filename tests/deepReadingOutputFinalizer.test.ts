import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSystemAttachmentResolver } from "../src/attachments/VaultAttachmentResolver";
import type { AttachmentResolver } from "../src/attachments/VaultAttachmentResolver";
import { finalizeDeepReadingOutput, normalizeBoldMarkdown, parseFrontmatterScalars } from "../src/skills/DeepReadingOutputFinalizer";
import { validateDeepReadingOutput } from "../src/skills/DeepReadingOutputValidator";

describe("DeepReadingOutputFinalizer", () => {
  it("normalizes the two reported bold boundary failures", () => {
    expect(normalizeBoldMarkdown("**堆叠氧化石墨烯膜（GOMs）**因其特点，本文提出**方法**，解决问题。"))
      .toBe("**堆叠氧化石墨烯膜（GOMs）** 因其特点，本文提出**方法**，解决问题。");
    expect(normalizeBoldMarkdown("**②不同氧化度GO制备： **采用改良 Hummers 法。"))
      .toBe("**②不同氧化度GO制备：** 采用改良 Hummers 法。");
  });

  it("preserves fenced or empty bold markers and reads quoted frontmatter scalars", () => {
    expect(normalizeBoldMarkdown("**   **\n```markdown\n** keep spaces **\n```\n**标题：**后续文字"))
      .toBe("**   **\n```markdown\n** keep spaces **\n```\n**标题：** 后续文字");
    expect(parseFrontmatterScalars("---\ntitle: 'Ada''s paper'\nsource: \"https://example.com/a\"\nbroken: \"unterminated\n---\nbody"))
      .toEqual(new Map([["title", "Ada's paper"], ["source", "https://example.com/a"], ["broken", "\"unterminated"]]));
    expect(parseFrontmatterScalars("not frontmatter")).toEqual(new Map());
  });

  it("repairs metadata, paper info, bold spacing, and Figure placement before validation", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-finalizer-"));
    const sourcePath = path.join(vault, "raw", "articles", "source.md");
    const outputPath = path.join(vault, "output", "Nature_新界面设计降低接触电阻_2026.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.join(vault, "raw", "assets"), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(path.join(vault, "raw", "assets", "figure.png"), "image", "utf8");
    await writeFile(sourcePath, `---
title: "English title"
source: "https://example.com/paper"
published: 2026-08-28
---

# Source

![[figure.png|Fig. 1: Source figure]]
`, "utf8");
    await writeFile(outputPath, `---
title: "Nature: 新界面设计降低接触电阻"
source: https://wrong.example
published: wrong
extra: remove-me
---

# Nature: 新界面设计降低接触电阻

<small>论文题目：English title<br>第一作者：First Author<br>通讯作者：Corresponding Author<br>通讯单位：某大学<br>DOI：https://doi.org/10.1000/example</small>

## 研究背景

**堆叠氧化石墨烯膜（GOMs）**因其特点，本文提出**核心方法**，解决问题。

## 图表解读

### Figure 1. 主题

Figure 1 说明了**核心问题**。图中显示关键证据。该图支持的核心结论是：**关键结论**。

![Fig. 1](../raw/assets/wrong.png)

## 实验样品制备方法

**①制备： **加入原料。

## 知识拓展：创新点分析

创新内容。

## 总结

总结。
`, "utf8");

    const startedAt = new Date(Date.now() - 1_000);
    const result = await finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/articles/source.md", startedAt });
    const markdown = await readFile(outputPath, "utf8");

    expect(result.issues).toEqual([]);
    expect(result.repairs).toEqual(expect.arrayContaining([
      "已统一 title/source/published 属性。",
      "已移除与 frontmatter.title 重复的一级总标题。",
      "已规范论文信息区的字段顺序与换行。",
      "已修正粗体标记内侧空格和中文标点边界。",
      "已将主文 Figure 图片移动到对应标题下方。"
    ]));
    expect(markdown).toContain('title: "Nature: 新界面设计降低接触电阻"');
    expect(markdown).not.toContain("# Nature: 新界面设计降低接触电阻");
    expect(markdown).toContain('source: "https://example.com/paper"');
    expect(markdown).not.toContain("extra: remove-me");
    expect(markdown).toContain("**堆叠氧化石墨烯膜（GOMs）** 因其特点");
    expect(markdown).toContain("**①制备：** 加入原料");
    expect(markdown).toMatch(/### Figure 1\. 主题\r?\n\r?\n!\[Fig\. 1: Source figure]\(\.\.\/raw\/assets\/figure\.png\)\r?\n\r?\nFigure 1 说明/);
    expect(markdown).not.toContain("wrong.png");
    await expect(validateDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/articles/source.md", startedAt })).resolves.toEqual({
      ok: true,
      relativePath: "output/Nature_新界面设计降低接触电阻_2026.md",
      warnings: []
    });
  });

  it("uses a current-note subfolder attachment setting when repairing and validating Figure paths", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-finalizer-setting-"));
    const sourcePath = path.join(vault, "raw", "articles", "source.md");
    const outputPath = path.join(vault, "output", "Nature_新界面设计降低接触电阻_2026.md");
    await mkdir(path.join(vault, "raw", "articles", "assets"), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(path.join(vault, "raw", "articles", "assets", "figure.png"), "image", "utf8");
    await writeFile(sourcePath, `---
source: https://example.com/paper
published: 2026-08-28
---

# Source

![[figure.png|Fig. 1]]
`, "utf8");
    await writeFile(outputPath, `---
title: "Nature: 新界面设计降低接触电阻"
source: https://example.com/paper
published: 2026-08-28
---
# Nature: 新界面设计降低接触电阻

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

Figure 1 说明了**核心问题**。图中显示关键证据。该图支持的核心结论是：**关键结论**。

## 实验样品制备方法

**①样品制备：** 加入原料并反应。

## 知识拓展：创新点分析

创新。

## 总结

总结。
`, "utf8");
    const startedAt = new Date(Date.now() - 1_000);
    const attachmentResolver = createFileSystemAttachmentResolver(vault, "./assets");

    await expect(finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/articles/source.md", startedAt, attachmentResolver }))
      .resolves.toMatchObject({ issues: [] });
    expect(await readFile(outputPath, "utf8")).toContain("![Fig. 1](../raw/articles/assets/figure.png)");
    await expect(validateDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/articles/source.md", startedAt, attachmentResolver })).resolves.toEqual({
      ok: true,
      relativePath: "output/Nature_新界面设计降低接触电阻_2026.md",
      warnings: []
    });
  });

  it("keeps a valid article when optional Figure resolution fails", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-finalizer-resolver-"));
    const sourcePath = path.join(vault, "raw", "source.md");
    const outputPath = path.join(vault, "output", "article.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(sourcePath, "---\nsource: https://example.com\npublished: 2026-01-01\n---\n\n![[figure.png|Fig. 1]]");
    await writeFile(outputPath, "---\ntitle: Article\n---\n\n### Figure 1\n\nExplanation.");
    const resolver: AttachmentResolver = {
      async resolve() { throw new Error("attachment index unavailable"); },
      destinationPath() { return ""; },
      relativePath() { return ""; }
    };

    await expect(finalizeDeepReadingOutput({
      vaultPath: vault, sourceNotePath: "raw/source.md", startedAt: new Date(Date.now() - 1_000), attachmentResolver: resolver
    })).resolves.toMatchObject({ relativePath: "output/article.md", issues: [] });
    await expect(readFile(outputPath, "utf8")).resolves.not.toContain("![Fig. 1]");
  });

  it("reports missing output and source-note boundary failures without writing outside the vault", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-finalizer-boundary-"));
    const startedAt = new Date();
    await expect(finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/source.md", startedAt })).resolves.toEqual({
      repairs: [], issues: ["本轮未在 output/ 根目录生成精读 Markdown。"]
    });

    const outputPath = path.join(vault, "output", "article.md");
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "---\ntitle: Article\n---\nbody");
    await expect(finalizeDeepReadingOutput({ vaultPath: vault, startedAt: new Date(Date.now() - 1_000) })).resolves.toEqual({
      relativePath: "output/article.md", repairs: [], issues: ["未固定当前原文笔记，无法自动整理精读输出。"]
    });
    await expect(finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "../outside.md", startedAt: new Date(Date.now() - 1_000) })).resolves.toEqual({
      relativePath: "output/article.md", repairs: [], issues: ["原文笔记路径超出当前 Vault。"]
    });
  });

  it("does not rewrite frontmatter when the output title or source metadata is incomplete", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-finalizer-metadata-"));
    const sourcePath = path.join(vault, "raw", "source.md");
    const outputPath = path.join(vault, "output", "article.md");
    await mkdir(path.dirname(sourcePath), { recursive: true });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(sourcePath, "---\nsource: https://example.com\npublished: 2026-01-01\n---\nbody");
    await writeFile(outputPath, "---\nsource: old\npublished: old\n---\nbody");

    await expect(finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/source.md", startedAt: new Date(Date.now() - 1_000) })).resolves.toEqual({
      relativePath: "output/article.md", repairs: [], issues: ["精读文件缺少 frontmatter.title，无法自动修正 title。"]
    });
    await writeFile(sourcePath, "---\nsource: https://example.com\n---\nbody");
    const result = await finalizeDeepReadingOutput({ vaultPath: vault, sourceNotePath: "raw/source.md", startedAt: new Date(Date.now() - 1_000) });
    expect(result.relativePath).toBe("output/article.md");
    expect(result.repairs).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining(["精读文件缺少 frontmatter.title，无法自动修正 title。", "原文笔记缺少 published，无法自动修正该属性。"]));
  });
});
