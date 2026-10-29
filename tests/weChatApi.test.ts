import { describe, expect, it, vi } from "vitest";
import type { SocksHttpsRequest, SocksHttpsTransport } from "../src/wechat/SocksHttpsTransport";
import { WeChatApiClient, parseWeChatApiResponse } from "../src/wechat/WeChatApi";

describe("WeChat API protocol", () => {
  it("does not expose reflected credentials or addresses in remote error responses", () => {
    const response = { statusCode: 200, body: JSON.stringify({ errcode: 40013, errmsg: "fixture-private-app fixture-private-secret 203.0.113.8" }) };
    let message = "";
    try { parseWeChatApiResponse(response); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("errcode=40013");
    expect(message).not.toContain("fixture-private");
    expect(message).not.toContain("203.0.113.8");
  });

  it("maps token requests to the API transport without owning the network", async () => {
    const request = vi.fn().mockResolvedValue({ statusCode: 200, body: '{"access_token":"token"}' });
    const api = new WeChatApiClient(1081, { request } satisfies SocksHttpsTransport);

    await expect(api.getAccessToken("app id", "secret")).resolves.toBe("token");
    expect(request).toHaveBeenCalledWith(1081, expect.objectContaining({
      method: "GET",
      path: "/cgi-bin/token?grant_type=client_credential&appid=app+id&secret=secret",
      headers: {},
      body: undefined,
      target: { host: "api.weixin.qq.com", port: 443 }
    }));
  });

  it("serializes drafts as JSON with a matching content length", async () => {
    const sentRequests: SocksHttpsRequest[] = [];
    const api = new WeChatApiClient(1081, { request: async (_port, request) => {
      sentRequests.push(request);
      return { statusCode: 200, body: '{"media_id":"draft-id"}' };
    } });
    const article = { title: "Title", summary: "Summary", author: "Author", sourceUrl: "https://example.com", html: "<p>Body</p>", coverMediaId: "cover", needOpenComment: 1 as const, onlyFansCanComment: 0 as const };

    await expect(api.addDraft("token value", article)).resolves.toBe("draft-id");

    const [sent] = sentRequests;
    if (!sent?.body) throw new Error("Expected a draft request body.");
    expect(sent).toMatchObject({
      method: "POST",
      path: "/cgi-bin/draft/add?access_token=token%20value",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      target: { host: "api.weixin.qq.com", port: 443 }
    });
    expect(sent.body.toString("utf8")).toBe(JSON.stringify({
      articles: [{ title: "Title", author: "Author", digest: "Summary", content: "<p>Body</p>", content_source_url: "https://example.com", thumb_media_id: "cover", need_open_comment: 1, only_fans_can_comment: 0 }]
    }));
    expect(sent.headers["Content-Length"]).toBe(String(sent.body.length));
  });

  it("encodes image uploads as multipart data and sanitizes their filename", async () => {
    const sentRequests: SocksHttpsRequest[] = [];
    const api = new WeChatApiClient(1081, { request: async (_port, request) => {
      sentRequests.push(request);
      return { statusCode: 200, body: '{"url":"https://cdn.example/image"}' };
    } });
    const image = { id: "id", sourcePath: "ignored", fileName: "unsafe name?.png", mimeType: "image/png" as const, hash: "hash", bytes: new Uint8Array([1, 2, 3]) };

    await expect(api.uploadArticleImage("token value", image)).resolves.toBe("https://cdn.example/image");

    const [sent] = sentRequests;
    if (!sent?.body) throw new Error("Expected an image request body.");
    expect(sent.path).toBe("/cgi-bin/media/uploadimg?access_token=token%20value");
    expect(sent.headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=paperdian-/);
    expect(sent.headers["Content-Length"]).toBe(String(sent.body.length));
    expect(sent.body.toString("utf8")).toContain('filename="unsafe_name_.png"');
    expect(sent.body.includes(Buffer.from([1, 2, 3]))).toBe(true);
    const boundary = sent.headers["Content-Type"].replace("multipart/form-data; boundary=", "");
    expect(sent.body.toString("utf8")).toMatch(new RegExp(`^--${boundary}\\r\\n[\\s\\S]*\\r\\n--${boundary}--\\r\\n$`));
  });

  it("rejects HTTP, malformed, API-error, and missing-token responses", async () => {
    expect(() => parseWeChatApiResponse({ statusCode: 503, body: "busy" })).toThrow("HTTP 503");
    expect(() => parseWeChatApiResponse({ statusCode: 199, body: "informational" })).toThrow("HTTP 199");
    expect(() => parseWeChatApiResponse({ statusCode: 300, body: "redirect" })).toThrow("HTTP 300");
    expect(() => parseWeChatApiResponse({ statusCode: 400, body: '{"errcode":45009,"errmsg":"api freq out of limit"}' })).toThrow("微信接口返回 HTTP 400（errcode=45009）");
    expect(() => parseWeChatApiResponse({ statusCode: 200, body: "not json" })).toThrow("无效 JSON");
    expect(() => parseWeChatApiResponse({ statusCode: 200, body: '"a scalar"' })).toThrow("返回格式无效");
    expect(() => parseWeChatApiResponse({ statusCode: 200, body: "[]" })).toThrow("返回格式无效");
    expect(() => parseWeChatApiResponse({ statusCode: 200, body: '{"errcode":40013,"errmsg":"bad appid"}' })).toThrow("errcode=40013");
    expect(parseWeChatApiResponse({ statusCode: 200, body: '{"errcode":0}' })).toEqual({ errcode: 0 });
    expect(() => parseWeChatApiResponse({ statusCode: 200, body: '{"errcode":40013}' })).toThrow("微信接口错误（errcode=40013）");

    const api = new WeChatApiClient(1081, { request: vi.fn().mockResolvedValue({ statusCode: 200, body: "{}" }) });
    await expect(api.getAccessToken("app", "secret")).rejects.toThrow("获取 access token 失败");
  });

  it("rejects successful API envelopes that omit the media identifiers", async () => {
    const image = { id: "id", sourcePath: "ignored", fileName: "image.png", mimeType: "image/png" as const, hash: "hash", bytes: new Uint8Array([1]) };
    const api = new WeChatApiClient(1081, { request: vi.fn().mockResolvedValue({ statusCode: 200, body: "{}" }) });

    await expect(api.uploadArticleImage("token", image)).rejects.toThrow("上传正文图片失败");
    await expect(api.uploadCover("token", image)).rejects.toThrow("上传封面失败");
  });
});
