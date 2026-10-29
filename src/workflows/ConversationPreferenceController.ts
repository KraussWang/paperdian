import type { Conversation } from "../storage/ConversationRepository";

export interface ConversationPreferenceRepository {
  save(conversation: Conversation, expectedRevision: number): Promise<Conversation>;
  get(id: string): Promise<Conversation | undefined>;
}

export type ConversationPreferenceResult =
  | { kind: "saved"; conversation: Conversation }
  | { kind: "skipped"; conversation: Conversation }
  | { kind: "failed"; conversation: Conversation; error: Error };

export class ConversationPreferenceController {
  private queue: Promise<void> = Promise.resolve();
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly repository: ConversationPreferenceRepository) {}

  setConversation(conversation: Conversation | undefined): void {
    if (!conversation) return;
    const current = this.conversations.get(conversation.id);
    if (!current || current.revision <= conversation.revision) this.conversations.set(conversation.id, conversation);
  }

  async whenIdle(): Promise<void> {
    await this.queue;
  }

  save(conversation: Conversation, patch: Pick<Conversation, "model" | "effort">, running: boolean): Promise<ConversationPreferenceResult> {
    if (running) return Promise.resolve({ kind: "skipped", conversation });
    this.setConversation(conversation);
    const task = this.queue.then(() => this.persist(conversation.id, patch));
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(id: string, patch: Pick<Conversation, "model" | "effort">): Promise<ConversationPreferenceResult> {
    const previous = this.conversations.get(id);
    if (!previous) throw new Error("保存会话偏好时缺少当前会话。");
    try {
      const conversation = await this.repository.save({ ...previous, ...patch }, previous.revision);
      this.conversations.set(id, conversation);
      return { kind: "saved", conversation };
    } catch (error) {
      const conversation = await this.repository.get(previous.id) ?? previous;
      this.conversations.set(id, conversation);
      return { kind: "failed", conversation, error: asError(error) };
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
