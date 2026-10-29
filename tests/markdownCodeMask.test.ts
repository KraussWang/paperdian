import { describe, expect, it } from "vitest";
import { collectImageReferences } from "../src/attachments/AttachmentNormalizer";
import { replaceMarkdownImagesWithPlaceholders } from "../src/wechat/WechatMarkdownRenderer";

describe("Markdown image scanning", () => {
  it("leaves image syntax in fenced and inline code untouched", () => {
    const source = [
      "`![inline](https://example.com/inline.png)`",
      "```markdown",
      "![fenced](https://example.com/fenced.png)",
      "![[fenced.webp]]",
      "```",
      "![real](https://example.com/real.png)"
    ].join("\n");
    expect(collectImageReferences(source).map(reference => reference.target)).toEqual(["https://example.com/real.png"]);
    const replaced = replaceMarkdownImagesWithPlaceholders(source, "IMAGE_");
    expect(replaced.images.map(image => image.originalPath)).toEqual(["https://example.com/real.png"]);
    expect(replaced.markdown).toContain("![fenced](https://example.com/fenced.png)");
    expect(replaced.markdown).toContain("`![inline](https://example.com/inline.png)`");
  });
});
