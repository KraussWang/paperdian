import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  state?: "streaming" | "complete" | "stopped" | "error";
}

export interface Conversation {
  id: string;
  name: string;
  revision: number;
  sessionId?: string;
  model?: string;
  effort?: "low" | "medium" | "high";
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export class RevisionConflictError extends Error {
  constructor() { super("会话已被其他任务更新，请重新载入后再试。"); }
}

export class ConversationRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly directory: string;

  constructor(vaultPath: string) {
    this.directory = path.join(vaultPath, ".paperdian", "chat-v1", "conversations");
  }

  async list(): Promise<Conversation[]> {
    await mkdir(this.directory, { recursive: true });
    const entries = await readdir(this.directory, { withFileTypes: true });
    const conversations = await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => this.readFile(path.join(this.directory, entry.name))));
    return conversations.filter((item): item is Conversation => item !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(id: string): Promise<Conversation | undefined> {
    assertId(id);
    return this.readFile(this.filePath(id));
  }

  save(conversation: Conversation, expectedRevision: number): Promise<Conversation> {
    assertId(conversation.id);
    return this.serial(async () => {
      await mkdir(this.directory, { recursive: true });
      const current = await this.get(conversation.id);
      if ((current?.revision ?? 0) !== expectedRevision) throw new RevisionConflictError();
      const next = { ...conversation, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
      const serialized = JSON.stringify(next, null, 2);
      if (Buffer.byteLength(serialized, "utf8") > 2_000_000) throw new Error("会话超过 2 MB，请新建会话后继续。");
      const target = this.filePath(conversation.id);
      const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
      await rename(temporary, target);
      return next;
    });
  }

  delete(id: string): Promise<void> {
    assertId(id);
    return this.serial(async () => { await rm(this.filePath(id), { force: true }); });
  }

  private filePath(id: string): string { return path.join(this.directory, `${id}.json`); }

  private async readFile(filePath: string): Promise<Conversation | undefined> {
    try {
      const raw = await readFile(filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > 2_000_000) throw new Error("会话文件过大，已拒绝载入。");
      let parsed: unknown;
      try { parsed = JSON.parse(raw); }
      catch { return undefined; }
      return isConversation(parsed) ? recoverInterrupted(parsed) : undefined;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function assertId(id: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("无效的会话 ID。");
}

function isConversation(value: unknown): value is Conversation {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.name === "string"
    && typeof item.revision === "number"
    && Number.isInteger(item.revision)
    && item.revision >= 0
    && typeof item.createdAt === "string"
    && typeof item.updatedAt === "string"
    && (item.sessionId === undefined || typeof item.sessionId === "string")
    && (item.model === undefined || typeof item.model === "string")
    && (item.effort === undefined || item.effort === "low" || item.effort === "medium" || item.effort === "high")
    && Array.isArray(item.messages)
    && item.messages.every(isChatMessage);
}

function isChatMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && (item.role === "user" || item.role === "assistant")
    && typeof item.content === "string"
    && typeof item.createdAt === "string"
    && (item.state === undefined || item.state === "streaming" || item.state === "complete" || item.state === "stopped" || item.state === "error");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function recoverInterrupted(conversation: Conversation): Conversation {
  let changed = false;
  const messages = conversation.messages.map(message => {
    if (message.state !== "streaming") return message;
    changed = true;
    return { ...message, state: "stopped" as const, content: message.content || "上次 Claude 任务在 Obsidian 关闭时中断。" };
  });
  return changed ? { ...conversation, messages } : conversation;
}
