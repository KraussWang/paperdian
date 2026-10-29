import type { FrozenImage } from "./WeChatArticlePipeline";
import type { SocksHttpsResponse, SocksHttpsTransport } from "./SocksHttpsTransport";

export const WECHAT_API_TARGET = { host: "api.weixin.qq.com", port: 443 };

export interface WeChatDraftArticle {
  title: string;
  summary: string;
  author: string;
  sourceUrl: string;
  html: string;
  coverMediaId: string;
  needOpenComment: 0 | 1;
  onlyFansCanComment: 0 | 1;
}

export interface WeChatApi {
  getAccessToken(appId: string, appSecret: string): Promise<string>;
  uploadArticleImage(token: string, image: FrozenImage): Promise<string>;
  uploadCover(token: string, image: FrozenImage): Promise<string>;
  addDraft(token: string, article: WeChatDraftArticle): Promise<string>;
}

export class WeChatApiClient implements WeChatApi {
  constructor(private readonly socksPort: number, private readonly transport: SocksHttpsTransport) {}

  async getAccessToken(appId: string, appSecret: string): Promise<string> {
    const query = new URLSearchParams({ grant_type: "client_credential", appid: appId, secret: appSecret });
    const result = await this.jsonRequest("GET", `/cgi-bin/token?${query.toString()}`);
    const token = stringField(result, "access_token");
    if (!token) throw apiError("获取 access token 失败", result);
    return token;
  }

  async uploadArticleImage(token: string, image: FrozenImage): Promise<string> {
    const result = await this.multipartRequest(`/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`, image);
    const url = stringField(result, "url");
    if (!url) throw apiError("上传正文图片失败", result);
    return url;
  }

  async uploadCover(token: string, image: FrozenImage): Promise<string> {
    const result = await this.multipartRequest(`/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`, image);
    const mediaId = stringField(result, "media_id");
    if (!mediaId) throw apiError("上传封面失败", result);
    return mediaId;
  }

  async addDraft(token: string, article: WeChatDraftArticle): Promise<string> {
    const result = await this.jsonRequest("POST", `/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`, buildWeChatDraftPayload(article));
    const mediaId = stringField(result, "media_id");
    if (!mediaId) throw apiError("创建草稿失败", result);
    return mediaId;
  }

  private async multipartRequest(apiPath: string, image: FrozenImage): Promise<Record<string, unknown>> {
    const boundary = `paperdian-${Date.now().toString(16)}`;
    const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="${safeFileName(image.fileName)}"\r\nContent-Type: ${image.mimeType}\r\n\r\n`);
    const body = Buffer.concat([header, Buffer.from(image.bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    return this.jsonRequest("POST", apiPath, body, { "Content-Type": `multipart/form-data; boundary=${boundary}` });
  }

  private async jsonRequest(method: string, path: string, body?: object | Buffer, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8");
    const response = await this.transport.request(this.socksPort, {
      method,
      path,
      headers: {
        ...(payload && !Buffer.isBuffer(body) ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        ...(payload ? { "Content-Length": String(payload.length) } : {}),
        ...extraHeaders
      },
      body: payload,
      target: WECHAT_API_TARGET
    });
    return parseWeChatApiResponse(response);
  }
}

export function parseWeChatApiResponse(response: SocksHttpsResponse): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); }
  catch {
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`微信接口返回 HTTP ${response.statusCode}。`);
    throw new Error("微信接口返回了无效 JSON。");
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (isRecord(parsed) && (parsed.errcode !== undefined || parsed.errmsg !== undefined)) throw apiError(`微信接口返回 HTTP ${response.statusCode}`, parsed);
    throw new Error(`微信接口返回 HTTP ${response.statusCode}。`);
  }
  if (!isRecord(parsed)) throw new Error("微信接口返回格式无效。");
  if (typeof parsed.errcode === "number" && parsed.errcode !== 0) throw apiError("微信接口错误", parsed);
  return parsed;
}

export function buildWeChatDraftPayload(article: WeChatDraftArticle): {
  articles: Array<{ title: string; author: string; digest: string; content: string; content_source_url: string; thumb_media_id: string; need_open_comment: number; only_fans_can_comment: number }>;
} {
  return { articles: [{ title: article.title, author: article.author, digest: article.summary, content: article.html, content_source_url: article.sourceUrl, thumb_media_id: article.coverMediaId, need_open_comment: article.needOpenComment, only_fans_can_comment: article.onlyFansCanComment }] };
}

function safeFileName(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }
function stringField(value: Record<string, unknown>, key: string): string { return typeof value[key] === "string" ? value[key] : ""; }
function apiError(prefix: string, response: Record<string, unknown>): Error {
  // Remote error text may echo an AppID, token or server address. Keep only a numeric code.
  const code = typeof response.errcode === "number" && Number.isSafeInteger(response.errcode) ? String(response.errcode) : "unknown";
  return new Error(`${prefix}（errcode=${code}）。请检查公众号凭据、权限和 API 白名单。`);
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
