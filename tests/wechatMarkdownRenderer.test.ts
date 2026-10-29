import { describe, expect, it } from "vitest";
import { renderMarkdownDocument, replaceMarkdownImagesWithPlaceholders } from "../src/wechat/WechatMarkdownRenderer";

describe("WeChat Markdown themes", () => {
  it("recognizes italic captions and a bold bibliography title in existing notes", async () => {
    const input = `![[figure.png|Fig. 1]]

*图 1：示例图注。*

![图 2](figure.png)

图 2：另一幅图。

正文。

*图 3：普通斜体段落。*

**论文信息**

- 英文题目：示例
- 期刊：*Nature*
`;
    const placeholders = replaceMarkdownImagesWithPlaceholders(input, "PAPER_READING_IMAGE_abcdef1234_");
    const document = await renderMarkdownDocument(placeholders.markdown, { theme: "teal" });
    expect(document.contentHtml.match(/class="paperdian-caption"/g)).toHaveLength(2);
    expect(document.html).toMatch(/class="paperdian-caption"[^>]*font-size: 13px[^>]*font-style: normal/);
    expect(document.html).toMatch(/<em style="font-style: normal;?">图 1/);
    expect(document.contentHtml).toContain("<p><em>图 3：普通斜体段落。</em></p>");
    expect(document.html).toMatch(/class="paperdian-paper-info paperdian-bibliography"[^>]*background: #e5f0f2/);
    expect(document.contentHtml).toContain("英文题目：示例");
  });
  it("styles only a numbered caption following a standalone image and a final bibliography", async () => {
    const document = await renderMarkdownDocument(`![image](figure.png)

图 1：说明 *文字*。

正文。

图 2：这是普通段落。

## 论文信息

- 题目：示例
- 期刊：Example
`, { theme: "teal" });
    expect(document.contentHtml.match(/class="paperdian-caption"/g)).toHaveLength(1);
    expect(document.contentHtml).toContain('<p>图 2：这是普通段落。</p>');
    expect(document.html).toMatch(/class="paperdian-paper-info paperdian-bibliography"[^>]*background: #e5f0f2/);
    expect(document.html).toContain("题目：示例");

    const nonFinal = await renderMarkdownDocument("## 论文信息\n\n- 题目：示例\n\n## 后续\n\n正文", { theme: "teal" });
    expect(nonFinal.contentHtml).not.toContain("paperdian-bibliography");
  });
  it("rejects unsupported theme identifiers", async () => {
    await expect(renderMarkdownDocument("# 标题", { theme: "sepia" as never })).rejects.toThrow("不支持的公众号主题：sepia");
  });

  it("dispatches default and dark-blue to distinct style systems", async () => {
    const markdown = "# 标题\n\n## 小节\n\n- 指标";
    const defaultDocument = await renderMarkdownDocument(markdown, { theme: "default" });
    const darkBlueDocument = await renderMarkdownDocument(markdown, { theme: "dark-blue" });

    expect(defaultDocument.html).toContain("border-left: 4px solid #0f4c81");
    expect(darkBlueDocument.html).toContain("border-bottom: 2px solid #173f7a");
    expect(darkBlueDocument.html).toContain("color: #a84317");
    expect(darkBlueDocument.html).toContain('color: #3f3f3f; background: #ffffff');
    expect(darkBlueDocument.html).toContain('color: #3f3f3f; font-family: -apple-system');
  });

  it("renders canonical paper information when the clipped note does not provide a DOI", async () => {
    const markdown = `---
title: "Nature: 本地精读"
source: https://example.com/reference-only
published: 2026
---

<small>
论文题目：Local paper<br>
第一作者：First Author<br>
通讯作者：文中未明确说明<br>
通讯单位：文中未明确说明<br>
DOI：文中未明确说明
</small>

正文。`;

    const document = await renderMarkdownDocument(markdown);

    expect(document.contentHtml).toContain('class="paperdian-paper-info"');
    expect(document.contentHtml).toContain("DOI：文中未明确说明");
    expect(document.contentHtml).not.toContain("&lt;small&gt;");
  });

  it("keeps plain inline subscripts inside their paragraph while escaping other HTML", async () => {
    const document = await renderMarkdownDocument("H<sub>2</sub> 与 (NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>；<sub class=\"bad\">X</sub>；<script>alert(1)</script>");

    expect(document.contentHtml).toContain("<p>H<sub>2</sub> 与 (NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>；");
    expect(document.contentHtml).not.toContain("&lt;sub&gt;");
    expect(document.contentHtml).toContain("&lt;sub class=&quot;bad&quot;&gt;X&lt;/sub&gt;");
    expect(document.contentHtml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(document.contentHtml).not.toContain("<p><sub>");
  });
});
