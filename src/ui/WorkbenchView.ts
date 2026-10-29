import { ItemView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type PaperdianPlugin from "../main";
import { MATERIAL_PAPER_DEEP_READING_SKILL_ID, type SkillCatalogResult, type SkillDefinition } from "../skills/SkillCatalog";
import { finalizeDeepReadingOutput } from "../skills/DeepReadingOutputFinalizer";
import { validateDeepReadingOutput } from "../skills/DeepReadingOutputValidator";
import type { ChatMessage, Conversation } from "../storage/ConversationRepository";
import type { PreparedArticle } from "../wechat/WeChatArticlePipeline";
import { isWeChatThemeName, WECHAT_THEME_OPTIONS } from "../wechat/wechatThemes";
import { ArticlePublicationController } from "../workflows/ArticlePublicationController";
import { ConversationPreferenceController } from "../workflows/ConversationPreferenceController";
import { ConversationTurnController } from "../workflows/ConversationTurnController";
import {
  finalizeToolActivities,
  getSkillPopoverLayout,
  getWorkbenchLayoutMode,
  getWeChatPreviewBlockState,
  removeSelectedDocument,
  resetDocumentSelection,
  takeSelectedSkillIds,
  updateDocumentSelection,
  type ToolActivity,
  type WorkbenchDocumentSelection,
  type WorkbenchLayoutMode
} from "./WorkbenchPresentationState";

export const WORKBENCH_VIEW_TYPE = "paperdian-workbench";

interface WeChatElements {
  iframe: HTMLIFrameElement;
  status: HTMLElement;
  publish: HTMLButtonElement;
  recreate: HTMLButtonElement;
  normalize: HTMLButtonElement;
  theme: HTMLSelectElement;
}

export class WorkbenchView extends ItemView {
  private tab: "claude" | "wechat" = "claude";
  private conversation?: Conversation;
  private conversations: Conversation[] = [];
  private prepared?: PreparedArticle;
  private locked = false;
  private lockedFile?: TFile;
  private previewTimer?: number;
  private previewRevision = 0;
  private runId?: string;
  private preparingSkills = false;
  private rootEl?: HTMLElement;
  private surfaceEl?: HTMLElement;
  private claudeWorkspaceEl?: HTMLElement;
  private historyPanelEl?: HTMLElement;
  private historyListEl?: HTMLElement;
  private historySearchEl?: HTMLInputElement;
  private messagesEl?: HTMLElement;
  private composerEl?: HTMLTextAreaElement;
  private sendButtonEl?: HTMLButtonElement;
  private historyButtonEl?: HTMLButtonElement;
  private modelSelectEl?: HTMLSelectElement;
  private effortSelectEl?: HTMLSelectElement;
  private noteChipEl?: HTMLElement;
  private skillButtonEl?: HTMLButtonElement;
  private skillChipRowEl?: HTMLElement;
  private skillPopoverEl?: HTMLElement;
  private skillCatalog: SkillCatalogResult = { skills: [], diagnostics: [] };
  private readonly selectedSkillIds = new Set<string>();
  private readonly toolActivities = new Map<string, ToolActivity[]>();
  private resizeObserver?: ResizeObserver;
  private layoutMode: WorkbenchLayoutMode = "compact";
  private historyOpen = false;
  private documentSelection: WorkbenchDocumentSelection = {};
  private readonly historyPanelId = `paperdian-history-${crypto.randomUUID()}`;
  private messageRenderRevision = 0;
  private lastStreamRender = 0;
  private streamRenderTimer?: number;
  private readonly turnController: ConversationTurnController;
  private readonly preferenceController: ConversationPreferenceController;
  private readonly publicationController: ArticlePublicationController;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: PaperdianPlugin) {
    super(leaf);
    this.turnController = new ConversationTurnController({
      conversations: plugin.conversations,
      runtime: plugin.runtime,
      deepReading: {
        skillId: MATERIAL_PAPER_DEEP_READING_SKILL_ID,
        finalize: async input => {
          const attachmentResolver = await plugin.getAttachmentResolver();
          return finalizeDeepReadingOutput({ vaultPath: plugin.getVaultPath(), ...input, attachmentResolver });
        },
        validate: async input => {
          const attachmentResolver = await plugin.getAttachmentResolver();
          return validateDeepReadingOutput({ vaultPath: plugin.getVaultPath(), ...input, attachmentResolver });
        }
      },
      createId: () => crypto.randomUUID(),
      now: () => new Date()
    });
    this.preferenceController = new ConversationPreferenceController(plugin.conversations);
    this.publicationController = new ArticlePublicationController({
      preparePreview: (file, options) => plugin.pipeline.preparePreview(file, options),
      getDraftReceipt: prepared => plugin.getDraftReceipt(prepared),
      publish: (prepared, forceRecreate) => plugin.publish(prepared, forceRecreate)
    });
  }

  getViewType(): string { return WORKBENCH_VIEW_TYPE; }
  getDisplayText(): string { return "Paperdian"; }
  getIcon(): string { return "book-open-check"; }

  async onOpen(): Promise<void> {
    const host = this.contentEl;
    host.empty();
    host.addClass("paperdian-view");
    this.historyOpen = false;
    this.resetDocumentSelectionFromActiveFile();
    this.rootEl = host.createDiv({ cls: "paperdian-root" });
    this.renderShell();
    this.registerDomEvent(document, "pointerdown", event => {
      const target = event.target as Node | null;
      if (!target || this.skillPopoverEl?.contains(target) || this.skillButtonEl?.contains(target)) return;
      this.closeSkillPopover();
    });
    this.startResizeObserver();
    await this.showActiveSurface();
  }

  async onClose(): Promise<void> {
    if (this.previewTimer) window.clearTimeout(this.previewTimer);
    if (this.streamRenderTimer) window.clearTimeout(this.streamRenderTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.messageRenderRevision += 1;
  }

  onActiveFileChanged(file: TFile | null): void {
    this.documentSelection = updateDocumentSelection(this.documentSelection, file?.path, file?.extension === "md");
    if (this.tab === "claude") this.renderSelectedDocumentChip();
    if (this.tab !== "wechat" || this.locked || file?.extension !== "md") return;
    if (this.previewTimer) window.clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => { void this.refreshPreview(file); }, 400);
  }

  private renderShell(): void {
    if (!this.rootEl) return;
    const header = this.rootEl.createDiv({ cls: "paperdian-header" });
    const brand = header.createDiv({ cls: "paperdian-brand" });
    const brandIcon = brand.createSpan({ cls: "paperdian-brand-icon" });
    setIcon(brandIcon, "book-open-check");
    brand.createSpan({ cls: "paperdian-brand-text", text: "Paperdian" });

    const tabs = header.createDiv({ cls: "paperdian-tabs", attr: { role: "tablist", "aria-label": "工作台" } });
    for (const target of ["claude", "wechat"] as const) {
      const button = tabs.createEl("button", {
        cls: "paperdian-tab",
        attr: { type: "button", role: "tab", "aria-selected": String(this.tab === target) }
      });
      setIcon(button.createSpan(), target === "claude" ? "message-square" : "newspaper");
      button.createSpan({ text: target === "claude" ? "Claude" : "公众号" });
      button.toggleClass("is-active", this.tab === target);
      button.addEventListener("click", () => {
        if (this.tab === target) return;
        this.tab = target;
        for (const child of Array.from(tabs.children)) {
          const tabButton = child as HTMLButtonElement;
          const active = tabButton === button;
          tabButton.toggleClass("is-active", active);
          tabButton.setAttribute("aria-selected", String(active));
        }
        void this.showActiveSurface();
      });
    }
    this.surfaceEl = this.rootEl.createDiv({ cls: "paperdian-surface" });
  }

  private async showActiveSurface(): Promise<void> {
    if (!this.surfaceEl) return;
    this.surfaceEl.empty();
    this.closeSkillPopover();
    if (this.tab === "claude") await this.renderClaudeSurface();
    else await this.renderWeChatSurface();
  }

  private async renderClaudeSurface(): Promise<void> {
    if (!this.surfaceEl) return;
    await this.loadConversations();
    try { this.skillCatalog = await this.plugin.skills.list(); }
    catch (error) { this.skillCatalog = { skills: [], diagnostics: [{ path: "Skills", message: errorMessage(error) }] }; }

    this.claudeWorkspaceEl = this.surfaceEl.createDiv({ cls: "paperdian-claude-workspace" });
    const chatPanel = this.claudeWorkspaceEl.createEl("section", { cls: "paperdian-chat-panel" });
    const chatHeader = chatPanel.createDiv({ cls: "paperdian-chat-header" });
    const titleWrap = chatHeader.createDiv({ cls: "paperdian-chat-title-wrap" });
    titleWrap.createDiv({ cls: "paperdian-chat-title", text: this.conversation?.name ?? "新会话" });
    titleWrap.createDiv({ cls: "paperdian-chat-subtitle", text: this.runId ? "Claude 正在处理" : "Claude Code · Vault 工作区" });
    const newButton = iconButton(chatHeader, "plus", "新建会话");
    newButton.addEventListener("click", () => { void this.createAndOpenConversation(); });
    this.historyButtonEl = iconButton(chatHeader, "history", "打开会话历史", "paperdian-history-toggle");
    this.historyButtonEl.setAttribute("aria-controls", this.historyPanelId);
    this.historyButtonEl.addEventListener("click", () => this.setHistoryOpen(!this.historyOpen));

    const messagesWrapper = chatPanel.createDiv({ cls: "paperdian-messages-wrapper" });
    this.messagesEl = messagesWrapper.createDiv({ cls: "paperdian-messages", attr: { tabindex: "0" } });
    this.buildComposer(chatPanel);
    this.historyPanelEl = this.claudeWorkspaceEl.createEl("aside", {
      cls: "paperdian-history-panel",
      attr: { id: this.historyPanelId, "aria-label": "会话历史" }
    });
    this.renderHistoryPanel();
    this.applyLayoutMode(this.layoutMode);
    this.setRunningState(Boolean(this.runId));
    await this.renderMessages(true);
  }

  private async loadConversations(): Promise<void> {
    this.conversations = await this.plugin.conversations.list();
    if (this.conversation) {
      const refreshed = this.conversations.find(item => item.id === this.conversation?.id);
      if (refreshed && !this.runId) this.conversation = refreshed;
    }
    if (!this.conversation) this.conversation = this.conversations[0] ?? await this.createConversation();
    if (!this.conversations.some(item => item.id === this.conversation?.id)) this.conversations = [this.conversation, ...this.conversations];
  }

  private renderHistoryPanel(): void {
    if (!this.historyPanelEl) return;
    this.historyPanelEl.empty();
    const header = this.historyPanelEl.createDiv({ cls: "paperdian-history-header" });
    header.createSpan({ cls: "paperdian-history-title", text: "会话" });
    const close = iconButton(header, "x", "关闭历史", "paperdian-history-close");
    close.addEventListener("click", () => this.setHistoryOpen(false));
    const searchWrap = this.historyPanelEl.createDiv({ cls: "paperdian-history-search" });
    setIcon(searchWrap.createSpan(), "search");
    this.historySearchEl = searchWrap.createEl("input", { type: "search", attr: { placeholder: "搜索会话…", "aria-label": "搜索会话" } });
    this.historySearchEl.addEventListener("input", () => this.renderHistoryList());
    this.historyListEl = this.historyPanelEl.createDiv({ cls: "paperdian-history-list" });
    this.renderHistoryList();
  }

  private renderHistoryList(): void {
    if (!this.historyListEl) return;
    const query = this.historySearchEl?.value.trim().toLocaleLowerCase() ?? "";
    const visible = this.conversations.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
    this.historyListEl.empty();
    if (!visible.length) {
      this.historyListEl.createDiv({ cls: "paperdian-empty", text: "没有匹配的会话" });
      return;
    }
    for (const item of visible) {
      const row = this.historyListEl.createDiv({ cls: "paperdian-history-item" });
      row.toggleClass("is-active", item.id === this.conversation?.id);
      const open = row.createEl("button", { cls: "paperdian-history-main", attr: { type: "button" } });
      open.createDiv({ cls: "paperdian-history-name", text: item.name });
      open.createDiv({ cls: "paperdian-history-meta", text: formatConversationMeta(item) });
      open.addEventListener("click", () => { void this.openConversation(item.id); });
      const actions = row.createDiv({ cls: "paperdian-history-actions" });
      const rename = iconButton(actions, "pencil", "重命名会话");
      rename.addEventListener("click", () => { void this.renameConversation(item); });
      const remove = iconButton(actions, "trash-2", "删除会话");
      remove.addEventListener("click", () => { void this.deleteConversation(item); });
    }
  }

  private buildComposer(chatPanel: HTMLElement): void {
    const footer = chatPanel.createDiv({ cls: "paperdian-composer-footer" });
    const card = footer.createDiv({ cls: "paperdian-composer-card" });
    this.noteChipEl = card.createDiv({ cls: "paperdian-note-chip" });
    this.renderSelectedDocumentChip();
    this.skillChipRowEl = card.createDiv({ cls: "paperdian-skill-chips" });
    this.renderSelectedSkillChips();
    this.composerEl = card.createEl("textarea", {
      cls: "paperdian-composer",
      attr: { placeholder: "让 Claude 阅读、分析或修改当前材料…", rows: "3", dir: "auto" }
    });
    this.composerEl.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      void this.handlePrimaryAction();
    });

    const toolbar = card.createDiv({ cls: "paperdian-composer-toolbar" });
    const controls = toolbar.createDiv({ cls: "paperdian-composer-controls" });
    this.modelSelectEl = controls.createEl("select", { cls: "paperdian-toolbar-select", attr: { "aria-label": "模型" } });
    for (const model of availableModels(this.plugin.settings.claude.availableModels, this.conversation?.model, this.plugin.settings.claude.model)) {
      this.modelSelectEl.createEl("option", { value: model, text: model || "Claude 默认" });
    }
    this.modelSelectEl.value = this.conversation?.model ?? this.plugin.settings.claude.model;
    this.modelSelectEl.addEventListener("change", () => { void this.saveConversationPreferences({ model: this.modelSelectEl?.value || undefined }); });

    this.effortSelectEl = controls.createEl("select", { cls: "paperdian-toolbar-select", attr: { "aria-label": "思考强度" } });
    for (const effort of ["low", "medium", "high"] as const) this.effortSelectEl.createEl("option", { value: effort, text: `思考 ${effort}` });
    this.effortSelectEl.value = this.conversation?.effort ?? this.plugin.settings.claude.effort;
    this.effortSelectEl.addEventListener("change", () => { void this.saveConversationPreferences({ effort: this.effortSelectEl?.value as Conversation["effort"] }); });

    const skillWrap = controls.createDiv({ cls: "paperdian-skill-control" });
    this.skillButtonEl = skillWrap.createEl("button", { cls: "paperdian-skill-button", attr: { type: "button", "aria-haspopup": "dialog", "aria-expanded": "false" } });
    setIcon(this.skillButtonEl.createSpan(), "wrench");
    this.skillButtonEl.createSpan({ cls: "paperdian-skill-button-label", text: "Skills" });
    this.skillButtonEl.addEventListener("click", () => { void this.toggleSkillPopover(); });
    this.renderSelectedSkillChips();

    this.sendButtonEl = iconButton(toolbar, this.runId ? "square" : "arrow-up", this.runId ? "停止" : "发送", "paperdian-send-button");
    this.sendButtonEl.addEventListener("click", () => { void this.handlePrimaryAction(); });
  }

  private async toggleSkillPopover(): Promise<void> {
    if (this.skillPopoverEl) { this.closeSkillPopover(); return; }
    if (!this.rootEl) return;
    this.skillPopoverEl = this.rootEl.createDiv({ cls: "paperdian-skill-popover", attr: { role: "dialog", "aria-label": "选择 Skills" } });
    this.skillButtonEl?.setAttribute("aria-expanded", "true");
    const popover = this.skillPopoverEl;
    const search = this.skillPopoverEl.createEl("input", { type: "search", attr: { placeholder: "搜索 Skills…", "aria-label": "搜索 Skills" } });
    const list = this.skillPopoverEl.createDiv({ cls: "paperdian-skill-list" });
    const render = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      list.empty();
      const skills = this.skillCatalog.skills.filter(skill => !query || `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query));
      for (const skill of skills) this.renderSkillOption(list, skill);
      if (!skills.length) list.createDiv({ cls: "paperdian-empty", text: "没有匹配的 Skill" });
      if (this.skillCatalog.diagnostics.length) {
        const diagnostics = list.createEl("details", { cls: "paperdian-skill-diagnostics" });
        diagnostics.createEl("summary", { text: `${this.skillCatalog.diagnostics.length} 个 Skill 未载入` });
        for (const diagnostic of this.skillCatalog.diagnostics) diagnostics.createDiv({ text: `${diagnostic.path}：${diagnostic.message}` });
      }
    };
    search.addEventListener("input", render);
    try { this.skillCatalog = await this.plugin.skills.list(); }
    catch (error) { this.skillCatalog = { skills: [], diagnostics: [{ path: "Skills", message: errorMessage(error) }] }; }
    if (this.skillPopoverEl !== popover) return;
    render();
    this.positionSkillPopover();
    search.focus();
  }

  private renderSkillOption(list: HTMLElement, skill: SkillDefinition): void {
    const label = list.createEl("label", { cls: "paperdian-skill-option" });
    const checkbox = label.createEl("input", { type: "checkbox" });
    checkbox.checked = this.selectedSkillIds.has(skill.id);
    const content = label.createDiv({ cls: "paperdian-skill-option-content" });
    content.createDiv({ cls: "paperdian-skill-option-name", text: skill.name });
    content.createDiv({ cls: "paperdian-skill-option-description", text: skill.description });
    if (skill.source === "local") content.createDiv({ cls: "paperdian-skill-option-note", text: "完整目录将在本轮隔离加载" });
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) this.selectedSkillIds.add(skill.id);
      else this.selectedSkillIds.delete(skill.id);
      this.renderSelectedSkillChips();
      this.closeSkillPopover(true);
    });
  }

  private positionSkillPopover(): void {
    if (!this.rootEl || !this.skillButtonEl || !this.skillPopoverEl) return;
    const rootRect = this.rootEl.getBoundingClientRect();
    const buttonRect = this.skillButtonEl.getBoundingClientRect();
    const layout = getSkillPopoverLayout({
      rootWidth: rootRect.width,
      rootHeight: rootRect.height,
      anchorLeft: buttonRect.left - rootRect.left,
      anchorTop: buttonRect.top - rootRect.top
    });
    this.skillPopoverEl.style.left = `${layout.left}px`;
    this.skillPopoverEl.style.bottom = `${layout.bottom}px`;
    this.skillPopoverEl.style.width = `${layout.width}px`;
    this.skillPopoverEl.style.maxHeight = `${layout.maxHeight}px`;
  }

  private closeSkillPopover(restoreFocus = false): void {
    this.skillPopoverEl?.remove();
    this.skillPopoverEl = undefined;
    this.skillButtonEl?.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.skillButtonEl?.focus();
  }

  private renderSelectedSkillChips(): void {
    if (!this.skillChipRowEl) return;
    this.skillChipRowEl.empty();
    const selected = this.skillCatalog.skills.filter(skill => this.selectedSkillIds.has(skill.id));
    this.skillChipRowEl.toggleClass("is-empty", selected.length === 0);
    for (const skill of selected) {
      const chip = this.skillChipRowEl.createDiv({ cls: "paperdian-skill-chip" });
      setIcon(chip.createSpan(), "wrench");
      chip.createSpan({ text: skill.name });
      const remove = iconButton(chip, "x", `移除 ${skill.name}`);
      remove.addEventListener("click", () => {
        this.selectedSkillIds.delete(skill.id);
        this.renderSelectedSkillChips();
      });
    }
    if (this.skillButtonEl) {
      const label = this.skillButtonEl.querySelector(".paperdian-skill-button-label");
      label?.setText(selected.length ? `Skills ${selected.length}` : "Skills");
    }
  }

  private renderSelectedDocumentChip(): void {
    if (!this.noteChipEl) return;
    this.noteChipEl.empty();
    const path = this.documentSelection.selectedNotePath;
    this.noteChipEl.toggleClass("is-empty", !path);
    if (!path) return;
    setIcon(this.noteChipEl.createSpan({ cls: "paperdian-note-chip-icon" }), "file-text");
    this.noteChipEl.createSpan({ cls: "paperdian-note-chip-path", text: path, attr: { title: path } });
    const remove = iconButton(this.noteChipEl, "x", `移除文档 ${path}`);
    remove.addEventListener("click", () => {
      this.documentSelection = removeSelectedDocument(this.documentSelection);
      this.renderSelectedDocumentChip();
    });
  }

  private resetDocumentSelectionFromActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    this.documentSelection = resetDocumentSelection(file?.path, file?.extension === "md");
  }

  private async renderMessages(forceBottom = false): Promise<void> {
    if (!this.messagesEl || !this.conversation) return;
    const revision = ++this.messageRenderRevision;
    const messagesEl = this.messagesEl;
    const nearBottom = forceBottom || messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 96;
    messagesEl.empty();
    if (!this.conversation.messages.length) {
      const welcome = messagesEl.createDiv({ cls: "paperdian-welcome" });
      const icon = welcome.createDiv({ cls: "paperdian-welcome-icon" });
      setIcon(icon, "book-open-check");
      welcome.createDiv({ cls: "paperdian-welcome-title", text: "从当前材料开始" });
      welcome.createDiv({ cls: "paperdian-welcome-copy", text: "让 Claude 阅读论文、核对证据，或使用 Skill 生成结构化精读。" });
      if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
      return;
    }
    for (const message of this.conversation.messages) {
      const article = messagesEl.createEl("article", { cls: `paperdian-message is-${message.role}` });
      const header = article.createDiv({ cls: "paperdian-message-header" });
      header.createSpan({ text: message.role === "user" ? "你" : "Claude" });
      if (message.state && message.state !== "complete") header.createSpan({ cls: `paperdian-message-state is-${message.state}`, text: messageStateLabel(message.state) });
      const body = article.createDiv({ cls: "paperdian-message-body" });
      if (message.role === "user") body.setText(message.content);
      else if (message.content) await MarkdownRenderer.render(this.app, message.content, body, "", this);
      else body.createDiv({ cls: "paperdian-thinking", text: "正在思考…" });
      this.renderToolActivities(article, message.id);
      if (revision !== this.messageRenderRevision) return;
    }
    if (nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  private renderToolActivities(messageEl: HTMLElement, messageId: string): void {
    const activities = this.toolActivities.get(messageId);
    if (!activities?.length) return;
    const list = messageEl.createDiv({ cls: "paperdian-tool-list" });
    for (const activity of activities) {
      const item = list.createEl("details", { cls: `paperdian-tool is-${activity.status}` });
      const summary = item.createEl("summary");
      const icon = summary.createSpan({ cls: "paperdian-tool-icon" });
      setIcon(icon, activity.status === "running" ? "loader-circle" : activity.status === "complete" ? "check" : activity.status === "stopped" ? "square" : "circle-x");
      summary.createSpan({ text: activity.name });
      summary.createSpan({ cls: "paperdian-tool-status", text: toolStatusLabel(activity.status) });
      if (activity.input !== undefined) item.createEl("pre", { text: formatToolInput(activity.input) });
    }
  }

  private scheduleMessageRender(): void {
    const elapsed = Date.now() - this.lastStreamRender;
    if (elapsed >= 80) {
      this.lastStreamRender = Date.now();
      void this.renderMessages();
      return;
    }
    if (this.streamRenderTimer) return;
    this.streamRenderTimer = window.setTimeout(() => {
      this.streamRenderTimer = undefined;
      this.lastStreamRender = Date.now();
      void this.renderMessages();
    }, 80 - elapsed);
  }

  private async handlePrimaryAction(): Promise<void> {
    if (this.runId) { await this.plugin.runtime.cancel(this.runId); return; }
    if (this.preparingSkills) return;
    const prompt = this.composerEl?.value.trim() ?? "";
    if (!prompt || !this.conversation) return;
    await this.sendTurn(prompt);
  }

  private async sendTurn(prompt: string): Promise<void> {
    await this.preferenceController.whenIdle();
    if (!this.conversation) return;
    this.preparingSkills = true;
    this.setRunningState(true);
    try {
      await this.plugin.skills.withSelection([...this.selectedSkillIds], async selectedSkills => {
        const result = await this.turnController.execute({
          conversation: this.conversation!,
          prompt,
          sourceNotePath: this.documentSelection.selectedNotePath,
          selectedSkills,
          defaultModel: this.plugin.settings.claude.model,
          defaultEffort: this.plugin.settings.claude.effort,
          onRunStarted: runId => { this.runId = runId; },
          onConversationPersisted: conversation => {
            this.conversation = conversation;
            this.preferenceController.setConversation(conversation);
          },
          onTurnStarted: async () => {
            if (this.composerEl) this.composerEl.value = "";
            takeSelectedSkillIds(this.selectedSkillIds);
            this.renderSelectedSkillChips();
            this.closeSkillPopover();
            await this.refreshConversationList();
            await this.renderMessages(true);
          },
          onAssistantUpdate: () => this.scheduleMessageRender(),
          onTool: (assistant, event) => {
            const activities = this.toolActivities.get(assistant.id) ?? [];
            activities.push({ name: event.name, input: event.input, status: "running" });
            this.toolActivities.set(assistant.id, activities);
            this.scheduleMessageRender();
          },
          onWarning: message => new Notice(message, 8_000),
          onRecovery: assistant => {
            this.toolActivities.delete(assistant.id);
            this.scheduleMessageRender();
          }
        });
        const activityStatus = result.assistant.state === "stopped" ? "stopped" : result.assistant.state === "error" ? "error" : "complete";
        this.toolActivities.set(result.assistant.id, finalizeToolActivities(this.toolActivities.get(result.assistant.id) ?? [], activityStatus));
        if (result.error) new Notice(errorMessage(result.error), 8_000);
      });
    } catch (error) {
      new Notice(errorMessage(error), 8_000);
    } finally {
      this.preparingSkills = false;
      this.runId = undefined;
      this.setRunningState(false);
      await this.refreshConversationList();
      await this.renderMessages(true);
    }
  }

  private setRunningState(running: boolean): void {
    if (this.composerEl) this.composerEl.disabled = running;
    if (this.modelSelectEl) this.modelSelectEl.disabled = running;
    if (this.effortSelectEl) this.effortSelectEl.disabled = running;
    if (this.skillButtonEl) this.skillButtonEl.disabled = running;
    if (this.sendButtonEl) {
      this.sendButtonEl.empty();
      setIcon(this.sendButtonEl, running ? "square" : "arrow-up");
      this.sendButtonEl.setAttribute("aria-label", running ? "停止" : "发送");
      this.sendButtonEl.setAttribute("title", running ? "停止" : "发送");
      this.sendButtonEl.toggleClass("is-running", running);
    }
  }

  private saveConversationPreferences(patch: Pick<Conversation, "model" | "effort">): Promise<void> {
    if (!this.conversation) return Promise.resolve();
    const conversationId = this.conversation.id;
    return this.preferenceController.save(this.conversation, patch, Boolean(this.runId)).then(async result => {
      if (this.conversation?.id !== conversationId) return;
      this.conversation = result.conversation;
      await this.refreshConversationList();
      if (result.kind === "failed") {
        if (this.modelSelectEl) this.modelSelectEl.value = this.conversation.model ?? this.plugin.settings.claude.model;
        if (this.effortSelectEl) this.effortSelectEl.value = this.conversation.effort ?? this.plugin.settings.claude.effort;
        new Notice(errorMessage(result.error), 8_000);
      }
    });
  }

  private async refreshConversationList(): Promise<void> {
    this.conversations = await this.plugin.conversations.list();
    this.renderHistoryList();
  }

  private async openConversation(id: string): Promise<void> {
    if (this.runId) { new Notice("请先停止当前 Claude 任务。", 5_000); return; }
    const conversation = await this.plugin.conversations.get(id);
    if (!conversation) { new Notice("会话已不存在。", 5_000); await this.refreshConversationList(); return; }
    this.conversation = conversation;
    this.resetDocumentSelectionFromActiveFile();
    if (this.layoutMode === "compact") this.setHistoryOpen(false);
    await this.renderClaudeSurfaceIntoExistingShell();
  }

  private async createAndOpenConversation(): Promise<void> {
    if (this.runId) { new Notice("请先停止当前 Claude 任务。", 5_000); return; }
    this.conversation = await this.createConversation();
    this.resetDocumentSelectionFromActiveFile();
    await this.refreshConversationList();
    if (this.layoutMode === "compact") this.setHistoryOpen(false);
    await this.renderClaudeSurfaceIntoExistingShell();
  }

  private async renderClaudeSurfaceIntoExistingShell(): Promise<void> {
    if (!this.surfaceEl || this.tab !== "claude") return;
    this.closeSkillPopover();
    this.surfaceEl.empty();
    await this.renderClaudeSurface();
  }

  private async renameConversation(item: Conversation): Promise<void> {
    if (this.runId && item.id === this.conversation?.id) { new Notice("请先停止当前 Claude 任务。", 5_000); return; }
    const name = window.prompt("会话名称", item.name)?.trim();
    if (!name || name === item.name) return;
    try {
      const saved = await this.plugin.conversations.save({ ...item, name }, item.revision);
      if (this.conversation?.id === saved.id) this.conversation = saved;
      await this.refreshConversationList();
      if (this.conversation?.id === saved.id) await this.renderClaudeSurfaceIntoExistingShell();
    } catch (error) { new Notice(errorMessage(error), 8_000); await this.refreshConversationList(); }
  }

  private async deleteConversation(item: Conversation): Promise<void> {
    if (this.runId && item.id === this.conversation?.id) { new Notice("请先停止当前 Claude 任务。", 5_000); return; }
    if (!window.confirm(`删除会话“${item.name}”？`)) return;
    await this.plugin.conversations.delete(item.id);
    if (this.conversation?.id === item.id) {
      this.conversation = undefined;
      this.resetDocumentSelectionFromActiveFile();
    }
    await this.loadConversations();
    await this.renderClaudeSurfaceIntoExistingShell();
  }

  private async createConversation(): Promise<Conversation> {
    const timestamp = new Date().toISOString();
    return this.plugin.conversations.save({
      id: crypto.randomUUID(),
      name: "新会话",
      revision: 0,
      model: this.plugin.settings.claude.model || undefined,
      effort: this.plugin.settings.claude.effort,
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp
    }, 0);
  }

  private startResizeObserver(): void {
    if (!this.rootEl || typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(entries => {
      const width = entries.at(-1)?.contentRect.width ?? this.rootEl?.getBoundingClientRect().width ?? 0;
      this.applyLayoutMode(getWorkbenchLayoutMode(width));
      this.positionSkillPopover();
    });
    this.resizeObserver.observe(this.rootEl);
    this.applyLayoutMode(getWorkbenchLayoutMode(this.rootEl.getBoundingClientRect().width));
  }

  private applyLayoutMode(mode: WorkbenchLayoutMode): void {
    this.layoutMode = mode;
    this.rootEl?.toggleClass("is-wide", mode === "wide");
    this.rootEl?.toggleClass("is-compact", mode === "compact");
    this.claudeWorkspaceEl?.toggleClass("is-history-open", this.historyOpen);
    this.syncHistoryAccessibility();
  }

  private setHistoryOpen(open: boolean): void {
    this.historyOpen = open;
    this.claudeWorkspaceEl?.toggleClass("is-history-open", this.historyOpen);
    this.syncHistoryAccessibility();
  }

  private syncHistoryAccessibility(): void {
    this.historyButtonEl?.setAttribute("aria-expanded", String(this.historyOpen));
    this.historyButtonEl?.setAttribute("aria-label", this.historyOpen ? "关闭会话历史" : "打开会话历史");
    this.historyButtonEl?.setAttribute("title", this.historyOpen ? "关闭会话历史" : "打开会话历史");
    this.historyPanelEl?.setAttribute("aria-hidden", String(!this.historyOpen));
  }

  private async renderWeChatSurface(): Promise<void> {
    if (!this.surfaceEl) return;
    const panel = this.surfaceEl.createDiv({ cls: "paperdian-wechat-panel" });
    const header = panel.createDiv({ cls: "paperdian-wechat-header" });
    const heading = header.createDiv();
    heading.createDiv({ cls: "paperdian-wechat-title", text: "公众号预览" });
    heading.createDiv({ cls: "paperdian-wechat-subtitle", text: "冻结当前 Markdown 快照并创建草稿" });
    const controls = header.createDiv({ cls: "paperdian-wechat-controls" });
    const themeLabel = controls.createEl("label", { cls: "paperdian-theme-label" });
    themeLabel.createSpan({ text: "主题" });
    const theme = themeLabel.createEl("select", { cls: "paperdian-theme-select", attr: { "aria-label": "公众号主题" } });
    for (const option of WECHAT_THEME_OPTIONS) theme.createEl("option", { value: option.name, text: option.label });
    theme.value = this.plugin.settings.wechat.theme;
    const lockLabel = controls.createEl("label", { cls: "paperdian-toggle-label" });
    const lock = lockLabel.createEl("input", { type: "checkbox" });
    lock.checked = this.locked;
    lockLabel.createSpan({ text: "锁定文章" });
    lock.addEventListener("change", () => {
      this.locked = lock.checked;
      this.lockedFile = this.locked ? this.app.workspace.getActiveFile() ?? undefined : undefined;
    });
    const refresh = iconButton(controls, "refresh-cw", "刷新预览", "paperdian-secondary-button");
    const normalize = controls.createEl("button", { cls: "paperdian-secondary-action", text: "下载并规范化当前文件附件", attr: { type: "button" } });

    const status = panel.createDiv({ cls: "paperdian-status", text: "正在准备预览…" });
    const iframe = panel.createEl("iframe", { cls: "paperdian-preview", attr: { sandbox: "" } });
    const publishRow = panel.createDiv({ cls: "paperdian-publish-row" });
    const publish = publishRow.createEl("button", { cls: "paperdian-primary-action", text: "创建公众号草稿", attr: { disabled: "true" } });
    const recreate = publishRow.createEl("button", { cls: "paperdian-secondary-action", text: "重新创建草稿", attr: { disabled: "true" } });
    const elements = { iframe, status, publish, recreate, normalize, theme };
    theme.addEventListener("change", () => {
      if (!isWeChatThemeName(theme.value)) return;
      this.previewRevision += 1;
      this.prepared = undefined;
      applyWeChatPreviewBlock(elements, false);
      status.setText("正在切换公众号主题…");
      theme.disabled = true;
      this.plugin.settings.wechat.theme = theme.value;
      void this.plugin.saveSettings()
        .then(() => this.refreshPreview(this.lockedFile ?? this.app.workspace.getActiveFile(), elements))
        .catch((error: unknown) => { status.setText(errorMessage(error)); })
        .finally(() => { theme.disabled = false; });
    });
    refresh.addEventListener("click", () => { void this.refreshPreview(this.lockedFile ?? this.app.workspace.getActiveFile(), elements); });
    normalize.addEventListener("click", () => { void this.normalizeAttachments(this.lockedFile ?? this.app.workspace.getActiveFile(), elements); });
    const doPublish = async (forceRecreate: boolean): Promise<void> => {
      if (!this.prepared) return;
      publish.disabled = true;
      recreate.disabled = true;
      status.setText("正在上传冻结快照…");
      const result = await this.publicationController.publish(this.prepared, forceRecreate);
      if (result.kind === "published") {
        const receipt = result.receipt;
        status.empty();
        status.createDiv({ text: `草稿创建成功：${receipt.mediaId ?? ""}` });
        if (this.prepared.warnings?.length) status.createDiv({ cls: "paperdian-warnings", text: `⚠️ 图片提醒：${this.prepared.warnings.join("；")}` });
        publish.disabled = result.publishDisabled;
        recreate.disabled = !result.recreateEnabled;
        new Notice("公众号草稿已创建。请到公众号后台人工复核。", 8_000);
      } else {
        status.setText(errorMessage(result.error));
        publish.disabled = result.publishDisabled;
        recreate.disabled = !result.recreateEnabled;
      }
    };
    publish.addEventListener("click", () => { void doPublish(false); });
    recreate.addEventListener("click", () => { void doPublish(true); });
    await this.refreshPreview(this.lockedFile ?? this.app.workspace.getActiveFile(), elements);
  }

  private async normalizeAttachments(file: TFile | null, elements: WeChatElements): Promise<void> {
    if (!file || file.extension !== "md") {
      new Notice("请选择一篇 Markdown 笔记。", 5_000);
      return;
    }
    elements.normalize.disabled = true;
    elements.status.setText("正在下载并规范化附件…");
    try {
      const result = await this.plugin.normalizeCurrentFileAttachments(file);
      const summary = `附件处理完成：下载 ${result.downloadedCount}，转换 ${result.convertedCount}，未变更 ${result.unchangedCount}${result.failures.length ? `，失败 ${result.failures.length}` : ""}`;
      new Notice(result.failures.length ? `${summary}。${result.failures.map(item => `${item.reference}：${item.message}`).join("；")}` : summary, 8_000);
      await this.refreshPreview(file, elements);
    } catch (error) {
      elements.status.setText(errorMessage(error));
      new Notice(errorMessage(error), 8_000);
    } finally {
      elements.normalize.disabled = false;
    }
  }

  private async refreshPreview(file: TFile | null, existing?: WeChatElements): Promise<void> {
    const revision = ++this.previewRevision;
    if (!file || file.extension !== "md") {
      this.prepared = undefined;
      if (existing) {
        applyWeChatPreviewBlock(existing, false);
        existing.status.setText("请选择一篇 Markdown 笔记。");
      }
      return;
    }
    const result = await this.publicationController.prepare({
      sourcePath: file.path,
      author: this.plugin.settings.wechat.author,
      theme: this.plugin.settings.wechat.theme
    });
    if (revision !== this.previewRevision) return;
    if (!existing) {
      if (this.tab === "wechat") await this.showActiveSurface();
      return;
    }
    existing.normalize.disabled = false;
    if (result.kind === "ready") {
      this.prepared = result.prepared;
      existing.iframe.srcdoc = result.previewHtml;
      const receipt = result.receipt;
      const suffix = receipt ? ` · 已有${receipt.status === "success" ? "成功" : receipt.status === "unknown" ? "结果未知" : "失败"}回执` : "";
      existing.status.empty();
      existing.status.createDiv({ text: `${file.path} · ${result.prepared.images.length} 张正文图片 · 快照 ${result.prepared.sourceHash.slice(0, 10)}${suffix}` });
      if (result.warnings?.length) existing.status.createDiv({ cls: "paperdian-warnings", text: `⚠️ 图片提醒：${result.warnings.join("；")}` });
      existing.publish.disabled = result.publishDisabled;
      existing.recreate.disabled = !result.recreateEnabled;
      return;
    }
    this.prepared = undefined;
    if (result.kind === "blocked") {
      existing.iframe.srcdoc = result.previewHtml;
      existing.status.empty();
      existing.status.createDiv({ cls: "paperdian-errors", text: `${file.path} · ${result.imageCount} 张正文图片 · 预览可用，但暂不能创建草稿：${result.blockers.join("；")}` });
      if (result.warnings?.length) existing.status.createDiv({ cls: "paperdian-warnings", text: `⚠️ 图片提醒：${result.warnings.join("；")}` });
      applyWeChatPreviewBlock(existing, true);
      return;
    }
    applyWeChatPreviewBlock(existing, false);
    existing.status.empty();
    existing.status.createDiv({ cls: "paperdian-errors", text: errorMessage(result.error) });
  }
}

function applyWeChatPreviewBlock(elements: WeChatElements, previewAvailable: boolean): void {
  const state = getWeChatPreviewBlockState(previewAvailable);
  if (state.clearPreview) elements.iframe.srcdoc = "";
  elements.publish.disabled = state.publishDisabled;
  elements.recreate.disabled = state.recreateDisabled;
}

function iconButton(parent: HTMLElement, icon: string, label: string, extraClass = ""): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: `paperdian-icon-button ${extraClass}`.trim(),
    attr: { type: "button", "aria-label": label, title: label }
  });
  setIcon(button, icon);
  return button;
}

function formatConversationMeta(conversation: Conversation): string {
  const date = new Date(conversation.updatedAt);
  const dateLabel = Number.isNaN(date.valueOf()) ? "" : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${dateLabel}${dateLabel ? " · " : ""}${conversation.messages.length} 条消息`;
}

function availableModels(configured: string[], conversationModel?: string, defaultModel?: string): string[] {
  return [...new Set(["", ...configured, defaultModel ?? "", conversationModel ?? ""].map(model => model.trim()))];
}

function messageStateLabel(state: NonNullable<ChatMessage["state"]>): string {
  if (state === "streaming") return "生成中";
  if (state === "stopped") return "已停止";
  if (state === "error") return "失败";
  return "";
}

function toolStatusLabel(status: ToolActivity["status"]): string {
  if (status === "running") return "运行中";
  if (status === "complete") return "完成";
  if (status === "stopped") return "已停止";
  return "失败";
}

function formatToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  try { return JSON.stringify(input, null, 2); }
  catch { return String(input); }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
