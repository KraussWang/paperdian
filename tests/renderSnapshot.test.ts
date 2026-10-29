import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WeChatArticlePipeline } from "../src/wechat/WeChatArticlePipeline";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("WeChat article HTML", () => {
  it("matches the reviewed default/blue publishing snapshot", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-render-snapshot-"));
    await mkdir(path.join(vault, "article", "figures"), { recursive: true });
    await writeFile(path.join(vault, "article", "cover.png"), PNG);
    await writeFile(path.join(vault, "article", "figures", "plot.png"), PNG);
    await writeFile(path.join(vault, "article", "paper.md"), `---
title: Al₁₋ₓScₓN 渲染验收
summary: 验证公众号最终 HTML
author: Paper Reading
sourceUrl: https://doi.org/10.1000/example
cover: cover.png
---
# Al₁₋ₓScₓN 渲染验收

这是包含 **粗体**、*斜体* 与 [来源链接](https://example.com) 的正文，保留 x² 和 Al₁₋ₓScₓN。

> 一条需要保留样式的引用。

行内公式 $E=mc^2$，以及：

$$\\alpha + \\beta = \\gamma$$

| 项目 | 结果 |
| --- | ---: |
| 样品 A | 42 |

\`\`\`python
print("paperdian")
\`\`\`

![图 1：结果](figures/plot.png)
`);
    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article/paper.md" }, { theme: "default", color: "blue", author: "Paper Reading" });

    await expect(prepared.html).toMatchFileSnapshot("./snapshots/wechat-default-blue.html");
  });

  it("matches the reviewed dark-blue publishing snapshot and separates its draft hash", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-dark-blue-snapshot-"));
    await mkdir(path.join(vault, "article", "figures"), { recursive: true });
    await writeFile(path.join(vault, "article", "figures", "plot.png"), PNG);
    const sourcePath = path.join(vault, "article", "paper.md");
    await writeFile(sourcePath, `---
title: 数据复盘渲染验收
summary: 验证深蓝色公众号主题
author: Paper Reading
sourceUrl: https://doi.org/10.1000/example
---
# 数据复盘渲染验收

这是包含 **关键结论**、*补充说明* 与 [数据来源](https://example.com) 的正文。

## 核心指标

### 分组表现

- 收入同比增长
- 成本环比下降

1. 核对口径
2. 复盘异常

> 数据说明需要和正文清晰区分。

行内公式 $E=mc^2$，以及：

$$\\alpha + \\beta = \\gamma$$

| 项目 | 结果 |
| --- | ---: |
| 样品 A | 42 |

\`\`\`python
print("paperdian")
\`\`\`

![图 1：结果](figures/plot.png)
`);
    const pipeline = new WeChatArticlePipeline(vault);

    const defaultPrepared = await pipeline.prepare({ path: "article/paper.md" }, { theme: "default", color: "blue", author: "Paper Reading" });
    const darkBluePrepared = await pipeline.prepare({ path: "article/paper.md" }, { theme: "dark-blue", color: "blue", author: "Paper Reading" });
    const source = await readFile(sourcePath, "utf8");
    const imageHash = createHash("sha256").update(PNG).digest("hex");
    const legacyDefaultHash = createHash("sha256").update(source).update(imageHash).update(imageHash).digest("hex");

    expect(defaultPrepared.sourceHash).toBe(legacyDefaultHash);
    expect(darkBluePrepared.sourceHash).not.toBe(defaultPrepared.sourceHash);
    expect(darkBluePrepared.theme).toEqual({ name: "dark-blue", color: "blue" });
    expect(darkBluePrepared.html).toContain('color: #3f3f3f; font-size: 15px');
    expect(darkBluePrepared.html).toContain('color: #3f3f3f; font-family: -apple-system');
    await expect(darkBluePrepared.html).toMatchFileSnapshot("./snapshots/wechat-dark-blue.html");
  });
});
