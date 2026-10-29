import type { ArticlePreviewResult, ArticleSourceFile, PreparedArticle } from "../wechat/WeChatArticlePipeline";
import type { DraftReceipt } from "../wechat/WeChatPublisher";
import type { WeChatThemeName } from "../wechat/wechatThemes";

export interface ArticlePublicationDependencies {
  preparePreview(file: ArticleSourceFile, options: { theme: WeChatThemeName; color: "blue"; author: string }): Promise<ArticlePreviewResult>;
  getDraftReceipt(prepared: PreparedArticle): Promise<DraftReceipt | undefined>;
  publish(prepared: PreparedArticle, forceRecreate: boolean): Promise<DraftReceipt>;
}

export type ArticlePreparation =
  | { kind: "blocked"; previewHtml: string; blockers: string[]; imageCount: number; warnings?: string[] }
  | { kind: "ready"; prepared: PreparedArticle; previewHtml: string; imageCount: number; warnings?: string[]; receipt?: DraftReceipt; publishDisabled: boolean; recreateEnabled: boolean }
  | { kind: "error"; error: Error };

export type ArticlePublication =
  | { kind: "published"; receipt: DraftReceipt; publishDisabled: true; recreateEnabled: true }
  | { kind: "error"; error: Error; publishDisabled: true; recreateEnabled: true };

export class ArticlePublicationController {
  constructor(private readonly dependencies: ArticlePublicationDependencies) {}

  async prepare(input: { sourcePath: string; author: string; theme: WeChatThemeName }): Promise<ArticlePreparation> {
    try {
      const result = await this.dependencies.preparePreview({ path: input.sourcePath }, {
        theme: input.theme,
        color: "blue",
        author: input.author
      });
      const warnings = result.warnings?.length ? { warnings: result.warnings } : {};
      if (!result.prepared) return { kind: "blocked", previewHtml: result.previewHtml, blockers: result.blockers, imageCount: result.imageCount, ...warnings };
      const receipt = await this.dependencies.getDraftReceipt(result.prepared);
      const isDuplicate = receipt?.status === "success" || receipt?.status === "unknown";
      return {
        kind: "ready",
        prepared: result.prepared,
        previewHtml: result.previewHtml,
        imageCount: result.imageCount,
        ...warnings,
        receipt,
        publishDisabled: isDuplicate,
        recreateEnabled: isDuplicate
      };
    } catch (error) {
      return { kind: "error", error: asError(error) };
    }
  }

  async publish(prepared: PreparedArticle, forceRecreate: boolean): Promise<ArticlePublication> {
    try {
      const receipt = await this.dependencies.publish(prepared, forceRecreate);
      return { kind: "published", receipt, publishDisabled: true, recreateEnabled: true };
    } catch (error) {
      return { kind: "error", error: asError(error), publishDisabled: true, recreateEnabled: true };
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
