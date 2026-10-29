import { describe, expect, it, vi } from "vitest";
import { SshWeChatClient, type SshWeChatClientRuntime } from "../src/wechat/SshWeChatClient";
import type { SshAccount, WeChatAccount } from "../src/wechat/WeChatPublisher";
import type { SshTunnel } from "../src/wechat/SshTunnel";
import type { WeChatApi } from "../src/wechat/WeChatApi";

const ssh: SshAccount = { host: "jump.example", user: "deploy", port: 22, privateKeyPath: "C:/key" };
const account: WeChatAccount = {
  alias: "main", appId: "app-id", appSecret: "app-secret", ssh,
  needOpenComment: 0, onlyFansCanComment: 1
};

describe("SshWeChatClient composition", () => {
  it("validates credentials without uploading or creating a draft and closes the tunnel", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fake = fakeApi();
    const client = new SshWeChatClient("ssh-under-test", {
      tunnels: { open: vi.fn().mockResolvedValue({ localPort: 1081, close }) },
      createApi: () => fake.api,
      queryEgressIp: vi.fn()
    });
    await client.validateCredentials(account);
    expect(fake.calls).toEqual([["token", "app-id", "app-secret"]]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens a tunnel once and binds every session operation to its access token", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fake = fakeApi();
    const open = vi.fn().mockResolvedValue({ localPort: 1081, close } satisfies SshTunnel);
    const runtime: SshWeChatClientRuntime = {
      tunnels: { open },
      createApi: port => { expect(port).toBe(1081); return fake.api; },
      queryEgressIp: vi.fn()
    };
    const client = new SshWeChatClient("ssh-under-test", runtime);

    const session = await client.open(account);
    await expect(session.uploadArticleImage(image)).resolves.toBe("article-url");
    await expect(session.uploadCover(image)).resolves.toBe("cover-id");
    await expect(session.addDraft(article)).resolves.toBe("draft-id");
    await session.close();

    expect(open).toHaveBeenCalledWith(ssh, "ssh-under-test");
    expect(fake.calls).toEqual([
      ["token", "app-id", "app-secret"],
      ["article", "token", image],
      ["cover", "token", image],
      ["draft", "token", article]
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a tunnel when token acquisition fails", async () => {
    const close = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const runtime: SshWeChatClientRuntime = {
      tunnels: { open: vi.fn().mockResolvedValue({ localPort: 1081, close } satisfies SshTunnel) },
      createApi: () => ({ ...fakeApi().api, getAccessToken: async () => Promise.reject(new Error("denied")) }),
      queryEgressIp: vi.fn()
    };

    await expect(new SshWeChatClient("ssh-under-test", runtime).open(account)).rejects.toThrow("denied");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes the tunnel after both successful and failed connection checks", async () => {
    const successfulClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const successfulRuntime = runtimeForConnection(successfulClose, vi.fn().mockResolvedValue("203.0.113.8"));
    await expect(new SshWeChatClient("ssh-under-test", successfulRuntime).testConnection(ssh)).resolves.toBe("203.0.113.8");
    expect(successfulClose).toHaveBeenCalledOnce();

    const failedClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const failedRuntime = runtimeForConnection(failedClose, vi.fn().mockRejectedValue(new Error("egress unavailable")));
    await expect(new SshWeChatClient("ssh-under-test", failedRuntime).testConnection(ssh)).rejects.toThrow("egress unavailable");
    expect(failedClose).toHaveBeenCalledOnce();
  });
});

function runtimeForConnection(close: () => Promise<void>, queryEgressIp: (port: number) => Promise<string>): SshWeChatClientRuntime {
  return {
    tunnels: { open: vi.fn().mockResolvedValue({ localPort: 1081, close } satisfies SshTunnel) },
    createApi: () => fakeApi().api,
    queryEgressIp
  };
}

function fakeApi(): { api: WeChatApi; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    api: {
      getAccessToken: async (appId, appSecret) => { calls.push(["token", appId, appSecret]); return "token"; },
      uploadArticleImage: async (token, input) => { calls.push(["article", token, input]); return "article-url"; },
      uploadCover: async (token, input) => { calls.push(["cover", token, input]); return "cover-id"; },
      addDraft: async (token, input) => { calls.push(["draft", token, input]); return "draft-id"; }
    }
  };
}

const image = { id: "image", sourcePath: "image.png", fileName: "image.png", mimeType: "image/png" as const, hash: "hash", bytes: new Uint8Array([1]) };
const article = { title: "title", summary: "summary", author: "author", sourceUrl: "https://example.com", html: "<p>body</p>", coverMediaId: "cover", needOpenComment: 0 as const, onlyFansCanComment: 1 as const };
