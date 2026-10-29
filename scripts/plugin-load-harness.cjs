const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const providedVault = process.argv.find(argument => argument.startsWith("--vault="))?.slice("--vault=".length);
let harnessVault = providedVault ? path.resolve(providedVault) : fs.mkdtempSync(path.join(os.tmpdir(), "paperdian-harness-"));
let savedData = null;
const savedSecrets = new Map();
const registeredCommands = [];
let settingsTab;
const settingsRows = [];
const notices = [];

class FileSystemAdapter {
  getBasePath() { return harnessVault; }
  async read(filePath) { return fs.promises.readFile(path.join(harnessVault, filePath), "utf8"); }
}

class Plugin {
  constructor() {
    this.app = {
      vault: {
        adapter: new FileSystemAdapter(),
        configDir: ".obsidian",
        getFileByPath: filePath => fs.existsSync(path.join(harnessVault, filePath)) ? new TFile(filePath) : null,
        on: () => ({})
      },
      metadataCache: { getFirstLinkpathDest: () => null },
      workspace: {
        on: () => ({}),
        getActiveFile: () => null,
        getLeavesOfType: () => [],
        detachLeavesOfType: () => undefined
      },
      secretStorage: { getSecret: id => savedSecrets.get(id) ?? null, setSecret: (id, value) => { savedSecrets.set(id, value); } }
    };
  }
  async loadData() { return savedData; }
  async saveData(value) { savedData = value; }
  registerView() {}
  addRibbonIcon() {}
  addCommand(command) { registeredCommands.push(command.id); }
  addSettingTab(tab) { settingsTab = tab; }
  registerEvent() {}
}

class ItemView {}
class MockElement {
  constructor() { this.children = []; this.events = {}; this.value = ""; }
  empty() { this.children = []; }
  createEl(tag, options = {}) { const el = Object.assign(new MockElement(), options, { tag }); this.children.push(el); return el; }
  addEventListener(event, callback) { this.events[event] = callback; }
  setAttribute(key, value) { this[key] = value; }
  click() {}
}
class PluginSettingTab {
  constructor(app) { this.app = app; this.containerEl = new MockElement(); }
}
class Control {
  constructor() { this.inputEl = new MockElement(); }
  setValue(value) { this.inputEl.value = value; return this; }
  getValue() { return this.inputEl.value; }
  setPlaceholder(value) { this.placeholder = value; return this; }
  setButtonText(value) { this.label = value; return this; }
  setDisabled(value) { this.disabled = value; return this; }
  addOptions() { return this; }
  onChange(callback) { this.change = callback; return this; }
  onClick(callback) { this.click = callback; return this; }
}
class Setting {
  constructor() { this.controlEl = new MockElement(); this.texts = []; this.buttons = []; settingsRows.push(this); }
  setName(value) { this.name = value; return this; }
  setDesc(value) { this.description = value; return this; }
  addText(callback) { const control = new Control(); this.texts.push(control); callback(control); return this; }
  addTextArea(callback) { return this.addText(callback); }
  addDropdown(callback) { callback(new Control()); return this; }
  addToggle(callback) { callback(new Control()); return this; }
  addButton(callback) { const control = new Control(); this.buttons.push(control); callback(control); return this; }
}
class Notice { constructor(text) { notices.push(text); } }
class TFile {
  constructor(filePath = "") {
    this.path = filePath;
    this.extension = path.posix.extname(filePath).slice(1);
  }
}

const obsidianMock = {
  FileSystemAdapter,
  Plugin,
  ItemView,
  PluginSettingTab,
  Setting,
  Notice,
  TFile,
  setIcon: () => undefined
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") return obsidianMock;
  if (request === "electron") return { webUtils: { getPathForFile: file => file.path } };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("main.js");
  const previewMode = process.argv.includes("--preview");
  const mathMode = process.argv.includes("--math");
  const settingsMigrationMode = process.argv.includes("--settings-migration");
  if (mathMode) global.window = {};
  if (settingsMigrationMode) {
    savedData = {
      legacyImport: { envPath: "C:\\legacy\\.env", extendPath: "C:\\legacy\\EXTEND.md" },
      wechat: {
        accountName: "示例公众号",
        alias: "sample",
        author: "Sample Author",
        appIdSecretName: "paperdian-wechat-app-id",
        appSecretName: "paperdian-wechat-app-secret",
        sshHost: "203.0.113.8",
        sshUser: "ubuntu",
        sshPort: 22,
        sshPrivateKeyPath: "C:\\keys\\wechat.pem",
        theme: "default",
        color: "blue",
        needOpenComment: 1,
        onlyFansCanComment: 0
      }
    };
    savedSecrets.set("paperdian-wechat-app-id", "wx-app");
    savedSecrets.set("paperdian-wechat-app-secret", "top-secret");
  }
  if (previewMode) {
    if (!providedVault) harnessVault = fs.mkdtempSync(path.join(os.tmpdir(), "paperdian-bundle-preview-"));
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.mkdirSync(path.join(harnessVault, ".obsidian"), { recursive: true });
    fs.mkdirSync(path.join(harnessVault, "raw", "assets"), { recursive: true });
    fs.writeFileSync(path.join(harnessVault, ".obsidian", "app.json"), JSON.stringify({ attachmentFolderPath: "raw/assets" }));
    fs.writeFileSync(path.join(harnessVault, "raw", "assets", "cover.png"), png);
    fs.writeFileSync(path.join(harnessVault, "raw", "assets", "figure.png"), png);
    const math = mathMode ? "\nInline formula: $x^2 + y^2$.\n\n$$E = mc^2$$\n" : "";
    fs.mkdirSync(path.join(harnessVault, "output"), { recursive: true });
    fs.writeFileSync(path.join(harnessVault, "output", "article.md"), `---\ntitle: Bundle preview\nsummary: Summary\nauthor: Author\nsourceUrl: https://example.com\ncover: cover.png\n---\n# Bundle preview\n\n![[figure.png|Figure]]\n${math}`);
  }
  let loaded;
  if (process.argv.includes("--obsidian-eval")) {
    const source = fs.readFileSync(target, "utf8");
    const pluginModule = { exports: {} };
    const targetRequire = Module.createRequire(target);
    const runtimeRequire = request => request === "obsidian" ? obsidianMock : targetRequire(request);
    const runtimeDirectory = path.join(harnessVault, "mock-obsidian-runtime");
    new Function("require", "module", "exports", "__dirname", "__filename", source)(
      runtimeRequire,
      pluginModule,
      pluginModule.exports,
      runtimeDirectory,
      target
    );
    loaded = pluginModule.exports;
  } else {
    loaded = require(target);
  }
  const PluginClass = loaded.default ?? loaded;
  const plugin = new PluginClass();
  await plugin.onload();
  if (process.argv.includes("--settings-ui")) await assertSettingsUi(plugin);
  if (process.argv.includes("--assert-skills")) {
    const catalog = await plugin.skills.list();
    if (catalog.skills.length !== 2 || catalog.diagnostics.length !== 0) throw new Error("Installed Vault did not expose both bundled Skills.");
    for (const command of ["open-workbench", "deep-read-current-note", "normalize-current-file-attachments"]) {
      if (!registeredCommands.includes(command)) throw new Error(`Plugin command is missing: ${command}`);
    }
    process.stdout.write("PLUGIN_SKILLS_OK\n");
  }
  if (settingsMigrationMode) {
    const wechat = plugin.settings.wechat;
    if (wechat.alias !== "sample" || wechat.author !== "Sample Author") throw new Error("Saved account metadata was not preserved.");
    if (wechat.sshHost !== "203.0.113.8" || wechat.sshUser !== "ubuntu" || wechat.sshPort !== 22 || wechat.sshPrivateKeyPath !== "C:\\keys\\wechat.pem") throw new Error("Saved SSH settings were not preserved.");
    if (wechat.needOpenComment !== 1 || wechat.onlyFansCanComment !== 0) throw new Error("Saved comment settings were not preserved.");
    const normalized = JSON.stringify(savedData);
    if (wechat.theme !== "default") throw new Error("Saved theme was not preserved.");
    for (const obsolete of ["legacyImport", "accountName", "appIdSecretName", "appSecretName", "color"]) {
      if (normalized.includes(`\"${obsolete}\"`)) throw new Error(`Obsolete setting was not removed: ${obsolete}`);
    }
    if (savedSecrets.get("paperdian-wechat-app-id") !== "wx-app" || savedSecrets.get("paperdian-wechat-app-secret") !== "top-secret") throw new Error("Existing credentials were not preserved in SecretStorage.");
    process.stdout.write("SETTINGS_MIGRATION_OK\n");
  }
  if (previewMode) {
    const prepared = await plugin.pipeline.prepare({ path: "output/article.md" }, { theme: "default", color: "blue", author: "Author" });
    if (!prepared.previewHtml.includes("data:image/png;base64,")) throw new Error("Preview HTML did not contain the frozen image.");
    if (mathMode && (!prepared.previewHtml.includes("paperdian-math") || !prepared.previewHtml.includes("class=\"katex\""))) {
      throw new Error("Preview HTML did not contain statically rendered KaTeX math.");
    }
    if (mathMode && !prepared.previewHtml.includes("clip-path: inset(50%)")) {
      throw new Error("Preview HTML did not contain inlined KaTeX layout CSS.");
    }
    if (mathMode && prepared.previewHtml.includes("fonts/KaTeX")) {
      throw new Error("Preview HTML contained unusable local KaTeX font URLs.");
    }
    process.stdout.write("PLUGIN_PREVIEW_OK\n");
  }
  process.stdout.write("PLUGIN_LOAD_OK\n");
})().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

async function assertSettingsUi(plugin) {
  const assert = require("node:assert/strict");
  settingsTab.display();
  const row = name => settingsRows.find(setting => setting.name === name);
  for (const [name, id] of [["AppID", "paperdian-wechat-app-id"], ["AppSecret", "paperdian-wechat-app-secret"]]) {
    const setting = row(name);
    const input = setting.texts[0];
    assert.equal(input.inputEl.type, "password");
    assert.equal(input.getValue(), "");
    const previous = savedSecrets.get(id);
    input.setValue(`fixture-${name}`);
    assert.equal(savedSecrets.get(id), previous, "Typing must not persist a credential.");
    await setting.buttons.find(button => button.label === "保存").click();
    assert.equal(savedSecrets.get(id), `fixture-${name}`);
    assert.equal(input.getValue(), "");
    await setting.buttons.find(button => button.label === "保存").click();
    assert.equal(savedSecrets.get(id), `fixture-${name}`, "Empty save must preserve the existing secret.");
    assert.ok(!JSON.stringify(plugin.settings).includes(`fixture-${name}`));
    assert.ok(!JSON.stringify(savedData).includes(`fixture-${name}`));
    await setting.buttons.find(button => button.label === "清除").click();
    assert.equal(savedSecrets.get(id), "");
    assert.ok(setting.description.includes("尚未设置"));
  }
  const port = row("SSH 端口").texts[0];
  const oldPort = plugin.settings.wechat.sshPort;
  await port.change("22oops");
  assert.equal(plugin.settings.wechat.sshPort, oldPort);
  await port.change("65536");
  assert.equal(plugin.settings.wechat.sshPort, oldPort);
  await port.change("2222");
  assert.equal(plugin.settings.wechat.sshPort, 2222);
  const picker = row("SSH 私钥文件").controlEl.children[0];
  const oldKey = plugin.settings.wechat.sshPrivateKeyPath;
  picker.files = [];
  picker.events.change();
  assert.equal(plugin.settings.wechat.sshPrivateKeyPath, oldKey);
  picker.files = [{ path: path.join(harnessVault, "fixture-key") }];
  picker.events.change();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(plugin.settings.wechat.sshPrivateKeyPath, picker.files[0].path);
  assert.equal(row("SSH 私钥文件").texts[0].getValue(), picker.files[0].path);
  let validations = 0;
  plugin.validateWechatCredentials = async () => { validations++; };
  await row("验证微信凭据").buttons[0].click();
  assert.equal(validations, 0, "Missing credentials must not initiate a request.");
  savedSecrets.set("paperdian-wechat-app-id", "fixture-app");
  savedSecrets.set("paperdian-wechat-app-secret", "fixture-secret");
  await row("验证微信凭据").buttons[0].click();
  assert.equal(validations, 1);
  plugin.validateWechatCredentials = async () => { throw new Error("errcode=40013 fixture-secret private-server"); };
  await row("验证微信凭据").buttons[0].click();
  assert.ok(notices.at(-1).includes("40013"));
  assert.ok(!notices.at(-1).includes("fixture-secret"));
  assert.ok(!notices.at(-1).includes("private-server"));
  plugin.testWechatConnection = async () => "203.0.113.8";
  await row("测试服务器连接").buttons[0].click();
  assert.ok(!notices.at(-1).includes("203.0.113.8"));
  assert.equal(row("测试服务器连接").buttons[0].disabled, false);
  process.stdout.write("SETTINGS_UI_OK\n");
}
