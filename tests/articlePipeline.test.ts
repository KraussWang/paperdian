import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createFileSystemAttachmentResolver } from "../src/attachments/VaultAttachmentResolver";
import { WeChatArticlePipeline } from "../src/wechat/WeChatArticlePipeline";
import { buildWeChatDraftPayload } from "../src/wechat/WeChatApi";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQkUZ0pv+BiOh/AAA=", "base64");

describe("WeChatArticlePipeline", () => {
  it("renders and identifies all academic palettes in preview and draft", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-palettes-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 示例
cover: figure.png
---
## 标题

正文 [链接](https://example.com/long-link)。

> 研究亮点

![图片](figure.png)

图 1：说明。

## 论文信息

- 题目：示例
`);
    const palettes = [
      ["mono", "#202020", "#f5f5f5"], ["academic-blue", "#183a7b", "#deeaf2"],
      ["nature-green", "#075035", "#eaf1ee"], ["editorial-red", "#843131", "#f3e9e8"],
      ["elegant-purple", "#4c3878", "#edeaf3"], ["teal", "#03677a", "#e5f0f2"],
      ["warm-brown", "#5a3f23", "#f1eeea"], ["slate", "#39495b", "#e9eaed"]
    ] as const;
    const pipeline = new WeChatArticlePipeline(vault);
    const hashes = new Set<string>();
    for (const [theme, primary, surface] of palettes) {
      const article = await pipeline.prepare({ path: "article.md" }, { author: "", theme });
      hashes.add(article.sourceHash);
      expect(article.theme.name).toBe(theme);
      for (const html of [article.html, article.previewHtml]) {
        expect(html).toContain(`color: ${primary}`);
        expect(html).toContain(`border-left: 3px solid ${primary}`);
        expect(html).toContain(`background: ${surface}`);
        expect(html).toContain('class="paperdian-caption"');
        expect(html).toContain('class="paperdian-paper-info paperdian-bibliography"');
        expect(html).toContain("overflow-wrap: anywhere");
        expect(html).toContain("background: #ffffff");
      }
      expect(article.html).toContain("paperdian-asset://body-1");
      expect(article.previewHtml).toContain("data:image/png;base64,");
    }
    expect(hashes.size).toBe(palettes.length);
  });

  it("preserves the teal theme in preview and draft content", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-teal-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 湖蓝青示例
cover: figure.png
source: https://doi.org/10.1000/example
---
# 湖蓝青示例

<small>
论文题目：Atomic-scale transformations<br>
第一作者：示例作者<br>
通讯作者：示例作者<br>
通讯单位：示例单位<br>
DOI：https://doi.org/10.1000/very-long-example
</small>

> **核心发现**：材料结构观察。

## 研究背景

Cr<sub>2</sub>O<sub>3</sub> 与 Å⁻¹，参见 [原文](https://example.com/long-link)。

![图 1](figure.png)

图 1：结构示意。

![[figure.png|图 2]]

图 2：另一幅图。

![没有图注](figure.png)

普通正文。

## 论文信息

- 题目：示例论文
- DOI：[10.1000/example](https://doi.org/10.1000/example)
`);
    const pipeline = new WeChatArticlePipeline(vault);
    const teal = await pipeline.prepare({ path: "article.md" }, { author: "", theme: "teal" });
    const original = await pipeline.prepare({ path: "article.md" }, { author: "" });

    expect(teal.theme.name).toBe("teal");
    expect(teal.sourceHash).not.toBe(original.sourceHash);
    expect(teal.html).toContain("background: #e5f0f2");
    expect(teal.html).toContain("border-left: 3px solid #03677a");
    expect(teal.html).toContain("font-size: 17px; line-height: 1.75");
    expect(teal.html).toContain("color: #222222");
    expect(teal.html.match(/class="paperdian-caption"/g)).toHaveLength(2);
    expect(teal.html).toMatch(/class="paperdian-caption"[^>]*font-size: 13px[^>]*font-style: normal/);
    expect(teal.html).toContain('class="paperdian-paper-info paperdian-bibliography"');
    expect(teal.previewHtml).toContain('class="paperdian-caption"');
    expect(teal.metadata.sourceUrl).toBe("https://doi.org/10.1000/example");
    expect(buildWeChatDraftPayload({ ...teal.metadata, html: teal.html, coverMediaId: "cover", needOpenComment: 0, onlyFansCanComment: 0 }).articles[0]?.content_source_url).toBe("https://doi.org/10.1000/example");
    expect(teal.html).toContain("overflow-wrap: anywhere");
    expect(teal.html).toContain("Cr<sub>2</sub>O<sub>3</sub>");
    expect(teal.html).toContain("paperdian-asset://body-1");
    expect(teal.previewHtml).toContain("data:image/png;base64,");
    expect(teal.html).not.toContain("<h1");
  });

  it("keeps attachment paths relative when the Vault root resolves through an alias", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "paperdian-vault-alias-"));
    const vault = path.join(parent, "vault");
    const alias = path.join(parent, "alias");
    await mkdir(vault);
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), "---\ntitle: Alias test\ncover: cover.png\n---\n正文。\n");
    await symlink(vault, alias, process.platform === "win32" ? "junction" : "dir");

    const prepared = await new WeChatArticlePipeline(alias).prepare({ path: "article.md" }, { author: "" });
    expect(prepared.cover.sourcePath).toBe("cover.png");
  });

  it("removes an empty first paragraph from draft content that starts with display math", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-leading-blank-"));
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), "---\ntitle: 标题\ncover: cover.png\n---\n# 标题\n\n$$E=mc^2$$\n\n正文。\n");

    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "" });

    expect(prepared.html).toMatch(/^<div id="output"[^>]*><section class="container"[^>]*><section class="paperdian-math is-display"/);
    expect(prepared.previewHtml).toContain("<!doctype html>");
    expect(prepared.html).not.toMatch(/<section class="container"[^>]*>\s*<p[^>]*>\s*<\/p>/);
  });

  it("freezes a validated default/blue article and its local images", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-article-"));
    await mkdir(path.join(vault, "article", "figures"), { recursive: true });
    await writeFile(path.join(vault, "article", "cover.jpg"), PNG);
    await writeFile(path.join(vault, "article", "figures", "plot.png"), PNG);
    await writeFile(path.join(vault, "article", "paper.md"), `---
title: Al₁₋ₓScₓN 研究
summary: 应被忽略
author: Sample Author
sourceUrl: https://doi.org/10.1/example
---

正文引用。

## 图表解读

### Figure 1. 主图

![图 1](figures/plot.png)

## 总结

第一段**总结**。

第二段不应成为摘要。
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const prepared = await pipeline.prepare({ path: "article/paper.md" }, { theme: "academic-blue", color: "blue", author: "Configured author" });

    expect(prepared.metadata.title).toBe("Al₁₋ₓScₓN 研究");
    expect(prepared.metadata.summary).toBe("第一段总结。");
    expect(prepared.theme).toEqual({ name: "academic-blue", color: "blue" });
    expect(prepared.images).toHaveLength(1);
    expect(prepared.cover.sourcePath).toBe("article/figures/plot.png");
    expect(prepared.cover.mimeType).toBe("image/png");
    expect(prepared.html).toContain("paperdian-asset://");
    expect(prepared.html).toContain('style="display: block; max-width: 100%; height: auto; margin: 1em auto;"');
    expect(prepared.html).not.toContain("<h1");
    expect(prepared.previewHtml).toContain("data:image/png;base64,");
    expect(prepared.previewHtml).toContain('style="display: block; max-width: 100%; height: auto; margin: 1em auto;"');
    expect(prepared.sourceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("warns about remote body images while allowing Mermaid and a valid cover", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-invalid-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "bad.md"), `---
title: 正确标题
summary: 摘要
author: 作者
sourceUrl: https://example.com
cover: figure.png
---
![remote](https://example.com/a.png)
\`\`\`mermaid
graph TD
\`\`\`
`);
    const pipeline = new WeChatArticlePipeline(vault);
    try {
      const result = await pipeline.preparePreview({ path: "bad.md" }, { author: "Configured author" });
      expect(result.prepared).toBeDefined();
      expect(result.blockers).toEqual([]);
      expect(result.warnings).toEqual(["远程正文图片未上传，草稿中将显示缺图提示：https://example.com/a.png"]);
      expect(result.prepared?.html).toContain("图片无法预览：remote · https://example.com/a.png");
      expect(result.previewHtml).toContain('class="language-mermaid"');
    } catch (error) {
      throw new Error(`preview preparation unexpectedly failed: ${String(error)}`);
    }
  });

  it("renders the canonical paper information block as compact HTML without leaking source tags", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-info-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: Nature | 中文题目 | 2026
source: https://example.com/source
---
<small>
论文题目：English title<br>
第一作者：First Author<br>
通讯作者：Corresponding Author<br>
通讯单位：某大学<br>
DOI：https://doi.org/10.1000/example
</small>

正文。

![Figure 1](figure.png)
`);

    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "配置作者" });

    expect(prepared.metadata.title).toBe("Nature | 中文题目 | 2026");
    expect(prepared.html).not.toContain("<h1");
    expect(prepared.html).not.toContain("&lt;small&gt;");
    expect(prepared.html).not.toContain("&lt;br&gt;");
    expect(prepared.html).toContain("paperdian-paper-info");
    expect(prepared.html).toContain("font-size: 13px");
    expect(prepared.html).toContain("论文题目：English title");
  });

  it("allows unsupported HTML and visible bold markers without warnings", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-markup-safety-"));
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
source: https://example.com/source
cover: cover.png
---
# 标题

<small>不完整的信息块</small>

**未闭合的粗体 **正文

![封面](cover.png)
`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "配置作者" });

    expect(result.blockers).toEqual([]);
    expect(result.prepared).toBeDefined();
    expect(result.previewHtml).toContain("&lt;small&gt;");
    expect(result.previewHtml).toContain("不完整的信息块");
    expect(result.previewHtml).toContain("&lt;/small&gt;");
    expect(result.previewHtml).toContain("**");
  });

  it("allows CommonMark nested bold caused by a closing Chinese bracket", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-nested-bold-"));
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
source: https://example.com/source
cover: cover.png
---
# 标题

**堆叠氧化石墨烯膜（GOMs）**因其特点，本文提出**核心方法**，解决问题。

![封面](cover.png)
`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "配置作者" });

    expect(result.blockers).toEqual([]);
    expect(result.prepared).toBeDefined();
    expect(result.previewHtml).toContain("<strong");
  });

  it("uses the configured author, sends an empty summary when absent, prefers source, and falls back to the first body image for cover", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-metadata-"));
    await writeFile(path.join(vault, "first.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
author: Frontmatter author
source: https://example.com/preferred
Source: https://example.com/legacy-capitalized
sourceUrl: https://example.com/legacy-camel-case
---
![第一张图](first.png)
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const prepared = await pipeline.prepare({ path: "article.md" }, { author: "配置作者" });

    expect(prepared.metadata).toEqual({
      title: "标题",
      summary: "",
      author: "配置作者",
      sourceUrl: "https://example.com/preferred"
    });
    expect(prepared.cover.sourcePath).toBe("first.png");
    expect(prepared.cover.alt).toBe("第一张图");
    expect(prepared.images).toHaveLength(1);
  });

  it("uses the first H1 as title and allows empty author and source", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-optional-metadata-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
summary: 可选摘要
---
# H1 标题

正文。

![正文图](figure.png)
`);

    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "" });

    expect(prepared.metadata).toEqual({ title: "H1 标题", summary: "", author: "", sourceUrl: "" });
    expect(prepared.previewHtml).not.toContain("<h1");
  });

  it("returns a preview but no publishable snapshot when the title is missing", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-missing-title-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `正文。

![正文图](figure.png)
`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });

    expect(result.prepared).toBeUndefined();
    expect(result.blockers).toEqual(["文章必须包含 frontmatter.title 或一级标题。"]);
    expect(result.previewHtml).toContain("正文。");
  });

  it("uses placeholders for bad images while preserving valid images and the rest of the preview", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-partial-images-"));
    await writeFile(path.join(vault, "valid.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
---
![有效图](valid.png)

中间正文。

![<坏图>](missing.png)
`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });

    expect(result.prepared).toBeDefined();
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual(["图片必须位于当前 Vault 且可访问：missing.png"]);
    expect(result.prepared?.html).toContain("图片无法预览：&lt;坏图&gt; · missing.png");
    expect(result.previewHtml).toContain("data:image/png;base64,");
    expect(result.previewHtml).toContain("中间正文。");
    expect(result.previewHtml).toContain("图片无法预览：&lt;坏图&gt; · missing.png");
    expect(result.previewHtml).not.toContain("PAPER_READING_IMAGE_");
  });

  it("rejects non-Markdown files but has no raw Markdown size gate", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-fatal-preview-"));
    await writeFile(path.join(vault, "article.txt"), "plain text");
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "large.md"), `---\ntitle: 任意标题\ncover: cover.png\n---\n正文。\n${" ".repeat(2_000_001)}`);
    const pipeline = new WeChatArticlePipeline(vault);

    await expect(pipeline.preparePreview({ path: "article.txt" }, { author: "" })).rejects.toMatchObject({ issues: ["当前文件不是 Markdown。"] });
    await expect(pipeline.preparePreview({ path: "large.md" }, { author: "" })).resolves.toMatchObject({ blockers: [], prepared: { metadata: { title: "任意标题" } } });
  });

  it("uses the first body image before Figure 1 and accepts the legacy summary heading", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-figure-cover-"));
    await writeFile(path.join(vault, "intro.png"), PNG);
    await writeFile(path.join(vault, "figure-1.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: Nature | 中文题目 | 2026
summary: 旧摘要
source: https://example.com/source
---

![前置图片](intro.png)

## 图表解读

### Figure 1. 主图

![Fig. 1](figure-1.png)

## 一句话总结

这是**首段**摘要，包含[链接](https://example.com)。

这一段不应被使用。
`);

    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "配置作者" });

    expect(prepared.metadata).toMatchObject({
      title: "Nature | 中文题目 | 2026",
      summary: "这是首段摘要，包含链接。"
    });
    expect(prepared.cover.sourcePath).toBe("intro.png");
  });

  it("prefers frontmatter.cover over a valid Figure 1 image", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-cover-fallback-"));
    await writeFile(path.join(vault, "explicit.png"), PNG);
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---\ntitle: 看懂新材料\ncover: explicit.png\n---\n正文。\n\n## 图表解读\n\n### Figure 1. 主图\n\n![主图](figure.png)\n`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });
    expect(result.blockers).toEqual([]);
    expect(result.prepared?.cover.sourcePath).toBe("explicit.png");
    expect(result.prepared?.images[0]?.sourcePath).toBe("figure.png");
  });

  it("blocks a broken first body image instead of using a later image", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-body-cover-fallback-"));
    await writeFile(path.join(vault, "body.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---\ntitle: 看懂新材料\n---\n正文。\n\n## 图表解读\n\n### Figure 1. 主图\n\n![主图](missing.png)\n\n![另一张图](body.png)\n`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });
    expect(result.blockers).toEqual(["公众号封面不可用：图片必须位于当前 Vault 且可访问：missing.png"]);
    expect(result.prepared).toBeUndefined();
    expect(result.warnings).toContain("图片必须位于当前 Vault 且可访问：missing.png");
    expect(result.previewHtml).toContain("图片无法预览：主图 · missing.png");
  });

  it("blocks an empty body even when frontmatter provides a usable cover", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-empty-body-"));
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---\ntitle: 看懂新材料\ncover: cover.png\n---\n# 看懂新材料\n`);

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });
    expect(result.prepared).toBeUndefined();
    expect(result.blockers).toContain("文章正文不能为空。");
  });

  it.each([
    ["Source", "https://example.com/capitalized"],
    ["sourceUrl", "https://example.com/camel-case"]
  ])("accepts the legacy %s source field", async (field, expectedSourceUrl) => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-source-"));
    await writeFile(path.join(vault, "figure.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
${field}: ${expectedSourceUrl}
---
# 标题

![正文图](figure.png)
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const prepared = await pipeline.prepare({ path: "article.md" }, { author: "配置作者" });

    expect(prepared.metadata.sourceUrl).toBe(expectedSourceUrl);
    expect(prepared.images).toHaveLength(1);
    expect(prepared.cover.sourcePath).toBe("figure.png");
  });

  it("allows empty author and source but blocks publishing without a cover", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-required-"));
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
author: Frontmatter author
---
# 标题
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const result = await pipeline.preparePreview({ path: "article.md" }, { author: "" });

    expect(result.prepared).toBeUndefined();
    expect(result.blockers).toEqual(["文章正文不能为空。", "缺少可上传的公众号封面图片；请设置 frontmatter.cover 或在正文中插入本地图片。"]);
    expect(result.previewHtml).toContain("<body");
  });

  it("blocks a nonempty article with no cover or body image", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-no-cover-"));
    await writeFile(path.join(vault, "article.md"), "---\ntitle: 标题\n---\n正文内容。\n");

    const result = await new WeChatArticlePipeline(vault).preparePreview({ path: "article.md" }, { author: "" });
    expect(result.prepared).toBeUndefined();
    expect(result.blockers).toEqual(["缺少可上传的公众号封面图片；请设置 frontmatter.cover 或在正文中插入本地图片。"]);
  });

  it("treats a blank cover as unset and uses the first Obsidian body image", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-blank-cover-"));
    await writeFile(path.join(vault, "first.png"), PNG);
    await writeFile(path.join(vault, "second.png"), PNG);
    await writeFile(path.join(vault, "article.md"), "---\ntitle: 标题\ncover: '   '\n---\n正文。\n\n![[first.png|首图]]\n\n![第二张](second.png)\n");

    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "" });
    expect(prepared.cover.sourcePath).toBe("first.png");
    expect(prepared.cover.alt).toBe("首图");
  });

  it("blocks an invalid explicit cover instead of using the first body image", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-invalid-cover-"));
    await writeFile(path.join(vault, "first.png"), PNG);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
source: https://example.com/source
cover: missing.png
---
# 标题

![第一张图](first.png)
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const preview = await pipeline.preparePreview({ path: "article.md" }, { author: "配置作者" });
    expect(preview.prepared).toBeUndefined();
    expect(preview.blockers).toEqual(["公众号封面不可用：图片必须位于当前 Vault 且可访问：missing.png"]);
    expect(preview.imageCount).toBe(1);
    await expect(pipeline.prepare({ path: "article.md" }, { author: "配置作者" })).rejects.toMatchObject({
      issues: ["公众号封面不可用：图片必须位于当前 Vault 且可访问：missing.png"]
    });
  });

  it("always freezes WebP body images and covers as PNG", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-webp-"));
    await writeFile(path.join(vault, "cover.webp"), WEBP);
    await writeFile(path.join(vault, "figure.webp"), WEBP);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
source: https://example.com/source
cover: cover.webp
---
# 标题

![正文图](figure.webp)
`);
    const pipeline = new WeChatArticlePipeline(vault, 10 * 1024 * 1024, async () => ({ bytes: new Uint8Array(PNG), mimeType: "image/png" }));

    const prepared = await pipeline.prepare({ path: "article.md" }, { author: "配置作者" });

    expect(prepared.images.map(image => ({ mimeType: image.mimeType, fileName: image.fileName }))).toEqual([
      { mimeType: "image/png", fileName: "figure.png" }
    ]);
    expect({ mimeType: prepared.cover.mimeType, fileName: prepared.cover.fileName }).toEqual({ mimeType: "image/png", fileName: "cover.png" });
  });

  it("blocks article preparation when WebP transcoding fails", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-webp-failure-"));
    await writeFile(path.join(vault, "figure.webp"), WEBP);
    await writeFile(path.join(vault, "article.md"), `---
title: 标题
source: https://example.com/source
---
# 标题

![正文图](figure.webp)
`);
    const pipeline = new WeChatArticlePipeline(vault, 10 * 1024 * 1024, async () => { throw new Error("解码器拒绝该图片"); });

    const preview = await pipeline.preparePreview({ path: "article.md" }, { author: "配置作者" });
    expect(preview.prepared).toBeUndefined();
    expect(preview.blockers).toEqual(["公众号封面不可用：图片 WebP 转码失败：figure.webp（解码器拒绝该图片）"]);
    expect(preview.warnings).toEqual(["图片 WebP 转码失败：figure.webp（解码器拒绝该图片）"]);
    expect(preview.previewHtml).toContain("图片无法预览：正文图 · figure.webp");
    await expect(pipeline.prepare({ path: "article.md" }, { author: "配置作者" })).rejects.toMatchObject({
      issues: ["公众号封面不可用：图片 WebP 转码失败：figure.webp（解码器拒绝该图片）"]
    });
  });

  it("previews bare Obsidian image references from the configured attachment folder without editing the article", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachment-setting-"));
    await mkdir(path.join(vault, "raw", "assets"), { recursive: true });
    await mkdir(path.join(vault, "output"), { recursive: true });
    await writeFile(path.join(vault, "raw", "assets", "cover.png"), PNG);
    await writeFile(path.join(vault, "raw", "assets", "Pasted image.png"), PNG);
    const markdown = `---
title: 标题
source: https://example.com/source
cover: cover.png
---
# 标题

![[Pasted image.png|正文图]]
`;
    await writeFile(path.join(vault, "output", "article.md"), markdown);
    const resolver = createFileSystemAttachmentResolver(vault, "raw/assets");
    const pipeline = new WeChatArticlePipeline(vault, undefined, undefined, () => resolver);

    const prepared = await pipeline.prepare({ path: "output/article.md" }, { author: "配置作者" });

    expect(prepared.cover.sourcePath).toBe("raw/assets/cover.png");
    expect(prepared.images).toHaveLength(1);
    expect(prepared.images[0]?.sourcePath).toBe("raw/assets/Pasted image.png");
    expect(prepared.previewHtml).toContain("data:image/png;base64,");
    expect(await readFile(path.join(vault, "output", "article.md"), "utf8")).toBe(markdown);
  });
});
