import { FileSystemAdapter, Notice, Plugin, requestUrl, TFile, type WorkspaceLeaf } from "obsidian";
import path from "node:path";
import { AttachmentNormalizer, type AttachmentNormalizationResult, type AttachmentVault } from "./attachments/AttachmentNormalizer";
import { VaultAttachmentResolver, readAttachmentFolderPath, type AttachmentResolver } from "./attachments/VaultAttachmentResolver";
import { ClaudeRuntime, discoverClaudeExecutable } from "./claude/ClaudeRuntime";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  needsSettingsMigration,
  WECHAT_APP_ID_SECRET_NAME,
  WECHAT_APP_SECRET_NAME,
  type PaperdianSettings
} from "./config/settings";
import { ConversationRepository } from "./storage/ConversationRepository";
import { SkillCatalog } from "./skills/SkillCatalog";
import { PaperdianSettingsTab } from "./ui/SettingsTab";
import { WORKBENCH_VIEW_TYPE, WorkbenchView } from "./ui/WorkbenchView";
import { WeChatArticlePipeline, type PreparedArticle } from "./wechat/WeChatArticlePipeline";
import { SshWeChatClient } from "./wechat/SshWeChatClient";
import { readStoredDraftReceipt, WeChatPublisher, type DraftReceipt, type WeChatAccount } from "./wechat/WeChatPublisher";
import { validateSshConfig } from "./wechat/SshTunnel";

export default class PaperdianPlugin extends Plugin {
  settings: PaperdianSettings = DEFAULT_SETTINGS;
  runtime!: ClaudeRuntime;
  conversations!: ConversationRepository;
  skills!: SkillCatalog;
  pipeline!: WeChatArticlePipeline;
  private wechatClient = new SshWeChatClient();
  private publisher!: WeChatPublisher;
  private attachmentNormalizer!: AttachmentNormalizer;
  private vaultPath = "";

  async onload(): Promise<void> {
    const savedSettings = await this.loadData() as Partial<PaperdianSettings> | null;
    this.settings = mergeSettings(savedSettings);
    if (needsSettingsMigration(savedSettings)) await this.saveSettings();
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error("Paperdian 只支持桌面文件系统 Vault。");
    this.vaultPath = adapter.getBasePath();
    this.conversations = new ConversationRepository(this.vaultPath);
    this.rebuildSkillCatalog();
    this.pipeline = new WeChatArticlePipeline(this.vaultPath, undefined, undefined, () => this.getAttachmentResolver());
    this.publisher = new WeChatPublisher(this.vaultPath, this.wechatClient);
    this.attachmentNormalizer = new AttachmentNormalizer({
      vault: createAttachmentVault(this.app.vault),
      attachmentResolver: () => this.getAttachmentResolver(),
      download: async url => {
        const response = await requestUrl(url);
        return { status: response.status, headers: response.headers, arrayBuffer: response.arrayBuffer };
      }
    });
    await this.rebuildRuntime();

    this.registerView(WORKBENCH_VIEW_TYPE, leaf => new WorkbenchView(leaf, this));
    this.addRibbonIcon("book-open-check", "打开 Paperdian", () => { void this.activateView(); });
    this.addCommand({ id: "open-workbench", name: "打开 Paperdian 工作台", callback: () => { void this.activateView(); } });
    this.addCommand({ id: "deep-read-current-note", name: "使用 Claude 精读当前材料论文", checkCallback: checking => {
      const active = this.app.workspace.getActiveFile();
      if (!active || active.extension !== "md") return false;
      if (!checking) void this.activateView();
      return true;
    } });
    this.addCommand({ id: "normalize-current-file-attachments", name: "下载并规范化当前文件附件", checkCallback: checking => {
      const active = this.app.workspace.getActiveFile();
      if (!active || active.extension !== "md") return false;
      if (!checking) void this.normalizeAndNotify(active);
      return true;
    } });
    this.addSettingTab(new PaperdianSettingsTab(this.app, this));
    this.registerEvent(this.app.workspace.on("file-open", file => this.notifyViews(file)));
    this.registerEvent(this.app.vault.on("modify", file => {
      if (file instanceof TFile && file.extension === "md" && file.path === this.app.workspace.getActiveFile()?.path) this.notifyViews(file);
    }));
  }

  async onunload(): Promise<void> { this.app.workspace.detachLeavesOfType(WORKBENCH_VIEW_TYPE); }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  getVaultPath(): string { return this.vaultPath; }

  async getAttachmentResolver(): Promise<AttachmentResolver> {
    const attachmentFolderPath = await readAttachmentFolderPath(this.app.vault);
    return new VaultAttachmentResolver({
      attachmentFolderPath,
      fileExists: filePath => this.app.vault.getFileByPath(filePath) !== null,
      resolveLinkpath: (linkpath, sourcePath) => this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath)?.path
    });
  }

  async normalizeCurrentFileAttachments(file: TFile): Promise<AttachmentNormalizationResult> {
    if (file.extension !== "md") throw new Error("当前文件不是 Markdown。");
    return this.attachmentNormalizer.normalize(file);
  }

  rebuildSkillCatalog(): void {
    this.skills = new SkillCatalog({
      directory: path.join(this.vaultPath, ".paperdian", "skills"),
      onWarning: message => new Notice(message, 8_000)
    });
  }

  async rebuildRuntime(): Promise<void> {
    try {
      const executable = await discoverClaudeExecutable(this.settings.claude.executablePath || undefined);
      this.runtime = new ClaudeRuntime({ vaultPath: this.vaultPath, executablePath: executable });
    } catch (error) {
      this.runtime = new ClaudeRuntime({ vaultPath: this.vaultPath, executablePath: this.settings.claude.executablePath || "claude.exe" });
      if (this.settings.claude.executablePath) new Notice(error instanceof Error ? error.message : String(error), 8_000);
    }
  }

  async publish(prepared: PreparedArticle, forceRecreate: boolean): Promise<DraftReceipt> {
    return this.publisher.createDraft(prepared, { ...this.getWechatAccount(), forceRecreate });
  }

  private getWechatAccount(): WeChatAccount {
    const appId = this.app.secretStorage.getSecret(WECHAT_APP_ID_SECRET_NAME);
    const appSecret = this.app.secretStorage.getSecret(WECHAT_APP_SECRET_NAME);
    if (!appId || !appSecret) throw new Error("请先在设置中导入或填写公众号 AppID/AppSecret。");
    const ssh = {
      host: this.settings.wechat.sshHost,
      user: this.settings.wechat.sshUser,
      port: this.settings.wechat.sshPort,
      privateKeyPath: this.settings.wechat.sshPrivateKeyPath
    };
    validateSshConfig(ssh);
    return {
      alias: this.settings.wechat.alias,
      appId,
      appSecret,
      needOpenComment: this.settings.wechat.needOpenComment,
      onlyFansCanComment: this.settings.wechat.onlyFansCanComment,
      ssh
    };
  }

  async validateWechatCredentials(): Promise<void> {
    await this.wechatClient.validateCredentials(this.getWechatAccount());
  }

  async getDraftReceipt(prepared: PreparedArticle): Promise<DraftReceipt | undefined> {
    const receipt = await readStoredDraftReceipt(this.vaultPath, prepared.sourcePath);
    return receipt?.sourceHash === prepared.sourceHash ? receipt : undefined;
  }

  async testWechatConnection(): Promise<string> {
    return this.wechatClient.testConnection({ host: this.settings.wechat.sshHost, user: this.settings.wechat.sshUser, port: this.settings.wechat.sshPort, privateKeyPath: this.settings.wechat.sshPrivateKeyPath });
  }

  private async activateView(): Promise<void> {
    let leaf: WorkspaceLeaf | undefined = this.app.workspace.getLeavesOfType(WORKBENCH_VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      await leaf?.setViewState({ type: WORKBENCH_VIEW_TYPE, active: true });
    }
    if (leaf) await this.app.workspace.revealLeaf(leaf);
  }

  private async normalizeAndNotify(file: TFile): Promise<void> {
    try {
      const result = await this.normalizeCurrentFileAttachments(file);
      new Notice(formatAttachmentResult(result), 8_000);
      this.notifyViews(file);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : String(error), 8_000);
    }
  }

  private notifyViews(file: TFile | null): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WORKBENCH_VIEW_TYPE)) {
      if (leaf.view instanceof WorkbenchView) leaf.view.onActiveFileChanged(file);
    }
  }
}

function createAttachmentVault(vault: PaperdianPlugin["app"]["vault"]): AttachmentVault {
  return {
    read: file => vault.read(file as TFile),
    readBinary: file => vault.readBinary(file as TFile),
    createBinary: (filePath, data) => vault.createBinary(filePath, data),
    ensureFolder: async folderPath => {
      let current = "";
      for (const segment of folderPath.split("/").filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        if (!vault.getFolderByPath(current)) await vault.createFolder(current);
      }
    },
    getFileByPath: filePath => vault.getFileByPath(filePath),
    modify: (file, data) => vault.modify(file as TFile, data)
  };
}

function formatAttachmentResult(result: AttachmentNormalizationResult): string {
  const summary = `附件处理完成：下载 ${result.downloadedCount}，转换 ${result.convertedCount}，未变更 ${result.unchangedCount}`;
  return result.failures.length ? `${summary}，失败 ${result.failures.length}：${result.failures.map(item => `${item.reference}（${item.message}）`).join("；")}` : summary;
}
