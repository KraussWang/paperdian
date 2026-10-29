import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { SocksReadinessChecker } from "../src/wechat/SocksReadiness";
import { buildSshArguments, NodeSshTunnelFactory, type SshProcess, type SshTunnelRuntime, validateSshConfig } from "../src/wechat/SshTunnel";

describe("SOCKS readiness", () => {
  it("retries a failed probe and stops immediately when it becomes ready", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => { now += milliseconds; });
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error("not ready"))
      .mockResolvedValueOnce(undefined);
    const checker = new SocksReadinessChecker(
      { probe },
      { now: () => now, sleep }
    );

    await expect(checker.waitFor(1081, () => undefined)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(250);
  });

  it("does not probe after the SSH process has exited", async () => {
    const probe = vi.fn();
    const checker = new SocksReadinessChecker(
      { probe },
      { now: () => 0, sleep: async () => undefined }
    );

    await expect(checker.waitFor(1081, () => "permission denied")).rejects.toThrow("提前退出：permission denied");
    expect(probe).not.toHaveBeenCalled();
  });

  it("times out at the deadline instead of probing once more", async () => {
    let now = 0;
    const probe = vi.fn().mockRejectedValue(new Error("not ready"));
    const checker = new SocksReadinessChecker(
      { probe },
      { now: () => now, sleep: async () => { now = 12_000; } }
    );

    await expect(checker.waitFor(1081, () => undefined)).rejects.toThrow("连接超时");
    expect(probe).toHaveBeenCalledOnce();
  });
});

describe("SSH tunnel lifecycle", () => {
  it("reports an SSH executable launch error", async () => {
    let onError: ((error: Error) => void) | undefined;
    const launched: SshProcess = {
      exitCode: null,
      stderr: new PassThrough(),
      kill: () => true,
      once: (event: "close" | "error", listener: (() => void) | ((error: Error) => void)) => {
        if (event === "error") onError = listener as (error: Error) => void;
        return undefined;
      }
    };
    const runtime: SshTunnelRuntime = {
      access: async () => undefined,
      reservePort: async () => 1081,
      spawn: () => launched,
      wait: async () => undefined
    };
    const readiness = { waitFor: async (_port: number, exitMessage: () => string | undefined) => {
      onError?.(new Error("ENOENT"));
      throw new Error(exitMessage());
    } };
    await expect(new NodeSshTunnelFactory(readiness, runtime).open(
      { host: "jump.example", user: "deploy", port: 22, privateKeyPath: "C:/key" }, "missing-ssh"
    )).rejects.toThrow("无法启动 SSH，请检查本机 OpenSSH 是否已安装。");
  });

  it("cleans up a spawned process if SOCKS readiness fails", async () => {
    let killed = false;
    const spawn = vi.fn().mockReturnValue(fakeProcess(() => { killed = true; }));
    const runtime: SshTunnelRuntime = {
      access: vi.fn().mockResolvedValue(undefined),
      reservePort: vi.fn().mockResolvedValue(1081),
      spawn,
      wait: vi.fn().mockResolvedValue(undefined)
    };
    const readiness = { waitFor: vi.fn().mockRejectedValue(new Error("SOCKS unavailable")) };
    const factory = new NodeSshTunnelFactory(readiness, runtime);

    await expect(factory.open({ host: "jump.example", user: "deploy", port: 22, privateKeyPath: "C:/key" }, "ssh-under-test"))
      .rejects.toThrow("SOCKS unavailable");

    expect(spawn).toHaveBeenCalledWith("ssh-under-test", expect.arrayContaining(["-D", "127.0.0.1:1081", "deploy@jump.example"]));
    expect(killed).toBe(true);
  });

  it("does not kill an SSH process which has already exited", async () => {
    const killProcess = vi.fn();
    const process = fakeProcess(killProcess, 0);
    const wait = vi.fn().mockResolvedValue(undefined);
    const runtime: SshTunnelRuntime = {
      access: vi.fn().mockResolvedValue(undefined),
      reservePort: vi.fn().mockResolvedValue(1081),
      spawn: vi.fn().mockReturnValue(process),
      wait
    };
    const factory = new NodeSshTunnelFactory({ waitFor: vi.fn().mockResolvedValue(undefined) }, runtime);

    const tunnel = await factory.open({ host: "jump.example", user: "deploy", port: 22, privateKeyPath: "C:/key" }, "ssh-under-test");
    await tunnel.close();

    expect(killProcess).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it("constructs the constrained OpenSSH dynamic-forward command", () => {
    expect(buildSshArguments({ host: "jump.example", user: "deploy", port: 2222, privateKeyPath: "C:/key" }, 1081)).toEqual([
      "-N", "-D", "127.0.0.1:1081",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15",
      "-p", "2222",
      "-i", "C:/key",
      "deploy@jump.example"
    ]);
  });

  it.each([
    { host: "bad host", user: "deploy", port: 22, privateKeyPath: "C:/key" },
    { host: "jump.example", user: "bad user", port: 22, privateKeyPath: "C:/key" },
    { host: "jump.example", user: "deploy", port: 0, privateKeyPath: "C:/key" },
    { host: "jump.example", user: "deploy", port: 65536, privateKeyPath: "C:/key" },
    { host: "jump.example", user: "deploy", port: 22.5, privateKeyPath: "C:/key" },
    { host: "jump.example", user: "deploy", port: 22, privateKeyPath: "" },
    { host: "jump.example", user: "deploy", port: 22, privateKeyPath: "C:/key\nother" }
  ])("rejects unsafe SSH connection settings", config => {
    expect(() => validateSshConfig(config)).toThrow();
  });

  it.each([1, 65535])("accepts SSH port boundary %i", port => {
    expect(() => validateSshConfig({ host: "jump.example", user: "deploy", port, privateKeyPath: "C:/key" })).not.toThrow();
  });
});

function fakeProcess(onKill: () => void, exitCode: number | null = null): SshProcess & { kill: ReturnType<typeof vi.fn> } {
  const stderr = new PassThrough();
  return {
    exitCode,
    stderr,
    kill: vi.fn(() => { onKill(); return true; }),
    once: () => undefined
  };
}
