import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { discoverClaudeExecutable } from "./ClaudeRuntime";

export async function checkClaudeInstallation(configuredPath: string, vaultPath: string): Promise<string> {
  const executable = await discoverClaudeExecutable(configuredPath.trim() || undefined);
  const { stdout } = await promisify(execFile)(executable, ["--version"], {
    cwd: vaultPath, windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 16_384
  });
  const version = stdout.match(/^\s*(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m)?.[1];
  if (!version) throw new Error("无法识别 Claude Code 版本。");
  return version;
}
