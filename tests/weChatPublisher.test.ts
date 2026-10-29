import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DuplicateDraftError, readStoredDraftReceipt, WeChatPublisher, type WeChatClient, type WeChatSession } from "../src/wechat/WeChatPublisher";
import { WeChatArticlePipeline, type PreparedArticle } from "../src/wechat/WeChatArticlePipeline";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("WeChatPublisher", () => {
  it("redacts account credentials and SSH details before persisting a failed receipt", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-redaction-"));
    const account = {
      alias: "main", appId: "fixture-app-id", appSecret: "fixture-secret", needOpenComment: 0 as const, onlyFansCanComment: 0 as const,
      ssh: { host: "jump.example", user: "fixture-user", port: 22, privateKeyPath: "C:/fixture key" }
    };
    const sensitive = [account.appId, account.appSecret, account.ssh.host, account.ssh.user, account.ssh.privateKeyPath];
    const client: WeChatClient = { async open() {
      throw new Error([...sensitive, ...sensitive.map(value => encodeURIComponent(value)), "access_token=fixture-token"].join(" "));
    } };
    const prepared = fixturePrepared();
    await expect(new WeChatPublisher(vault, client).createDraft(prepared, account)).rejects.toThrow("创建草稿失败");
    const receipt = await readStoredDraftReceipt(vault, prepared.sourcePath);
    const directory = path.join(vault, ".paperdian", "publishing");
    const logs = await Promise.all((await readdir(directory)).filter(file => file.endsWith(".json")).map(file => readFile(path.join(directory, file), "utf8")));
    const persisted = [JSON.stringify(receipt), ...logs].join("\n");
    for (const value of [...sensitive, ...sensitive.map(value => encodeURIComponent(value)), "fixture-token"]) expect(persisted).not.toContain(value);
  });

  it("sends only styled article content with inline subscripts and no leading blank paragraph", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-draft-content-"));
    await writeFile(path.join(vault, "cover.png"), PNG);
    await writeFile(path.join(vault, "article.md"), "---\ntitle: 标题\ncover: cover.png\n---\n# 标题\n\nH<sub>2</sub> 与 (NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>。\n\n![图片](cover.png)\n");
    const prepared = await new WeChatArticlePipeline(vault).prepare({ path: "article.md" }, { author: "", theme: "default" });
    let uploadedHtml = "";
    const client: WeChatClient = {
      async open() {
        return {
          async uploadArticleImage() { return "https://mmbiz.example/image"; },
          async uploadCover() { return "cover-media"; },
          async addDraft(article) { uploadedHtml = article.html; return "draft-media"; },
          async close() {}
        };
      }
    };
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    await new WeChatPublisher(vault, client).createDraft(prepared, account);

    expect(prepared.previewHtml).toContain("<!doctype html>");
    expect(prepared.previewHtml).toContain("H<sub>2</sub>");
    expect(uploadedHtml).toMatch(/^<div id="output"[^>]*><section class="container"[^>]*><p\b/);
    expect(uploadedHtml).toContain("H<sub>2</sub> 与 (NH<sub>4</sub>)<sub>2</sub>SO<sub>4</sub>。");
    expect(uploadedHtml).toContain("https://mmbiz.example/image");
    expect(uploadedHtml).not.toMatch(/<!doctype|<html\b|<head\b|<body\b|<p[^>]*>\s*(?:<br\s*\/?\s*>)?\s*<\/p>\s*<p/);
    expect(uploadedHtml).not.toMatch(/^\s/);
  });

  it("uploads body images, cover, then creates one draft and prevents duplicates", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-publish-"));
    await mkdir(path.join(vault, "article"));
    const calls: string[] = [];
    let draftArticle: Parameters<WeChatSession["addDraft"]>[0] | undefined;
    const client: WeChatClient = {
      async open() {
        calls.push("token");
        return {
          async uploadArticleImage() { calls.push("body"); return "https://mmbiz.example/image"; },
          async uploadCover() { calls.push("cover"); return "cover-media"; },
          async addDraft(article) { calls.push("draft"); draftArticle = article; return "draft-media"; },
          async close() { calls.push("close"); }
        };
      }
    };
    const publisher = new WeChatPublisher(vault, client);
    const prepared = fixturePrepared();
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    const receipt = await publisher.createDraft(prepared, account);

    expect(calls).toEqual(["token", "body", "cover", "draft", "close"]);
    expect(draftArticle).toMatchObject({ title: "标题", summary: "", author: "配置作者", sourceUrl: "https://example.com/source", needOpenComment: 1, onlyFansCanComment: 0 });
    expect(receipt).toMatchObject({ status: "success", mediaId: "draft-media", imageCount: 1, sourceHash: "a".repeat(64) });
    const logNames = await readdir(path.join(vault, ".paperdian", "publishing"));
    const persisted = [JSON.stringify(await readStoredDraftReceipt(vault, prepared.sourcePath)), ...await Promise.all(logNames.filter(name => name.endsWith(".json")).map(name => readFile(path.join(vault, ".paperdian", "publishing", name), "utf8")))].join("\n");
    expect(persisted).not.toContain("secret");
    await expect(publisher.createDraft(prepared, account)).rejects.toBeInstanceOf(DuplicateDraftError);
  });

  it("records an unknown draft result and blocks an automatic retry", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-unknown-"));
    await mkdir(path.join(vault, "article"));
    const client: WeChatClient = {
      async open() {
        return {
          async uploadArticleImage() { return "https://mmbiz.example/image"; },
          async uploadCover() { return "cover-media"; },
          async addDraft() { throw new Error("connection reset"); },
          async close() {}
        };
      }
    };
    const publisher = new WeChatPublisher(vault, client);
    const prepared = fixturePrepared();
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    await expect(publisher.createDraft(prepared, account)).rejects.toThrow("结果未知");
    const receipt = await readStoredDraftReceipt(vault, prepared.sourcePath);
    expect(receipt?.status).toBe("unknown");
    await expect(publisher.createDraft(prepared, account)).rejects.toBeInstanceOf(DuplicateDraftError);
  });

  it("marks a blank media ID unknown and permits an explicit recreate", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-recreate-"));
    await mkdir(path.join(vault, "article"));
    let attempts = 0;
    const client: WeChatClient = {
      async open() {
        return {
          async uploadArticleImage() { return "https://mmbiz.example/image"; },
          async uploadCover() { return "cover-media"; },
          async addDraft() { attempts += 1; return attempts === 1 ? "  " : "new-draft"; },
          async close() {}
        };
      }
    };
    const publisher = new WeChatPublisher(vault, client);
    const prepared = fixturePrepared();
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    await expect(publisher.createDraft(prepared, account)).rejects.toThrow("结果未知");
    await expect(publisher.createDraft(prepared, account)).rejects.toBeInstanceOf(DuplicateDraftError);
    await expect(publisher.createDraft(prepared, { ...account, forceRecreate: true })).resolves.toMatchObject({ status: "success", mediaId: "new-draft" });
    expect(attempts).toBe(2);
  });

  it("records a retryable failure before a draft attempt and closes its session", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-retryable-"));
    await mkdir(path.join(vault, "article"));
    let closed = 0;
    const client: WeChatClient = {
      async open() {
        return {
          async uploadArticleImage() { throw new Error("upload failed"); },
          async uploadCover() { return "cover"; },
          async addDraft() { return "unused"; },
          async close() { closed += 1; }
        };
      }
    };
    const publisher = new WeChatPublisher(vault, client);
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    await expect(publisher.createDraft(fixturePrepared(), account)).rejects.toThrow("创建草稿失败：upload failed");
    expect(closed).toBe(1);
    const receipt = await readStoredDraftReceipt(vault, "article/paper.md");
    expect(receipt?.status).toBe("failed");
  });

  it("keeps independent receipts for two articles in the same directory", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-two-drafts-"));
    let attempts = 0;
    const client: WeChatClient = {
      async open() {
        return {
          async uploadArticleImage() { return "https://mmbiz.example/image"; },
          async uploadCover() { return "cover"; },
          async addDraft() { attempts += 1; return `draft-${attempts}`; },
          async close() {}
        };
      }
    };
    const publisher = new WeChatPublisher(vault, client);
    const first = fixturePrepared();
    const second = { ...fixturePrepared(), sourcePath: "article/other.md", sourceHash: "c".repeat(64) };
    const account = { alias: "main", appId: "app", appSecret: "secret", needOpenComment: 1 as const, onlyFansCanComment: 0 as const, ssh: { host: "host", user: "user", port: 22, privateKeyPath: "C:/key" } };

    await publisher.createDraft(first, account);
    await publisher.createDraft(second, account);
    expect((await readStoredDraftReceipt(vault, first.sourcePath))?.mediaId).toBe("draft-1");
    expect((await readStoredDraftReceipt(vault, second.sourcePath))?.mediaId).toBe("draft-2");
    await expect(publisher.createDraft(first, account)).rejects.toBeInstanceOf(DuplicateDraftError);
    expect(attempts).toBe(2);
  });
});

function fixturePrepared(): PreparedArticle {
  const image = { id: "body-1", sourcePath: "article/a.png", fileName: "a.png", mimeType: "image/png" as const, hash: "b".repeat(64), bytes: new Uint8Array([1]), alt: "a" };
  return {
    sourcePath: "article/paper.md", sourceHash: "a".repeat(64), metadata: { title: "标题", summary: "", author: "配置作者", sourceUrl: "https://example.com/source" },
    html: '<img src="paperdian-asset://body-1">', previewHtml: "", cover: { ...image, id: "cover" }, images: [image], theme: { name: "default", color: "blue" }, generatedAt: "2026-01-01T00:00:00.000Z"
  };
}
