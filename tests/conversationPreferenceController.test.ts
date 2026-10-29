import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../src/storage/ConversationRepository";
import { ConversationPreferenceController } from "../src/workflows/ConversationPreferenceController";

const conversation: Conversation = {
  id: "conversation-1",
  name: "Paper notes",
  revision: 3,
  messages: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("ConversationPreferenceController", () => {
  it("skips preference persistence while the turn is running", async () => {
    const save = vi.fn();
    const controller = new ConversationPreferenceController({ save, get: async () => undefined });

    await expect(controller.save(conversation, { model: "claude-opus" }, true)).resolves.toEqual({ kind: "skipped", conversation });
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the latest revision when a stale view update arrives before persistence", async () => {
    const saved: Array<{ revision: number; model?: string; effort?: string }> = [];
    const controller = new ConversationPreferenceController({
      save: async (value, revision) => {
        saved.push({ revision, model: value.model, effort: value.effort });
        return { ...value, revision: revision + 1 };
      },
      get: async () => undefined
    });
    const latest = { ...conversation, revision: 4, model: "claude-opus" };

    controller.setConversation(latest);
    controller.setConversation(conversation);

    await expect(controller.save(conversation, { effort: "low" }, false)).resolves.toMatchObject({
      kind: "saved",
      conversation: { revision: 5, model: "claude-opus", effort: "low" }
    });
    expect(saved).toEqual([{ revision: 4, model: "claude-opus", effort: "low" }]);
  });

  it("returns the reloaded conversation after a persistence failure", async () => {
    const reloaded = { ...conversation, revision: 4, model: "claude-haiku" };
    const controller = new ConversationPreferenceController({
      save: async () => { throw new Error("revision conflict"); },
      get: async id => id === conversation.id ? reloaded : undefined
    });

    await expect(controller.save(conversation, { model: "claude-opus" }, false)).resolves.toMatchObject({
      kind: "failed",
      conversation: reloaded,
      error: { message: "revision conflict" }
    });
  });

  it("does not redirect an already queued preference save after the view selects another conversation", async () => {
    const savedIds: string[] = [];
    let releaseSave: (() => void) | undefined;
    const controller = new ConversationPreferenceController({
      save: async (value, revision) => {
        savedIds.push(value.id);
        await new Promise<void>(resolve => { releaseSave = resolve; });
        return { ...value, revision: revision + 1 };
      },
      get: async () => undefined
    });
    const otherConversation = { ...conversation, id: "conversation-2", revision: 8 };

    const pending = controller.save(conversation, { model: "claude-opus" }, false);
    controller.setConversation(otherConversation);
    await vi.waitFor(() => expect(releaseSave).toBeTypeOf("function"));
    expect(savedIds).toEqual([conversation.id]);
    releaseSave?.();

    await expect(pending).resolves.toMatchObject({ kind: "saved", conversation: { id: conversation.id, model: "claude-opus" } });
  });

  it("serializes rapid preference changes against the latest saved revision", async () => {
    const revisions: number[] = [];
    const controller = new ConversationPreferenceController({
      save: async (value, revision) => {
        revisions.push(revision);
        return { ...value, revision: revision + 1 };
      },
      get: async () => undefined
    });

    const model = controller.save(conversation, { model: "claude-opus" }, false);
    const effort = controller.save(conversation, { effort: "low" }, false);
    const [modelResult, effortResult] = await Promise.all([model, effort]);

    expect(revisions).toEqual([3, 4]);
    expect(modelResult).toMatchObject({ kind: "saved", conversation: { model: "claude-opus", revision: 4 } });
    expect(effortResult).toMatchObject({ kind: "saved", conversation: { model: "claude-opus", effort: "low", revision: 5 } });
  });
});
