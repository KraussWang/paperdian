import { describe, expect, it } from "vitest";
import type { PreparedArticle } from "../src/wechat/WeChatArticlePipeline";
import type { DraftReceipt } from "../src/wechat/WeChatPublisher";
import { ArticlePublicationController } from "../src/workflows/ArticlePublicationController";

const prepared = {
  sourcePath: "papers/article.md",
  sourceHash: "abcdef0123456789",
  previewHtml: "<article>preview</article>",
  images: []
} as unknown as PreparedArticle;

const successfulReceipt: DraftReceipt = {
  status: "success",
  accountAlias: "lab",
  sourceHash: prepared.sourceHash,
  imageCount: 0,
  manualReviewUrl: "https://mp.weixin.qq.com/",
  createdAt: "2026-01-01T00:00:00.000Z",
  mediaId: "media-1"
};

describe("ArticlePublicationController", () => {
  it("keeps a clean preview publishable and passes the canonical preview options", async () => {
    const calls: unknown[][] = [];
    const controller = new ArticlePublicationController({
      preparePreview: async (...args) => {
        calls.push(args);
        return { previewHtml: prepared.previewHtml, prepared, blockers: [], imageCount: 0 };
      },
      getDraftReceipt: async () => undefined,
      publish: async () => successfulReceipt
    });

    const result = await controller.prepare({ sourcePath: "papers/article.md", author: "Research team", theme: "dark-blue" });

    expect(calls).toEqual([[{ path: "papers/article.md" }, { theme: "dark-blue", color: "blue", author: "Research team" }]]);
    expect(result).toMatchObject({ kind: "ready", publishDisabled: false, recreateEnabled: false, receipt: undefined });
  });

  it("keeps a draft with broken body images publishable and surfaces warnings", async () => {
    const warnings = ["图片必须位于当前 Vault 且可访问：missing.png"];
    const controller = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: "<span>图片无法预览</span>", prepared, blockers: [], imageCount: 1, warnings }),
      getDraftReceipt: async () => undefined,
      publish: async () => successfulReceipt
    });

    const result = await controller.prepare({ sourcePath: "papers/article.md", author: "", theme: "default" });
    expect(result).toMatchObject({ kind: "ready", publishDisabled: false, warnings });
  });

  it("returns preview blockers without looking up or publishing a draft", async () => {
    let receiptLookups = 0;
    const controller = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: "<article>blocked</article>", blockers: ["missing title"], imageCount: 1 }),
      getDraftReceipt: async () => {
        receiptLookups += 1;
        return undefined;
      },
      publish: async () => successfulReceipt
    });

    await expect(controller.prepare({ sourcePath: "papers/article.md", author: "Research team", theme: "default" })).resolves.toEqual({
      kind: "blocked",
      previewHtml: "<article>blocked</article>",
      blockers: ["missing title"],
      imageCount: 1
    });
    expect(receiptLookups).toBe(0);
  });

  it("treats an unknown existing draft as a duplicate and returns preparation failures as data", async () => {
    const unknownReceipt = { ...successfulReceipt, status: "unknown" as const };
    const duplicateController = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: prepared.previewHtml, prepared, blockers: [], imageCount: 0 }),
      getDraftReceipt: async () => unknownReceipt,
      publish: async () => successfulReceipt
    });
    const failingController = new ArticlePublicationController({
      preparePreview: async () => { throw new Error("preview unavailable"); },
      getDraftReceipt: async () => undefined,
      publish: async () => successfulReceipt
    });

    await expect(duplicateController.prepare({ sourcePath: "papers/article.md", author: "Research team", theme: "default" })).resolves.toMatchObject({
      kind: "ready",
      receipt: unknownReceipt,
      publishDisabled: true,
      recreateEnabled: true
    });
    await expect(failingController.prepare({ sourcePath: "papers/article.md", author: "Research team", theme: "default" })).resolves.toMatchObject({
      kind: "error",
      error: { message: "preview unavailable" }
    });
  });

  it("returns a publish-ready preview and blocks duplicate publication behind recreate", async () => {
    const controller = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: prepared.previewHtml, prepared, blockers: [], imageCount: 0 }),
      getDraftReceipt: async () => successfulReceipt,
      publish: async () => successfulReceipt
    });

    const result = await controller.prepare({ sourcePath: "papers/article.md", author: "Research team", theme: "default" });

    expect(result).toEqual({
      kind: "ready",
      prepared,
      previewHtml: "<article>preview</article>",
      imageCount: 0,
      receipt: successfulReceipt,
      publishDisabled: true,
      recreateEnabled: true
    });
  });

  it("preserves the recreate path when publication fails", async () => {
    const controller = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: prepared.previewHtml, prepared, blockers: [], imageCount: 0 }),
      getDraftReceipt: async () => undefined,
      publish: async () => { throw new Error("network unavailable"); }
    });

    const result = await controller.publish(prepared, false);

    expect(result).toMatchObject({
      kind: "error",
      error: { message: "network unavailable" },
      publishDisabled: true,
      recreateEnabled: true
    });
  });

  it("publishes the prepared article with the requested recreation mode", async () => {
    const calls: Array<[PreparedArticle, boolean]> = [];
    const controller = new ArticlePublicationController({
      preparePreview: async () => ({ previewHtml: prepared.previewHtml, prepared, blockers: [], imageCount: 0 }),
      getDraftReceipt: async () => undefined,
      publish: async (article, forceRecreate) => {
        calls.push([article, forceRecreate]);
        return successfulReceipt;
      }
    });

    await expect(controller.publish(prepared, true)).resolves.toEqual({
      kind: "published",
      receipt: successfulReceipt,
      publishDisabled: true,
      recreateEnabled: true
    });
    expect(calls).toEqual([[prepared, true]]);
  });
});
