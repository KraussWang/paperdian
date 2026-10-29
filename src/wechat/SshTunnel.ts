import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import type { SshAccount } from "./WeChatPublisher";
import { NodeSocksProbe, SocksReadinessChecker, type SocksReadiness } from "./SocksReadiness";

export interface SshTunnel {
  readonly localPort: number;
  close(): Promise<void>;
}

export interface SshTunnelFactory {
  open(config: SshAccount, executable: string): Promise<SshTunnel>;
}

export interface SshProcess {
  readonly exitCode: number | null;
  readonly stderr: Pick<ChildProcessWithoutNullStreams["stderr"], "setEncoding" | "on">;
  kill(): boolean;
  once(event: "close", listener: () => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface SshTunnelRuntime {
  access(path: string): Promise<void>;
  reservePort(): Promise<number>;
  spawn(executable: string, args: string[]): SshProcess;
  wait(milliseconds: number): Promise<void>;
}

export class NodeSshTunnelFactory implements SshTunnelFactory {
  constructor(
    private readonly readiness: SocksReadiness = new SocksReadinessChecker(new NodeSocksProbe()),
    private readonly runtime: SshTunnelRuntime = nodeSshTunnelRuntime
  ) {}

  async open(config: SshAccount, executable: string): Promise<SshTunnel> {
    validateSshConfig(config);
    try { await this.runtime.access(config.privateKeyPath); }
    catch { throw new Error("无法读取 SSH 私钥文件，请检查路径和文件权限。"); }
    const localPort = await this.runtime.reservePort();
    const process = this.runtime.spawn(executable, buildSshArguments(config, localPort));
    let stderr = "";
    let spawnError: Error | undefined;
    process.once("error", error => { spawnError = error; });
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
    const tunnel = new ManagedSshTunnel(localPort, process, this.runtime);
    try {
      await this.readiness.waitFor(localPort, () => spawnError ? "无法启动 SSH，请检查本机 OpenSSH 是否已安装。" : process.exitCode === null ? undefined : sanitizeSshError(stderr));
      return tunnel;
    } catch (error) {
      await tunnel.close();
      throw error;
    }
  }
}

export function buildSshArguments(config: SshAccount, localPort: number): string[] {
  return [
    "-N", "-D", `127.0.0.1:${localPort}`,
    "-o", "ExitOnForwardFailure=yes",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-p", String(config.port),
    "-i", config.privateKeyPath,
    `${config.user}@${config.host}`
  ];
}

export function validateSshConfig(config: SshAccount): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(config.host)) throw new Error("SSH 主机名包含不允许的字符。");
  if (!/^[a-zA-Z0-9._-]+$/.test(config.user)) throw new Error("SSH 用户名包含不允许的字符。");
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error("SSH 端口无效。");
  if (!config.privateKeyPath || /[\r\n]/.test(config.privateKeyPath)) throw new Error("SSH 私钥路径无效。");
}

class ManagedSshTunnel implements SshTunnel {
  constructor(
    readonly localPort: number,
    private readonly process: SshProcess,
    private readonly runtime: SshTunnelRuntime
  ) {}

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.kill();
    await Promise.race([
      new Promise<void>(resolve => { this.process.once("close", resolve); }),
      this.runtime.wait(2_000)
    ]);
  }
}

const nodeSshTunnelRuntime: SshTunnelRuntime = {
  access,
  reservePort,
  spawn: (executable, args) => spawn(executable, args, { shell: false, windowsHide: true, stdio: "pipe" }),
  wait: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
};

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function sanitizeSshError(value: string): string {
  if (/permission denied|load key|bad permissions/i.test(value)) return "SSH 认证失败，请检查用户名、私钥权限和 ssh-agent。";
  if (/host key verification|host identification has changed/i.test(value)) return "SSH 主机指纹校验失败，请在终端核对主机身份。";
  if (/timed out|refused|resolve hostname/i.test(value)) return "SSH 连接失败，请检查主机、端口和网络。";
  return "SSH 提前退出，请在本机终端检查连接配置。";
}
