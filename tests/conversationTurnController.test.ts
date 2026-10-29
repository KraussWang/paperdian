import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ClaudeRuntime, type ClaudeTurnRequest, type ClaudeTurnResult } from "../src/claude/ClaudeRuntime";
import type { SelectedSkillSnapshot } from "../src/skills/SkillCatalog";
import { MATERIAL_PAPER_DEEP_READING_SKILL_ID, SkillCatalog } from "../src/skills/SkillCatalog";
import type { Conversation } from "../src/storage/ConversationRepository";
import { ConversationTurnController } from "../src/workflows/ConversationTurnController";

const baseConversation: Conversation = {
  id: "conversation-1",
  name: "Paper notes",
  revision: 3,
  sessionId: "existing-session",
  model: "claude-sonnet",
  effort: "high",
  messages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("ConversationTurnController", () => {
  it("waits for the persisted-turn lifecycle hook before starting the runtime", async () => {
    const order: string[] = [];
    let releaseTurnStart: (() => void) | undefined;
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 })
      },
      runtime: {
        runTurn: async request => {
          order.push("runtime");
          return { runId: request.runId, text: "done", stopped: false };
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-order", "user-order", "assistant-order"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const execution = controller.execute({
      conversation: baseConversation,
      prompt: "Wait for the view",
      selectedSkills: [],
      onTurnStarted: async () => {
        order.push("turn-start");
        await new Promise<void>(resolve => { releaseTurnStart = resolve; });
      }
    });

    await vi.waitFor(() => expect(releaseTurnStart).toBeTypeOf("function"));
    expect(order).toEqual(["turn-start"]);
    releaseTurnStart?.();
    await execution;
    expect(order).toEqual(["turn-start", "runtime"]);
  });

  it("persists a turn before execution and stores its completed result", async () => {
    const saves: Conversation[] = [];
    const requests: ClaudeTurnRequest[] = [];
    const observedStates: string[] = [];
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => {
          saves.push(structuredClone(conversation));
          return { ...conversation, revision: revision + 1 };
        }
      },
      runtime: {
        runTurn: async (request, observer) => {
          requests.push(request);
          observer({ type: "text-delta", text: "streamed" });
          return { runId: request.runId, sessionId: "next-session", text: "final answer", stopped: false } satisfies ClaudeTurnResult;
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-1", "user-1", "assistant-1"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: baseConversation,
      prompt: "Summarize the paper",
      sourceNotePath: "papers/source.md",
      selectedSkills: [] satisfies SelectedSkillSnapshot[],
      onAssistantUpdate: assistant => observedStates.push(`${assistant.state}:${assistant.content}`)
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      runId: "run-1",
      sessionId: "existing-session",
      prompt: "Summarize the paper",
      currentNotePath: "papers/source.md",
      model: "claude-sonnet",
      effort: "high"
    });
    expect(saves).toHaveLength(2);
    expect(saves[0]?.messages).toMatchObject([
      { id: "user-1", role: "user", state: "complete", content: "Summarize the paper" },
      { id: "assistant-1", role: "assistant", state: "streaming", content: "" }
    ]);
    expect(saves[1]).toMatchObject({ sessionId: "next-session", messages: [{}, { state: "complete", content: "final answer" }] });
    expect(result.conversation.sessionId).toBe("next-session");
    expect(result.assistant).toMatchObject({ state: "complete", content: "final answer" });
    expect(observedStates).toContain("streaming:streamed");
  });

  it("keeps streamed, final, and persisted text consistent across tool-separated assistant messages", async () => {
    const saves: Conversation[] = [];
    const observed: string[] = [];
    const runtime = new ClaudeRuntime({
      vaultPath: "C:/vault",
      executablePath: "claude.exe",
      processAdapter: {
        async run(_input, observer) {
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"FIRST\\n\\n"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-1","content":[{"type":"text","text":"FIRST\\n\\n"},{"type":"tool_use","name":"Read","input":{"file_path":"paper.md"}}]}}\n');
          observer.stdout('{"type":"stream_event","event":{"delta":{"type":"text_delta","text":"SECOND"}}}\n');
          observer.stdout('{"type":"assistant","message":{"id":"message-2","content":[{"type":"text","text":"SECOND"}]}}\n');
          return { exitCode: 0, stderr: "" };
        },
        async cancel() {}
      }
    });
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => {
          saves.push(structuredClone(conversation));
          return { ...conversation, revision: revision + 1 };
        }
      },
      runtime,
      createId: (() => {
        const ids = ["integrated-run", "integrated-user", "integrated-assistant"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: { ...baseConversation, sessionId: undefined },
      prompt: "Use a tool between two updates",
      selectedSkills: [],
      onAssistantUpdate: assistant => observed.push(assistant.content)
    });

    expect(observed).toContain("FIRST\n\nSECOND");
    expect(result.assistant.content).toBe("FIRST\n\nSECOND");
    expect(saves[1]?.messages[1]?.content).toBe("FIRST\n\nSECOND");
  });

  it("finalizes and records a successful deep-reading delivery before terminal persistence", async () => {
    const saves: Conversation[] = [];
    const calls: string[] = [];
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => {
          saves.push(structuredClone(conversation));
          return { ...conversation, revision: revision + 1 };
        }
      },
      runtime: {
        runTurn: async request => ({ runId: request.runId, text: "deep reading", stopped: false }),
        getStatus: () => ({ state: "idle" })
      },
      deepReading: {
        skillId: MATERIAL_PAPER_DEEP_READING_SKILL_ID,
        finalize: async () => {
          calls.push("finalize");
          return { repairs: ["normalized metadata"], issues: [] };
        },
        validate: async () => {
          calls.push("validate");
          return { ok: true, relativePath: "output/article.md" };
        }
      },
      createId: (() => {
        const ids = ["run-2", "user-2", "assistant-2"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: baseConversation,
      prompt: "Read deeply",
      sourceNotePath: "papers/source.md",
      selectedSkills: [{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "" }]
    });

    expect(calls).toEqual(["finalize", "validate"]);
    expect(result.assistant.content).toContain("已生成精读输出：`output/article.md`；自动修复：normalized metadata");
    expect(saves[1]?.messages[1]?.content).toContain("已生成精读输出");
  });

  it("reports deep-reading format findings without failing the generated output", async () => {
    const notices: string[] = [];
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: {
        runTurn: async request => ({ runId: request.runId, text: "deep reading", stopped: false }),
        getStatus: () => ({ state: "idle" })
      },
      deepReading: {
        skillId: MATERIAL_PAPER_DEEP_READING_SKILL_ID,
        finalize: async () => ({ repairs: [], issues: ["章节需人工检查"] }),
        validate: async () => ({ ok: true, relativePath: "output/article.md", warnings: ["标题格式需人工检查"] })
      },
      createId: (() => {
        const ids = ["format-run", "format-user", "format-assistant"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: baseConversation,
      prompt: "Read deeply",
      sourceNotePath: "papers/source.md",
      selectedSkills: [{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "" }],
      onWarning: warning => notices.push(warning)
    });

    expect(result.assistant.content).toContain("已生成精读输出：`output/article.md`；格式提醒（不影响创建公众号草稿）：章节需人工检查；标题格式需人工检查");
    expect(notices).toEqual([]);
  });

  it("recovers a failed resumable session once with a bounded recent transcript", async () => {
    const requests: ClaudeTurnRequest[] = [];
    const recoveryNotifications: string[] = [];
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 })
      },
      runtime: {
        runTurn: async request => {
          requests.push(request);
          if (requests.length === 1) throw new Error("session expired");
          return { runId: request.runId, text: "recovered", stopped: false };
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-3", "user-3", "assistant-3"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: { ...baseConversation, messages: [{ id: "old", role: "user", content: "context", createdAt: "2026-01-01T00:00:00.000Z", state: "complete" }] },
      prompt: "Continue",
      selectedSkills: [{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "local only" }],
      onRecovery: assistant => recoveryNotifications.push(assistant.id)
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.sessionId).toBe("existing-session");
    expect(requests[1]?.sessionId).toBeUndefined();
    expect(requests[0]?.selectedSkills).toEqual([{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "local only" }]);
    expect(requests[1]?.selectedSkills).toEqual(requests[0]?.selectedSkills);
    expect(requests[1]?.recoveryTranscript).toContain("user: context");
    expect(recoveryNotifications).toEqual(["assistant-3"]);
    expect(result.assistant).toMatchObject({ state: "complete", content: "recovered" });
    expect(result.error).toBeUndefined();
  });

  it("keeps staged skill resources available through recovery and releases them afterward", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-recovery-skill-"));
    const source = path.join(root, "skills", "recovery");
    await mkdir(path.join(source, "references"), { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: recovery\ndescription: 恢复测试\n---\n\n读取 references/context.md。\n");
    await writeFile(path.join(source, "references", "context.md"), "recovery context");
    const catalog = new SkillCatalog({ directory: path.join(root, "skills") });
    const skillId = (await catalog.list()).skills.find(item => item.name === "recovery")?.id;
    let attempts = 0;
    let stagedDirectory = "";
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: {
        runTurn: async request => {
          attempts += 1;
          stagedDirectory = request.selectedSkills?.[0]?.resourceDirectory ?? "";
          await expect(access(path.join(stagedDirectory, "references", "context.md"))).resolves.toBeUndefined();
          if (attempts === 1) throw new Error("session expired");
          return { runId: request.runId, text: "recovered with resources", stopped: false };
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["resource-recovery-run", "resource-recovery-user", "resource-recovery-assistant"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await catalog.withSelection([skillId!], selectedSkills => controller.execute({
      conversation: baseConversation,
      prompt: "Recover with the selected skill",
      selectedSkills
    }));

    expect(attempts).toBe(2);
    expect(result.assistant.content).toBe("recovered with resources");
    await expect(access(stagedDirectory)).rejects.toThrow();
  });

  it("recovers without requiring a view callback", async () => {
    const requests: ClaudeTurnRequest[] = [];
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: {
        runTurn: async request => {
          requests.push(request);
          if (requests.length === 1) throw new Error("expired");
          return { runId: request.runId, text: "recovered", stopped: false };
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-no-callback", "user-no-callback", "assistant-no-callback"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    await expect(controller.execute({ conversation: baseConversation, prompt: "Continue", selectedSkills: [] })).resolves.toMatchObject({
      assistant: { state: "complete", content: "recovered" }
    });
    expect(requests).toHaveLength(2);
  });

  it("does not recover a resumable session after stopping has begun", async () => {
    const runTurn = vi.fn(async () => { throw new Error("interrupted"); });
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: { runTurn, getStatus: () => ({ state: "stopping" }) },
      createId: (() => {
        const ids = ["run-stopping", "user-stopping", "assistant-stopping"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    await expect(controller.execute({ conversation: baseConversation, prompt: "Stop", selectedSkills: [] })).resolves.toMatchObject({
      error: { message: "interrupted" },
      assistant: { state: "error", content: "interrupted" }
    });
    expect(runTurn).toHaveBeenCalledTimes(1);
  });

  it("reports deep-reading validation failures before terminal persistence", async () => {
    const saves: Conversation[] = [];
    const warnings: string[] = [];
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => {
          saves.push(structuredClone(conversation));
          return { ...conversation, revision: revision + 1 };
        }
      },
      runtime: { runTurn: async request => ({ runId: request.runId, text: "draft", stopped: false }), getStatus: () => ({ state: "idle" }) },
      deepReading: {
        skillId: MATERIAL_PAPER_DEEP_READING_SKILL_ID,
        finalize: async () => ({ repairs: [], issues: ["metadata missing"] }),
        validate: async () => ({ ok: false, issues: ["article missing"] })
      },
      createId: (() => {
        const ids = ["run-invalid", "user-invalid", "assistant-invalid"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: baseConversation,
      prompt: "Read deeply",
      selectedSkills: [{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "" }],
      onWarning: warning => warnings.push(warning)
    });

    expect(result.assistant.content).toContain("⚠️ 精读输出校验未通过：metadata missing；article missing");
    expect(warnings).toEqual(["精读输出校验未通过：metadata missing；article missing"]);
    expect(saves[1]?.messages[1]?.content).toContain("精读输出校验未通过");
  });

  it("does not finalize deep-reading output for a stopped result", async () => {
    const finalize = vi.fn(async () => ({ repairs: [], issues: [] }));
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: { runTurn: async request => ({ runId: request.runId, text: "partial", stopped: true }), getStatus: () => ({ state: "idle" }) },
      deepReading: {
        skillId: MATERIAL_PAPER_DEEP_READING_SKILL_ID,
        finalize,
        validate: async () => ({ ok: true, relativePath: "output/article.md" })
      },
      createId: (() => {
        const ids = ["run-stopped", "user-stopped", "assistant-stopped"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    await expect(controller.execute({
      conversation: baseConversation,
      prompt: "Read deeply",
      selectedSkills: [{ id: MATERIAL_PAPER_DEEP_READING_SKILL_ID, name: "Deep reading", instructions: "" }]
    })).resolves.toMatchObject({ assistant: { state: "stopped", content: "partial" } });
    expect(finalize).not.toHaveBeenCalled();
  });

  it("forwards runtime tool and warning events without treating them as assistant text", async () => {
    const tools: string[] = [];
    const warnings: string[] = [];
    const controller = new ConversationTurnController({
      conversations: { save: async (conversation, revision) => ({ ...conversation, revision: revision + 1 }) },
      runtime: {
        runTurn: async (request, observe) => {
          observe({ type: "tool", name: "Read", input: "paper.md" });
          observe({ type: "warning", message: "remote rate limit" });
          return { runId: request.runId, text: "done", stopped: false };
        },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-events", "user-events", "assistant-events"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({
      conversation: baseConversation,
      prompt: "Read",
      selectedSkills: [],
      onTool: (_assistant, event) => tools.push(event.name),
      onWarning: warning => warnings.push(warning)
    });

    expect(result.assistant.content).toBe("done");
    expect(tools).toEqual(["Read"]);
    expect(warnings).toEqual(["remote rate limit"]);
  });

  it("persists an actionable assistant error when a non-resumable run fails", async () => {
    const saves: Conversation[] = [];
    const controller = new ConversationTurnController({
      conversations: {
        save: async (conversation, revision) => {
          saves.push(structuredClone(conversation));
          return { ...conversation, revision: revision + 1 };
        }
      },
      runtime: {
        runTurn: async () => { throw new Error("runtime unavailable"); },
        getStatus: () => ({ state: "idle" })
      },
      createId: (() => {
        const ids = ["run-4", "user-4", "assistant-4"];
        return () => ids.shift() ?? "unexpected";
      })(),
      now: () => new Date("2026-01-02T00:00:00.000Z")
    });

    const result = await controller.execute({ conversation: { ...baseConversation, sessionId: undefined }, prompt: "Try", selectedSkills: [] });

    expect(result.error?.message).toBe("runtime unavailable");
    expect(result.assistant).toMatchObject({ state: "error", content: "runtime unavailable" });
    expect(saves).toHaveLength(2);
    expect(saves[1]?.messages[1]).toMatchObject({ state: "error", content: "runtime unavailable" });
  });
});
