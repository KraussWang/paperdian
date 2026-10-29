import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConversationRepository, RevisionConflictError } from "../src/storage/ConversationRepository";

describe("ConversationRepository", () => {
  it("persists conversations atomically and rejects a stale revision", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-chat-"));
    const repository = new ConversationRepository(vault);
    const first = await repository.save({
      id: "chat-1", name: "论文", revision: 0, messages: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
    }, 0);

    expect(first.revision).toBe(1);
    await expect(repository.save({ ...first, name: "过期写入" }, 0)).rejects.toBeInstanceOf(RevisionConflictError);
    const saved = JSON.parse(await readFile(path.join(vault, ".paperdian/chat-v1/conversations/chat-1.json"), "utf8")) as { name: string };
    expect(saved.name).toBe("论文");
  });

  it("loads legacy conversations and persists per-conversation model preferences", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-chat-"));
    const directory = path.join(vault, ".paperdian", "chat-v1", "conversations");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "legacy.json"), JSON.stringify({
      id: "legacy",
      name: "旧会话",
      revision: 1,
      messages: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    }));
    const repository = new ConversationRepository(vault);

    const legacy = await repository.get("legacy");
    expect(legacy?.id).toBe("legacy");
    expect(legacy?.model).toBeUndefined();
    expect(legacy?.effort).toBeUndefined();

    const saved = await repository.save({ ...legacy!, model: "opus", effort: "high" }, legacy!.revision);
    expect(await repository.get("legacy")).toMatchObject({
      id: "legacy",
      model: "opus",
      effort: "high",
      revision: saved.revision
    });
  });

  it("isolates corrupt files and recovers interrupted streaming messages", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-chat-"));
    const directory = path.join(vault, ".paperdian", "chat-v1", "conversations");
    await mkdir(path.join(directory, "not-a-conversation.json"), { recursive: true });
    await writeFile(path.join(directory, "broken.json"), "{not valid json");
    await writeFile(path.join(directory, "malformed.json"), JSON.stringify({
      id: "malformed", name: "坏数据", revision: 1, messages: [null], createdAt: "2026-01-01", updatedAt: "2026-01-01"
    }));
    await writeFile(path.join(directory, "interrupted.json"), JSON.stringify({
      id: "interrupted", name: "恢复", revision: 1,
      messages: [{ id: "m", role: "assistant", content: "", createdAt: "2026-01-01", state: "streaming" }],
      createdAt: "2026-01-01", updatedAt: "2026-01-02"
    }));
    const repository = new ConversationRepository(vault);

    await expect(repository.get("broken")).resolves.toBeUndefined();
    await expect(repository.list()).resolves.toEqual([expect.objectContaining({
      id: "interrupted",
      messages: [expect.objectContaining({ state: "stopped", content: "上次 Claude 任务在 Obsidian 关闭时中断。" })]
    })]);
  });

  it("has idempotent deletion and rejects traversal IDs", async () => {
    const vault = await mkdtemp(path.join(os.tmpdir(), "paperdian-chat-"));
    const repository = new ConversationRepository(vault);

    await expect(repository.delete("missing")).resolves.toBeUndefined();
    await expect(repository.get("../outside")).rejects.toThrow("无效的会话 ID");
  });
});
