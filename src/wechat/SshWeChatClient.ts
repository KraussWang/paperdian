import net from "node:net";
import { NodeSocksHttpsTransport, type SocksHttpsResponse, type SocksHttpsTransport, type SocksTarget } from "./SocksHttpsTransport";
import { NodeSshTunnelFactory, type SshTunnel, type SshTunnelFactory } from "./SshTunnel";
import { WeChatApiClient, buildWeChatDraftPayload, type WeChatApi } from "./WeChatApi";
import type { SshAccount, WeChatAccount, WeChatClient, WeChatSession } from "./WeChatPublisher";

const EGRESS_IP_TARGET: SocksTarget = { host: "api.ipify.org", port: 443 };
const DEFAULT_WECHAT_TARGET: SocksTarget = { host: "api.weixin.qq.com", port: 443 };

export interface SshWeChatClientRuntime {
  readonly tunnels: SshTunnelFactory;
  createApi(socksPort: number): WeChatApi;
  queryEgressIp(socksPort: number): Promise<string>;
}

/** Thin composition root for SSH lifecycle, SOCKS transport, and WeChat protocol. */
export class SshWeChatClient implements WeChatClient {
  constructor(
    private readonly sshExecutable = process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "ssh",
    private readonly runtime: SshWeChatClientRuntime = createNodeSshWeChatClientRuntime()
  ) {}

  async open(account: WeChatAccount): Promise<WeChatSession> {
    const tunnel = await this.runtime.tunnels.open(account.ssh, this.sshExecutable);
    try {
      const api = this.runtime.createApi(tunnel.localPort);
      const accessToken = await api.getAccessToken(account.appId, account.appSecret);
      return createSession(api, accessToken, tunnel);
    } catch (error) {
      await tunnel.close();
      throw error;
    }
  }

  async testConnection(ssh: SshAccount): Promise<string> {
    const tunnel = await this.runtime.tunnels.open(ssh, this.sshExecutable);
    try {
      return await this.runtime.queryEgressIp(tunnel.localPort);
    } finally {
      await tunnel.close();
    }
  }

  async validateCredentials(account: WeChatAccount): Promise<void> {
    const session = await this.open(account);
    await session.close();
  }
}

export function createNodeSshWeChatClientRuntime(
  tunnels: SshTunnelFactory = new NodeSshTunnelFactory(),
  transport: SocksHttpsTransport = new NodeSocksHttpsTransport()
): SshWeChatClientRuntime {
  return {
    tunnels,
    createApi: socksPort => new WeChatApiClient(socksPort, transport),
    queryEgressIp: socksPort => queryEgressIp(socksPort, transport)
  };
}

export async function requestThroughSocks(
  socksPort: number,
  options: { method: string; path: string; headers: Record<string, string> },
  body?: Buffer,
  target: SocksTarget = DEFAULT_WECHAT_TARGET
): Promise<SocksHttpsResponse> {
  return new NodeSocksHttpsTransport().request(socksPort, { ...options, body, target });
}

export async function queryEgressIpThroughSocks(socksPort: number): Promise<string> {
  return queryEgressIp(socksPort, new NodeSocksHttpsTransport());
}

export function parseEgressIpResponse(response: SocksHttpsResponse): string {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`出口 IP 检测服务返回 HTTP ${response.statusCode}。`);
  let parsed: unknown;
  try { parsed = JSON.parse(response.body); } catch { throw new Error("出口 IP 检测服务返回了无效 JSON。"); }
  const ip = isRecord(parsed) && typeof parsed.ip === "string" ? parsed.ip.trim() : "";
  if (net.isIP(ip) === 0) throw new Error("出口 IP 检测服务未返回有效 IP 地址。");
  return ip;
}

export { buildWeChatDraftPayload };
export { validateSshConfig } from "./SshTunnel";

async function queryEgressIp(socksPort: number, transport: SocksHttpsTransport): Promise<string> {
  const response = await transport.request(socksPort, {
    method: "GET",
    path: "/?format=json",
    headers: { Accept: "application/json" },
    target: EGRESS_IP_TARGET
  });
  return parseEgressIpResponse(response);
}

function createSession(api: WeChatApi, accessToken: string, tunnel: SshTunnel): WeChatSession {
  return {
    uploadArticleImage: image => api.uploadArticleImage(accessToken, image),
    uploadCover: image => api.uploadCover(accessToken, image),
    addDraft: article => api.addDraft(accessToken, article),
    close: () => tunnel.close()
  };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
