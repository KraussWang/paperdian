import type { ClaudeRuntimeEvent, ClaudeRuntimeStatus, ClaudeTurnRequest, ClaudeTurnResult } from "../claude/ClaudeRuntime";
import type { SelectedSkillSnapshot } from "../skills/SkillCatalog";
import type { ChatMessage, Conversation } from "../storage/ConversationRepository";

export interface ConversationTurnRepository {
  save(conversation: Conversation, expectedRevision: number): Promise<Conversation>;
}

export interface ConversationTurnRuntime {
  runTurn(request: ClaudeTurnRequest, observer: (event: ClaudeRuntimeEvent) => void): Promise<ClaudeTurnResult>;
  getStatus(): ClaudeRuntimeStatus;
}

export interface ConversationTurnDependencies {
  conversations: ConversationTurnRepository;
  runtime: ConversationTurnRuntime;
  deepReading?: DeepReadingWorkflow;
  createId(): string;
  now(): Date;
}

export interface DeepReadingWorkflow {
  skillId: string;
  finalize(input: { sourceNotePath?: string; startedAt: Date }): Promise<{ repairs: string[]; issues: string[] }>;
  validate(input: { sourceNotePath?: string; startedAt: Date }): Promise<{ ok: true; relativePath: string; warnings?: string[] } | { ok: false; issues: string[] }>;
}

export interface ConversationTurnInput {
  conversation: Conversation;
  prompt: string;
  sourceNotePath?: string;
  selectedSkills: SelectedSkillSnapshot[];
  defaultModel?: string;
  defaultEffort?: Conversation["effort"];
  onRunStarted?(runId: string): void;
  onTurnStarted?(conversation: Conversation, assistant: ChatMessage): void | Promise<void>;
  onConversationPersisted?(conversation: Conversation): void;
  onAssistantUpdate?(assistant: ChatMessage): void;
  onTool?(assistant: ChatMessage, event: Extract<ClaudeRuntimeEvent, { type: "tool" }>): void;
  onWarning?(message: string): void;
  onRecovery?(assistant: ChatMessage): void;
}

export interface ConversationTurnResult {
  conversation: Conversation;
  assistant: ChatMessage;
  error?: Error;
}

export class ConversationTurnController {
  constructor(private readonly dependencies: ConversationTurnDependencies) {}

  async execute(input: ConversationTurnInput): Promise<ConversationTurnResult> {
    const startedAt = this.dependencies.now();
    const timestamp = startedAt.toISOString();
    const runId = this.dependencies.createId();
    input.onRunStarted?.(runId);
    const user: ChatMessage = { id: this.dependencies.createId(), role: "user", content: input.prompt, createdAt: timestamp, state: "complete" };
    let assistant: ChatMessage = { id: this.dependencies.createId(), role: "assistant", content: "", createdAt: timestamp, state: "streaming" };
    let conversation = input.conversation;
    let persisted = false;

    try {
      conversation = await this.dependencies.conversations.save({
        ...conversation,
        messages: [...conversation.messages, user, assistant]
      }, conversation.revision);
      assistant = findAssistant(conversation, assistant.id) ?? assistant;
      persisted = true;
      input.onConversationPersisted?.(conversation);
      await input.onTurnStarted?.(conversation, assistant);

      const result = await this.executeWithRecovery({ input, conversation, assistant, runId });
      assistant.content = result.text;
      assistant.state = result.stopped ? "stopped" : "complete";
      if (!result.stopped) await this.finalizeDeepReadingOutput(input, assistant, startedAt);
      input.onAssistantUpdate?.(assistant);
      conversation = await this.dependencies.conversations.save({
        ...conversation,
        sessionId: result.sessionId ?? conversation.sessionId,
        messages: conversation.messages
      }, conversation.revision);
      assistant = findAssistant(conversation, assistant.id) ?? assistant;
      input.onConversationPersisted?.(conversation);
      return { conversation, assistant };
    } catch (error) {
      const failure = asError(error);
      assistant.state = "error";
      assistant.content ||= failure.message;
      input.onAssistantUpdate?.(assistant);
      if (persisted) {
        try {
          conversation = await this.dependencies.conversations.save({ ...conversation, messages: conversation.messages }, conversation.revision);
          assistant = findAssistant(conversation, assistant.id) ?? assistant;
          input.onConversationPersisted?.(conversation);
        } catch { /* The run failure is more actionable than a best-effort save failure. */ }
      }
      return { conversation, assistant, error: failure };
    }
  }

  private async executeWithRecovery(context: { input: ConversationTurnInput; conversation: Conversation; assistant: ChatMessage; runId: string }): Promise<ClaudeTurnResult> {
    const execute = async (resume: boolean, recoveryTranscript?: string): Promise<ClaudeTurnResult> => this.dependencies.runtime.runTurn({
      runId: context.runId,
      prompt: context.input.prompt,
      currentNotePath: context.input.sourceNotePath,
      sessionId: resume ? context.conversation.sessionId : undefined,
      model: (context.conversation.model ?? context.input.defaultModel) || undefined,
      effort: context.conversation.effort ?? context.input.defaultEffort,
      permissionMode: "acceptEdits",
      selectedSkills: context.input.selectedSkills,
      recoveryTranscript
    }, event => this.observeRuntimeEvent(context.input, context.assistant, event));

    try {
      return await execute(Boolean(context.conversation.sessionId));
    } catch (error) {
      if (!context.conversation.sessionId || this.dependencies.runtime.getStatus().state === "stopping") throw error;
      context.assistant.content = "";
      context.input.onRecovery?.(context.assistant);
      return execute(false, recoveryTranscript(context.conversation.messages));
    }
  }

  private observeRuntimeEvent(input: ConversationTurnInput, assistant: ChatMessage, event: ClaudeRuntimeEvent): void {
    if (event.type === "text-delta") {
      assistant.content += event.text;
      input.onAssistantUpdate?.(assistant);
    } else if (event.type === "tool") input.onTool?.(assistant, event);
    else if (event.type === "warning") input.onWarning?.(event.message);
  }

  private async finalizeDeepReadingOutput(input: ConversationTurnInput, assistant: ChatMessage, startedAt: Date): Promise<void> {
    const workflow = this.dependencies.deepReading;
    if (!workflow || !input.selectedSkills.some(skill => skill.id === workflow.skillId)) return;
    const request = { sourceNotePath: input.sourceNotePath, startedAt };
    const finalized = await workflow.finalize(request);
    const validation = await workflow.validate(request);
    if (validation.ok) {
      const repairStatus = finalized.repairs.length ? `；自动修复：${finalized.repairs.join("、")}` : "";
      const warnings = [...new Set([...finalized.issues, ...(validation.warnings ?? [])])];
      const warningStatus = warnings.length ? `；格式提醒（不影响创建公众号草稿）：${warnings.join("；")}` : "";
      assistant.content = appendDeliveryStatus(assistant.content, `已生成精读输出：\`${validation.relativePath}\`${repairStatus}${warningStatus}`);
      return;
    }
    const issues = [...new Set([...finalized.issues, ...validation.issues])];
    const message = `精读输出校验未通过：${issues.join("；")}`;
    assistant.content = appendDeliveryStatus(assistant.content, `⚠️ ${message}`);
    input.onWarning?.(message);
  }
}

function findAssistant(conversation: Conversation, id: string): ChatMessage | undefined {
  return conversation.messages.find(message => message.id === id);
}

function recoveryTranscript(messages: ChatMessage[]): string {
  return messages.slice(-12).map(message => `${message.role}: ${message.content}`).join("\n").slice(-30_000);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function appendDeliveryStatus(content: string, status: string): string {
  return `${content.trimEnd()}\n\n---\n\n${status}`;
}
