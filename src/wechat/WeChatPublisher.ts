import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrozenImage, PreparedArticle } from "./WeChatArticlePipeline";
import { replaceAssetUrls } from "./WeChatArticlePipeline";

export interface SshAccount {
  host: string;
  user: string;
  port: number;
  privateKeyPath: string;
}

export interface WeChatAccount {
  alias: string;
  appId: string;
  appSecret: string;
  ssh: SshAccount;
  needOpenComment: 0 | 1;
  onlyFansCanComment: 0 | 1;
  forceRecreate?: boolean;
}

export interface DraftReceipt {
  status: "success" | "unknown" | "failed";
  accountAlias: string;
  mediaId?: string;
  sourceHash: string;
  imageCount: number;
  manualReviewUrl: string;
  createdAt: string;
  error?: string;
}

export interface WeChatSession {
  uploadArticleImage(image: FrozenImage): Promise<string>;
  uploadCover(image: FrozenImage): Promise<string>;
  addDraft(article: { title: string; summary: string; author: string; sourceUrl: string; html: string; coverMediaId: string; needOpenComment: 0 | 1; onlyFansCanComment: 0 | 1 }): Promise<string>;
  close(): Promise<void>;
}

export interface WeChatClient {
  open(account: WeChatAccount): Promise<WeChatSession>;
}

export class DuplicateDraftError extends Error {
  constructor(status: DraftReceipt["status"]) { super(status === "unknown" ? "上一次创建结果未知。请先在公众号后台核对，再显式选择“重新创建草稿”。" : "相同文章快照已经创建过草稿。请使用二级操作“重新创建草稿”。"); }
}

export class WeChatPublisher {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly vaultPath: string, private readonly client: WeChatClient) {}

  createDraft(prepared: PreparedArticle, account: WeChatAccount): Promise<DraftReceipt> {
    return this.serial(async () => {
      validateAccount(account);
      const existing = await readStoredDraftReceipt(this.vaultPath, prepared.sourcePath);
      if (existing?.sourceHash === prepared.sourceHash && existing.accountAlias === account.alias && (existing.status === "success" || existing.status === "unknown") && !account.forceRecreate) {
        throw new DuplicateDraftError(existing.status);
      }

      const startedAt = new Date().toISOString();
      await this.writeTaskLog(prepared, { status: "running", accountAlias: account.alias, startedAt });
      let session: WeChatSession | undefined;
      let draftAttempted = false;
      try {
        session = await this.client.open(account);
        const remoteUrls = new Map<string, string>();
        for (const image of prepared.images) remoteUrls.set(image.id, await session.uploadArticleImage(image));
        const coverMediaId = await session.uploadCover(prepared.cover);
        const html = replaceAssetUrls(prepared.html, prepared.images, image => remoteUrls.get(image.id) ?? "");
        draftAttempted = true;
        const mediaId = (await session.addDraft({
          ...prepared.metadata,
          html,
          coverMediaId,
          needOpenComment: account.needOpenComment,
          onlyFansCanComment: account.onlyFansCanComment
        })).trim();
        if (!mediaId) throw new UnknownDraftResultError("微信 draft/add 未返回 media_id。");
        const receipt: DraftReceipt = {
          status: "success", accountAlias: account.alias, mediaId, sourceHash: prepared.sourceHash,
          imageCount: prepared.images.length, manualReviewUrl: "https://mp.weixin.qq.com/", createdAt: new Date().toISOString()
        };
        await this.writeReceipt(prepared.sourcePath, receipt);
        await this.writeTaskLog(prepared, receipt);
        return receipt;
      } catch (error) {
        const receipt: DraftReceipt = {
          status: draftAttempted ? "unknown" : "failed",
          accountAlias: account.alias,
          sourceHash: prepared.sourceHash,
          imageCount: prepared.images.length,
          manualReviewUrl: "https://mp.weixin.qq.com/",
          createdAt: new Date().toISOString(),
          error: safeError(error, account)
        };
        await this.writeReceipt(prepared.sourcePath, receipt);
        await this.writeTaskLog(prepared, receipt);
        throw new Error(receipt.status === "unknown" ? `草稿创建结果未知：${receipt.error} 请先到公众号后台核对。` : `创建草稿失败：${receipt.error}`);
      } finally {
        await session?.close().catch(() => undefined);
      }
    });
  }

  private async writeReceipt(sourcePath: string, receipt: DraftReceipt): Promise<void> {
    await atomicJson(this.receiptPath(sourcePath), receipt);
  }

  private async writeTaskLog(prepared: PreparedArticle, value: object): Promise<void> {
    const directory = path.join(this.vaultPath, ".paperdian", "publishing");
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${prepared.sourceHash.slice(0, 12)}_${randomUUID()}.json`;
    await atomicJson(path.join(directory, name), { sourcePath: prepared.sourcePath, sourceHash: prepared.sourceHash, ...value });
  }

  private receiptPath(sourcePath: string): string {
    return receiptPath(this.vaultPath, sourcePath);
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

export async function readStoredDraftReceipt(vaultPath: string, sourcePath: string): Promise<DraftReceipt | undefined> {
  const source = path.resolve(vaultPath, sourcePath.replaceAll("/", path.sep));
  assertWithin(vaultPath, source);
  for (const filePath of [receiptPath(vaultPath, sourcePath), path.join(path.dirname(source), "wechat-draft-receipt.json")]) {
    try { return JSON.parse(await readFile(filePath, "utf8")) as DraftReceipt; }
    catch (error) { if (!isNodeError(error) || error.code !== "ENOENT") throw error; }
  }
  return undefined;
}

function receiptPath(vaultPath: string, sourcePath: string): string {
  const source = path.resolve(vaultPath, sourcePath.replaceAll("/", path.sep));
  assertWithin(vaultPath, source);
  const key = createHash("sha256").update(path.relative(path.resolve(vaultPath), source).replaceAll(path.sep, "/")).digest("hex");
  return path.join(vaultPath, ".paperdian", "publishing", "receipts", `${key}.json`);
}

class UnknownDraftResultError extends Error {}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", flag: "wx" });
  await rename(temporary, filePath);
}

function validateAccount(account: WeChatAccount): void {
  if (!account.alias || !account.appId || !account.appSecret) throw new Error("公众号账号配置不完整。");
  if ((account.needOpenComment !== 0 && account.needOpenComment !== 1) || (account.onlyFansCanComment !== 0 && account.onlyFansCanComment !== 1)) throw new Error("公众号评论配置无效。");
  if (!/^[a-zA-Z0-9._-]+$/.test(account.ssh.host)) throw new Error("SSH 主机名包含不允许的字符。");
  if (!/^[a-zA-Z0-9._-]+$/.test(account.ssh.user)) throw new Error("SSH 用户名包含不允许的字符。");
  if (!Number.isInteger(account.ssh.port) || account.ssh.port < 1 || account.ssh.port > 65535) throw new Error("SSH 端口无效。");
}

function safeError(error: unknown, account: WeChatAccount): string {
  let message = error instanceof Error ? error.message : String(error);
  const values = [account.appId, account.appSecret, account.ssh.host, account.ssh.user, account.ssh.privateKeyPath]
    .filter(Boolean).flatMap(value => [value, encodeURIComponent(value)]).sort((a, b) => b.length - a.length);
  for (const value of values) message = message.split(value).join("[REDACTED]");
  return message.replace(/(secret|access_token|appid)=[^\s&]+/gi, "$1=[REDACTED]").slice(0, 2_000);
}

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("发布路径超出当前 Vault。");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error; }
