import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { MATERIAL_PAPER_DEEP_READING_SKILL_ID, type SelectedSkillSnapshot } from "../skills/SkillCatalog";

export type ClaudePermissionMode = "acceptEdits" | "default" | "plan" | "dontAsk" | "bypassPermissions";

export interface ClaudeTurnRequest {
  runId: string;
  prompt: string;
  currentNotePath?: string;
  sessionId?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  permissionMode?: ClaudePermissionMode;
  selectedSkills?: SelectedSkillSnapshot[];
  recoveryTranscript?: string;
}

export type ClaudeRuntimeEvent =
  | { type: "started"; runId: string }
  | { type: "session"; sessionId: string }
  | { type: "text-delta"; text: string }
  | { type: "tool"; name: string; input?: unknown }
  | { type: "warning"; message: string };

export interface ClaudeTurnResult {
  runId: string;
  sessionId?: string;
  text: string;
  stopped: boolean;
}

export interface ClaudeRuntimeStatus {
  state: "idle" | "running" | "stopping";
  runId?: string;
  startedAt?: string;
}

export interface ClaudeProcessInput {
  runId: string;
  executablePath: string;
  args: string[];
  cwd: string;
  stdin: string;
}

export interface ClaudeProcessObserver {
  stdout(chunk: string): void;
  stderr(chunk: string): void;
}

export interface ClaudeProcessAdapter {
  run(input: ClaudeProcessInput, observer: ClaudeProcessObserver): Promise<{ exitCode: number | null; stderr: string }>;
  cancel(runId: string): Promise<void>;
}

export interface ClaudeRuntimeOptions {
  vaultPath: string;
  executablePath: string;
  processAdapter?: ClaudeProcessAdapter;
  maxOutputChars?: number;
}

export class ClaudeRuntime {
  private status: ClaudeRuntimeStatus = { state: "idle" };
  private readonly adapter: ClaudeProcessAdapter;
  private readonly maxOutputChars: number;

  constructor(private readonly options: ClaudeRuntimeOptions) {
    this.adapter = options.processAdapter ?? new NativeClaudeProcessAdapter();
    this.maxOutputChars = options.maxOutputChars ?? 200_000;
  }

  getStatus(): ClaudeRuntimeStatus {
    return { ...this.status };
  }

  async cancel(runId: string): Promise<void> {
    if (this.status.runId !== runId || this.status.state === "idle") return;
    this.status = { ...this.status, state: "stopping" };
    await this.adapter.cancel(runId);
  }

  async runTurn(request: ClaudeTurnRequest, onEvent: (event: ClaudeRuntimeEvent) => void): Promise<ClaudeTurnResult> {
    if (this.status.state !== "idle") throw new Error("Claude 当前已有任务正在运行。请先停止该任务。");
    if (!request.prompt.trim()) throw new Error("消息不能为空。");

    this.status = { state: "running", runId: request.runId, startedAt: new Date().toISOString() };
    onEvent({ type: "started", runId: request.runId });
    const parser = new StreamJsonParser(this.maxOutputChars, onEvent);
    let stderr = "";
    try {
      const result = await this.adapter.run(
        {
          runId: request.runId,
          executablePath: this.options.executablePath,
          args: buildClaudeArgs(request),
          cwd: this.options.vaultPath,
          stdin: buildPrompt(request)
        },
        {
          stdout: chunk => parser.push(chunk),
          stderr: chunk => { stderr = appendLimited(stderr, chunk, 20_000); }
        }
      );
      parser.finish();
      const stopped = this.status.state === "stopping";
      if (!stopped && result.exitCode !== 0) {
        const detail = (stderr || result.stderr).trim();
        throw new Error(`Claude Code 异常退出（代码 ${String(result.exitCode)}）${detail ? `：${detail}` : "。"}`);
      }
      return { runId: request.runId, sessionId: parser.sessionId, text: parser.text, stopped };
    } finally {
      this.status = { state: "idle" };
    }
  }
}

export function buildClaudeArgs(request: ClaudeTurnRequest): string[] {
  const args = [
    "-p",
    "--input-format", "text",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", request.permissionMode ?? "acceptEdits",
    "--setting-sources", "user",
    "--safe-mode"
  ];
  if (request.selectedSkills?.some(skill => skill.id === MATERIAL_PAPER_DEEP_READING_SKILL_ID)) {
    args.push("--disallowedTools", "WebFetch,WebSearch");
  }
  const resourceDirectories = [...new Set(request.selectedSkills
    ?.map(skill => skill.resourceDirectory?.trim())
    .filter((directory): directory is string => Boolean(directory)) ?? [])];
  if (resourceDirectories.length) args.push("--add-dir", ...resourceDirectories);
  if (request.model?.trim()) args.push("--model", request.model.trim());
  if (request.effort) args.push("--effort", request.effort);
  if (request.sessionId?.trim()) args.push("--resume", request.sessionId.trim());
  return args;
}

function buildPrompt(request: ClaudeTurnRequest): string {
  const sections: string[] = [];
  if (request.currentNotePath) {
    sections.push(`当前 Obsidian 笔记（相对 Vault 根目录）：${request.currentNotePath}\n需要时请使用文件工具读取它，不要读取未被请求的凭证、SSH 配置或插件日志。`);
  }
  if (request.selectedSkills?.length) {
    const selected = request.selectedSkills.map(skill => [
      `<selected-skill name="${escapeAttribute(skill.name)}"${skill.resourceDirectory ? ` resource-directory="${escapeAttribute(skill.resourceDirectory)}"` : ""}>`,
      skill.instructions,
      "</selected-skill>"
    ].join("\n")).join("\n\n");
    sections.push(`以下 Skills 是用户为本轮明确选择的指令。请仅在与请求相关时遵循，并保持当前安全边界。若 selected-skill 含 resource-directory，该目录是完整 Skill 的一次性隔离副本：相对路径均以该目录为基准，可读取其中的参考资料和素材，也可按指令执行其中的脚本；不要修改该副本，最终产物写入当前 Vault。\n\n${selected}`);
  }
  if (request.recoveryTranscript) sections.push(`此前会话无法恢复。下面是已保存的对话摘要，请延续其上下文：\n${request.recoveryTranscript}`);
  sections.push(`用户请求：\n${request.prompt}`);
  return sections.join("\n\n");
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

class StreamJsonParser {
  private buffer = "";
  private emittedText = "";
  private pendingAssistantText = "";
  sessionId?: string;

  constructor(private readonly limit: number, private readonly emit: (event: ClaudeRuntimeEvent) => void) {}

  get text(): string { return this.emittedText; }

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.consume(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  finish(): void {
    const line = this.buffer.trim();
    if (line) this.consume(line);
    this.buffer = "";
  }

  private consume(line: string): void {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error("Claude 返回了无法解析的流式数据。"); }
    if (!isRecord(value)) return;
    if (typeof value.session_id === "string") {
      this.sessionId = value.session_id;
      this.emit({ type: "session", sessionId: value.session_id });
    }
    const delta = extractDelta(value);
    if (delta) {
      this.pendingAssistantText += delta;
      this.appendDelta(delta);
    }
    if (value.type === "assistant") {
      const complete = extractAssistantText(value);
      if (complete) {
        const snapshotExtendsStream = complete.startsWith(this.pendingAssistantText);
        const streamExtendsSnapshot = this.pendingAssistantText.startsWith(complete);
        if (!snapshotExtendsStream && !streamExtendsSnapshot) {
          throw new Error("Claude 流式文本与完整消息不一致。");
        }
        const suffix = snapshotExtendsStream ? complete.slice(this.pendingAssistantText.length) : "";
        this.appendDelta(suffix);
      }
      this.pendingAssistantText = "";
    }
    const tool = extractTool(value);
    if (tool) this.emit({ type: "tool", ...tool });
  }

  private appendDelta(delta: string): void {
    if (!delta) return;
    if (this.emittedText.length + delta.length > this.limit) throw new Error("Claude 输出超过插件允许的大小，请缩小任务范围。");
    this.emittedText += delta;
    this.emit({ type: "text-delta", text: delta });
  }
}

function extractDelta(value: Record<string, unknown>): string {
  const event = isRecord(value.event) ? value.event : undefined;
  const delta = event && isRecord(event.delta) ? event.delta : undefined;
  return delta?.type === "text_delta" && typeof delta.text === "string" ? delta.text : "";
}

function extractAssistantText(value: Record<string, unknown>): string {
  const message = isRecord(value.message) ? value.message : undefined;
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter(isRecord)
    .filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => String(block.text))
    .join("");
}

function extractTool(value: Record<string, unknown>): { name: string; input?: unknown } | undefined {
  const message = isRecord(value.message) ? value.message : undefined;
  if (!message || !Array.isArray(message.content)) return undefined;
  const block = message.content.filter(isRecord).find(item => item.type === "tool_use" && typeof item.name === "string");
  return block ? { name: String(block.name), input: block.input } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendLimited(current: string, addition: string, max: number): string {
  return (current + addition).slice(-max);
}

export class NativeClaudeProcessAdapter implements ClaudeProcessAdapter {
  private readonly processes = new Map<string, ChildProcessWithoutNullStreams>();

  run(input: ClaudeProcessInput, observer: ClaudeProcessObserver): Promise<{ exitCode: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(input.executablePath, input.args, {
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        stdio: "pipe"
      });
      this.processes.set(input.runId, child);
      let stderr = "";
      let settled = false;
      const removeProcess = (): void => {
        if (this.processes.get(input.runId) === child) this.processes.delete(input.runId);
      };
      const failObserver = (error: unknown): void => {
        if (settled) return;
        settled = true;
        removeProcess();
        const observerError = error instanceof Error ? error : new Error(String(error));
        void stopProcess(child).then(
          () => reject(observerError),
          () => reject(observerError)
        );
      };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (settled) return;
        try { observer.stdout(chunk); } catch (error) { failObserver(error); }
      });
      child.stderr.on("data", (chunk: string) => {
        if (settled) return;
        stderr = appendLimited(stderr, chunk, 20_000);
        try { observer.stderr(chunk); } catch (error) { failObserver(error); }
      });
      child.once("error", error => {
        removeProcess();
        if (settled) return;
        settled = true;
        reject(new Error(`无法启动 Claude Code：${error.message}`));
      });
      child.once("close", exitCode => {
        removeProcess();
        if (settled) return;
        settled = true;
        resolve({ exitCode, stderr });
      });
      child.stdin.end(input.stdin, "utf8");
    });
  }

  async cancel(runId: string): Promise<void> {
    const child = this.processes.get(runId);
    if (!child?.pid) return;
    await stopProcess(child);
    if (this.processes.get(runId) === child) this.processes.delete(runId);
  }
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>(resolve => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        resolve();
      };
      const fallback = (): void => {
        try { child.kill(); } catch { /* process already stopped */ }
      };
      const killer = spawn("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { shell: false, windowsHide: true });
      killer.once("close", exitCode => {
        if (exitCode !== 0) fallback();
        finish();
      });
      killer.once("error", () => {
        fallback();
        finish();
      });
    });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("close", () => resolve());
  });
}

export async function discoverClaudeExecutable(configuredPath?: string, environmentPath = process.env.Path ?? process.env.PATH ?? ""): Promise<string> {
  const inputs = configuredPath ? [configuredPath] : environmentPath.split(path.delimiter).flatMap(folder => [path.join(folder, "claude.exe"), path.join(folder, "claude.cmd")]);
  for (const input of inputs) {
    const resolved = path.resolve(input);
    // A configured path may point directly to a native Unix executable.  The
    // Windows shim handling below remains necessary for npm's claude.cmd.
    if (!path.extname(resolved) && await isNativeExecutable(resolved)) return resolved;
    if (resolved.toLowerCase().endsWith(".exe") && await exists(resolved)) return resolved;
    if (resolved.toLowerCase().endsWith(".cmd") && await exists(resolved)) {
      const sibling = path.join(path.dirname(resolved), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
      if (await exists(sibling)) return sibling;
      const content = await readFile(resolved, "utf8");
      const match = content.match(/(?:"|%~dp0)([^"\r\n]*claude\.exe)/i);
      if (match?.[1]) {
        const candidate = path.resolve(path.dirname(resolved), match[1].replace(/^%~dp0/i, ""));
        if (await exists(candidate)) return candidate;
      }
    }
    if (!path.extname(resolved)) {
      for (const suffix of [".exe", ".cmd"]) {
        try { return await discoverClaudeExecutable(resolved + suffix, environmentPath); } catch { /* continue */ }
      }
    }
  }
  throw new Error(process.platform === "win32"
    ? "未找到 Claude Code 原生可执行文件。请在 Paperdian 设置中指定 claude.cmd 或 claude.exe。"
    : "未找到 Claude Code 可执行文件。请在 Paperdian 设置中指定 claude 的绝对路径。");
}

async function exists(filePath: string): Promise<boolean> {
  try { return (await stat(filePath)).isFile(); } catch { return false; }
}

async function isNativeExecutable(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && (process.platform === "win32" || (info.mode & 0o111) !== 0);
  } catch { return false; }
}
