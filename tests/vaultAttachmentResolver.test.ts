import { describe, expect, it } from "vitest";
import { VaultAttachmentResolver, readAttachmentFolderPath } from "../src/attachments/VaultAttachmentResolver";

describe("VaultAttachmentResolver", () => {
  it.each([
    ["/", "output/article.md", "root.png", "root.png"],
    ["./", "notes/article.md", "same.png", "notes/same.png"],
    ["raw/assets", "output/article.md", "Pasted image.png", "raw/assets/Pasted image.png"],
    ["./assets", "notes/article.md", "local.png", "notes/assets/local.png"]
  ])("resolves attachmentFolderPath %s", async (attachmentFolderPath, sourcePath, reference, expected) => {
    const files = new Set([expected]);
    const resolver = new VaultAttachmentResolver({ attachmentFolderPath, fileExists: filePath => files.has(filePath) });

    await expect(resolver.resolve(reference, sourcePath)).resolves.toBe(expected);
  });

  it("prefers explicit note-relative paths before configured attachments and preserves safe canonical paths", async () => {
    const files = new Set(["output/image.png", "raw/assets/image.png", "raw/assets/中文 图片.png"]);
    const resolver = new VaultAttachmentResolver({ attachmentFolderPath: "raw/assets", fileExists: filePath => files.has(filePath) });

    await expect(resolver.resolve("image.png", "output/article.md")).resolves.toBe("output/image.png");
    await expect(resolver.resolve("../raw/assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png#preview", "output/article.md"))
      .resolves.toBe("raw/assets/中文 图片.png");
    expect(resolver.relativePath("output/article.md", "raw/assets/中文 图片.png")).toBe("../raw/assets/%E4%B8%AD%E6%96%87%20%E5%9B%BE%E7%89%87.png");
  });

  it("uses Obsidian link metadata after path candidates", async () => {
    const resolver = new VaultAttachmentResolver({
      attachmentFolderPath: "missing",
      fileExists: filePath => filePath === "archive/figure.png",
      resolveLinkpath: (linkpath, sourcePath) => linkpath === "figure.png" && sourcePath === "output/article.md" ? "archive/figure.png" : undefined
    });

    await expect(resolver.resolve("figure.png", "output/article.md")).resolves.toBe("archive/figure.png");
  });

  it("rejects traversal and invalid configured paths", async () => {
    const resolver = new VaultAttachmentResolver({ attachmentFolderPath: "../outside", fileExists: () => false });

    await expect(resolver.resolve("../../secret.png", "output/article.md")).rejects.toThrow("附件路径超出当前 Vault");
    expect(resolver.destinationPath("download.png", "output/article.md")).toBe("output/download.png");
  });
});

describe("readAttachmentFolderPath", () => {
  it("reads app.json through the Vault config directory", async () => {
    const requested: string[] = [];
    const value = await readAttachmentFolderPath({
      configDir: ".settings",
      adapter: { read: async filePath => { requested.push(filePath); return JSON.stringify({ attachmentFolderPath: "raw/assets" }); } }
    });

    expect(requested).toEqual([".settings/app.json"]);
    expect(value).toBe("raw/assets");
  });

  it.each(["not json", JSON.stringify({}), JSON.stringify({ attachmentFolderPath: "C:/outside" })])("falls back for missing or invalid config: %s", async raw => {
    await expect(readAttachmentFolderPath({ configDir: ".obsidian", adapter: { read: async () => raw } })).resolves.toBeUndefined();
  });
});
