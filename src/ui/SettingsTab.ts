import { App, Notice, PluginSettingTab, Setting, type ToggleComponent } from "obsidian";
import path from "node:path";
import type PaperdianPlugin from "../main";
import { WECHAT_APP_ID_SECRET_NAME, WECHAT_APP_SECRET_NAME } from "../config/settings";
import { checkClaudeInstallation } from "../claude/checkClaudeInstallation";
import { installBuiltinSkills } from "../skills/installBuiltinSkills";
import { openSkillDirectory, selectedFilePath } from "./desktop";

export class PaperdianSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: PaperdianPlugin) { super(app, plugin); }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "Paperdian" });
    this.containerEl.createEl("p", { text: "配置本地 Claude Code、专用 Skill 库，以及微信公众号与服务器。微信公众号草稿是 Paperdian 的核心功能，创建草稿前须完成账号和服务器配置。" });
    this.claudeSettings();
    this.skillSettings();
    this.wechatSettings();
  }

  private claudeSettings(): void {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "1. 本地 Claude Code" });
    containerEl.createEl("p", { text: "Paperdian 调用你电脑上安装的 Claude Code。请先安装并在终端完成登录；模型请求由 Claude Code 连接其配置的服务处理，不是离线模型，也不使用下方的微信公众号凭据登录。" });
    containerEl.createEl("p", { text: "Claude 以当前 Vault 为工作目录，默认使用 acceptEdits，可读取、创建和修改文件。插件使用 Claude Code 安全模式，仅注入本轮选中的 Skills。" });
    this.textSetting("Claude Code 程序路径", "留空自动查找。Windows 可填写原生 claude.exe 或指向原生程序的 claude.cmd。", this.plugin.settings.claude.executablePath, async value => {
      this.plugin.settings.claude.executablePath = value.trim(); await this.plugin.saveSettings(); await this.plugin.rebuildRuntime();
    });
    this.actionSetting("检查 Claude Code", "仅运行本机程序的 --version，不发送模型请求，也不验证登录状态。", "检查可用性", async () => {
      const version = await checkClaudeInstallation(this.plugin.settings.claude.executablePath, this.plugin.getVaultPath());
      new Notice(`Claude Code ${version} 可用；请确保已在终端完成登录。`, 8_000);
    }, "无法运行 Claude Code。请检查安装、程序路径和文件权限，再在终端运行 claude --version。");
    this.textSetting("默认模型", "留空使用 Claude Code 默认模型。", this.plugin.settings.claude.model, async value => { this.plugin.settings.claude.model = value.trim(); await this.plugin.saveSettings(); });
    new Setting(containerEl).setName("可选模型").setDesc("每行一个模型 ID；default 代表 Claude 默认模型。")
      .addTextArea(text => text.setValue(this.plugin.settings.claude.availableModels.map(model => model || "default").join("\n")).onChange(async value => {
        this.plugin.settings.claude.availableModels = uniqueLines(value).map(model => model === "default" ? "" : model); await this.plugin.saveSettings();
      }));
    new Setting(containerEl).setName("推理强度").addDropdown(dropdown => dropdown
      .addOptions({ low: "low", medium: "medium", high: "high" }).setValue(this.plugin.settings.claude.effort)
      .onChange(async value => { this.plugin.settings.claude.effort = value as "low" | "medium" | "high"; await this.plugin.saveSettings(); }));
  }

  private skillSettings(): void {
    const { containerEl } = this;
    const directory = path.join(this.plugin.getVaultPath(), ".paperdian", "skills");
    containerEl.createEl("h3", { text: "2. 专用 Skill 库" });
    containerEl.createEl("p", { text: "每个 Skill 放在单独子目录中，以 SKILL.md 为入口；references、assets、scripts 等附属资源放在同一目录。插件只扫描当前 Vault 的专用库，不读取 Claude 全局 Skill 库。" });
    new Setting(containerEl).setName("库位置").setDesc(directory);
    this.actionSetting("打开目录", "目录不存在时会创建。", "打开目录", async () => { await openSkillDirectory(directory); }, "无法打开目录。请复制路径后在文件管理器中打开。");
    this.actionSetting("复制路径", "复制当前 Vault 专用 Skill 库的完整路径。", "复制路径", async () => {
      await navigator.clipboard.writeText(directory); new Notice("Skill 库路径已复制。");
    }, "无法访问剪贴板，请手动复制上方路径。");
    this.actionSetting("示例 Skills", "安装论文精读与公众号编辑两套示例；已有同名目录会跳过，保留你的修改。", "安装示例 Skills", async () => {
      const result = await installBuiltinSkills(directory); this.plugin.rebuildSkillCatalog();
      new Notice(`已安装 ${result.installed} 个示例，保留 ${result.skipped} 个已有目录。`);
    }, "示例安装未完成，请检查目录写入权限；已有目录不会被覆盖。");
    containerEl.createEl("p", { text: "新增、修改或删除 Skill 后，重新打开工作台的 Skill 选择器即可刷新。每轮运行会复制选中 Skill 的完整目录作为临时副本。" });
  }

  private wechatSettings(): void {
    const { containerEl } = this;
    containerEl.createEl("h3", { text: "3. 微信公众号与服务器" });
    containerEl.createEl("p", { text: "这是创建微信公众号草稿的必备配置。请使用自己的公众号 AppID、AppSecret 和 SSH 出口服务器，并将出口 IP 配置到公众号 API 白名单。插件创建草稿后，由你到微信后台审核和发布。" });
    containerEl.createEl("p", { text: "AppID 与 AppSecret 保存在 Obsidian SecretStorage；SSH 私钥只引用本机文件，不复制密钥正文。主机、用户名和路径等普通设置保存在当前 Vault 的插件 data.json 中，请勿分享该文件。" });
    this.textSetting("账号别名", "用于区分本地草稿回执。", this.plugin.settings.wechat.alias, async value => { this.plugin.settings.wechat.alias = value.trim(); await this.plugin.saveSettings(); });
    this.textSetting("默认作者", "公众号预览和草稿使用此作者，可留空。", this.plugin.settings.wechat.author, async value => { this.plugin.settings.wechat.author = value; await this.plugin.saveSettings(); });
    this.secretSetting("AppID", WECHAT_APP_ID_SECRET_NAME);
    this.secretSetting("AppSecret", WECHAT_APP_SECRET_NAME);
    this.textSetting("SSH 主机", "填写自己的出口服务器域名或 IPv4 地址，不含协议前缀。", this.plugin.settings.wechat.sshHost, async value => { this.plugin.settings.wechat.sshHost = value.trim(); await this.plugin.saveSettings(); });
    this.textSetting("SSH 用户", "服务器登录用户名。", this.plugin.settings.wechat.sshUser, async value => { this.plugin.settings.wechat.sshUser = value.trim(); await this.plugin.saveSettings(); });
    const portSetting = new Setting(containerEl).setName("SSH 端口").setDesc("1–65535，默认 22。");
    portSetting.addText(text => text.setValue(String(this.plugin.settings.wechat.sshPort)).onChange(async value => {
      const port = Number(value);
      const valid = /^\d+$/.test(value) && Number.isInteger(port) && port >= 1 && port <= 65535;
      text.inputEl.setAttribute("aria-invalid", String(!valid));
      portSetting.setDesc(valid ? "1–65535，默认 22。" : "端口无效，未保存；请输入 1–65535 的整数。");
      if (valid) { this.plugin.settings.wechat.sshPort = port; await this.plugin.saveSettings(); }
    }));
    this.privateKeySetting();
    this.actionSetting("测试服务器连接", "建立 SSH 隧道并检测公网出口，不验证微信凭据；结果不显示真实 IP。", "测试服务器连接", async () => {
      await this.plugin.testWechatConnection(); new Notice("服务器连接与出口检测通过。微信凭据请单独验证。", 8_000);
    }, "服务器连接失败。请检查主机、端口、用户名、私钥权限及 OpenSSH；加密私钥需先在本机 ssh-agent 中解锁。");
    this.actionSetting("验证微信凭据", "请先保存 AppID 和 AppSecret。通过 SSH 请求微信访问令牌，不上传图片、不创建草稿，也不保存令牌。", "验证微信凭据", async () => {
      if (!this.app.secretStorage.getSecret(WECHAT_APP_ID_SECRET_NAME) || !this.app.secretStorage.getSecret(WECHAT_APP_SECRET_NAME)) {
        new Notice("请先分别保存 AppID 和 AppSecret。"); return;
      }
      await this.plugin.validateWechatCredentials(); new Notice("微信凭据验证通过；可以继续预览并创建草稿。", 8_000);
    }, "微信凭据验证失败。请检查已保存的 AppID、AppSecret、服务器连接与公众号 API 白名单。", true);
    let fansToggle: ToggleComponent | undefined;
    new Setting(containerEl).setName("开启评论").setDesc("允许读者在公众号文章下留言。")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.wechat.needOpenComment === 1).onChange(async value => {
        this.plugin.settings.wechat.needOpenComment = value ? 1 : 0; await this.plugin.saveSettings(); fansToggle?.setDisabled(!value);
      }));
    new Setting(containerEl).setName("仅关注用户可评论").setDesc("仅在开启评论时生效。")
      .addToggle(toggle => { fansToggle = toggle; toggle.setValue(this.plugin.settings.wechat.onlyFansCanComment === 1)
        .setDisabled(this.plugin.settings.wechat.needOpenComment === 0).onChange(async value => {
          this.plugin.settings.wechat.onlyFansCanComment = value ? 1 : 0; await this.plugin.saveSettings();
        }); });
  }

  private privateKeySetting(): void {
    const setting = new Setting(this.containerEl).setName("SSH 私钥文件").setDesc("选择现有私钥或填写绝对路径。插件仅保存路径，由本机 OpenSSH 读取文件。");
    const picker = setting.controlEl.createEl("input", { type: "file" });
    picker.hidden = true;
    setting.addText(text => {
      text.setValue(this.plugin.settings.wechat.sshPrivateKeyPath).setPlaceholder("选择文件，或填写绝对路径").onChange(async value => {
        this.plugin.settings.wechat.sshPrivateKeyPath = value.trim(); await this.plugin.saveSettings();
      });
      picker.addEventListener("change", () => {
        const file = picker.files?.[0];
        if (!file) return;
        void (async () => {
          try {
            const filePath = await selectedFilePath(file);
            this.plugin.settings.wechat.sshPrivateKeyPath = filePath; await this.plugin.saveSettings(); text.setValue(filePath);
            new Notice("私钥路径已保存，未复制私钥内容。");
          } catch { new Notice("无法保存所选私钥路径，请手动填写绝对路径。"); }
          finally { picker.value = ""; }
        })();
      });
    }).addButton(button => button.setButtonText("选择文件").onClick(() => picker.click()));
  }

  private textSetting(name: string, description: string, value: string, onChange: (value: string) => Promise<void>): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addText(text => text.setValue(value).onChange(onChange));
  }

  private actionSetting(name: string, description: string, label: string, action: () => Promise<void>, failure: string, showWechatCode = false): void {
    new Setting(this.containerEl).setName(name).setDesc(description).addButton(button => button.setButtonText(label).onClick(async () => {
      button.setDisabled(true);
      try { await action(); }
      catch (error) {
        const code = showWechatCode && error instanceof Error ? error.message.match(/errcode=(-?\d+)/)?.[1] : undefined;
        new Notice(`${failure}${code ? ` 微信错误码：${code}。` : ""}`, 10_000);
      } finally { button.setDisabled(false); }
    }));
  }

  private secretSetting(name: string, secretName: string): void {
    const setting = new Setting(this.containerEl).setName(name);
    const updateStatus = () => setting.setDesc(this.app.secretStorage.getSecret(secretName) ? "已保存。填写新值后点击保存以替换；留空不会修改。" : "尚未设置。输入后请点击保存。");
    updateStatus();
    setting.addText(text => {
      text.inputEl.type = "password"; text.inputEl.autocomplete = "off"; text.inputEl.spellcheck = false;
      text.setPlaceholder("输入新值后保存");
      setting.addButton(button => button.setButtonText("保存").onClick(() => {
        const value = text.getValue().trim();
        if (!value) { new Notice(`请输入 ${name}；如需移除已有值，请点击清除。`); return; }
        try {
          this.app.secretStorage.setSecret(secretName, value); text.setValue(""); updateStatus(); new Notice(`${name} 已保存。`);
        } catch { new Notice(`${name} 保存失败，请检查 Obsidian SecretStorage 是否可用。`); }
      }));
      setting.addButton(button => button.setButtonText("清除").onClick(() => {
        try {
          // The public API clears the value; the SecretStorage entry may remain.
          this.app.secretStorage.setSecret(secretName, ""); text.setValue(""); updateStatus(); new Notice(`${name} 已清除。`);
        } catch { new Notice(`${name} 清除失败。`); }
      }));
    });
  }
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}
