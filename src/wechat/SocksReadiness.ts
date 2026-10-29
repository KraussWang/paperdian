import { SocksClient } from "socks";

const DEFAULT_PROBE_TARGET = { host: "api.weixin.qq.com", port: 443 };

export interface SocksProbe {
  probe(port: number): Promise<void>;
}

export interface SocksReadiness {
  waitFor(port: number, exitMessage: () => string | undefined): Promise<void>;
}

export interface SocksReadinessRuntime {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

export class SocksReadinessChecker implements SocksReadiness {
  constructor(
    private readonly probe: SocksProbe,
    private readonly runtime: SocksReadinessRuntime = nodeReadinessRuntime
  ) {}

  async waitFor(port: number, exitMessage: () => string | undefined): Promise<void> {
    const deadline = this.runtime.now() + 12_000;
    while (this.runtime.now() < deadline) {
      const exited = exitMessage();
      if (exited) throw new Error(`SSH 隧道提前退出：${exited}`);
      try {
        await this.probe.probe(port);
        return;
      } catch {
        await this.runtime.sleep(250);
      }
    }
    throw new Error(`SSH 隧道连接超时：${exitMessage() ?? ""}`.trim());
  }
}

export class NodeSocksProbe implements SocksProbe {
  async probe(port: number): Promise<void> {
    const attempt = await SocksClient.createConnection({
      command: "connect",
      proxy: { host: "127.0.0.1", port, type: 5 },
      destination: DEFAULT_PROBE_TARGET,
      timeout: 1_500
    });
    attempt.socket.destroy();
  }
}

const nodeReadinessRuntime: SocksReadinessRuntime = {
  now: () => Date.now(),
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
};
