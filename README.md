# Paperdian

[English](README.en.md) | 中文

在 Obsidian 中调用本机 Claude Code 精读论文，使用专用 Skills 组织写作流程，并将 Markdown 预览、创建为微信公众号草稿。

**微信公众号与 SSH 服务器是产品的必备模块。** 完整使用流程需要用户自己的公众号凭据和 SSH 出口服务器。插件不提供共享账号、服务器或密钥；只创建草稿，正式发布由用户在微信公众平台完成。

为什么需要 SSH 服务器：微信公众号 API 只接受白名单内 IP 的调用，而家庭或办公网络的出口 IP 通常会变化。插件经 SSH 隧道从一台固定公网 IP 的服务器访问微信 API，只需将该服务器 IP 加入白名单。后续版本计划提供可选的本机直连模式，供出口 IP 固定的用户使用。

第一版优先支持 Windows 桌面版 Obsidian ≥ 1.11.4。macOS/Linux 尚未完成真实环境验证。插件 ID 为 `paperdian`，Vault 内数据目录为 `.paperdian/`。

## 安装

推荐从 [GitHub Releases](https://github.com/KraussWang/paperdian/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`，放入 `<Vault>/.obsidian/plugins/paperdian/`，重新打开 Obsidian 并启用 **Paperdian**。示例 Skills 在同页的 `paperdian-skills.zip` 中。

从源码构建需要 Node.js 22 或更新的受支持版本、npm 和 Git：

```sh
npm ci
npm run check
npm run smoke:install
npm run privacy:check
```

将 `release/paperdian/` 中的 `main.js`、`manifest.json`、`styles.css` 复制到 `<Vault>/.obsidian/plugins/paperdian/`，重新打开 Obsidian 并启用 **Paperdian**。不要将整个源码仓库放进 Vault。详见 [安装与升级](docs/INSTALL.md)。

## 设置

| 区域 | 内容 | 配置方式 |
| --- | --- | --- |
| 本地 Claude Code | 程序路径、模型、推理强度 | 自行安装并在终端登录；点击“检查可用性”检查本地版本 |
| 专用 Skill 库 | 当前 Vault 的 `.paperdian/skills/` | 打开目录、复制路径，或点击“安装示例 Skills” |
| 微信公众号与服务器 | AppID、AppSecret、SSH 主机、用户、端口、私钥文件 | 分别保存凭据，选择本机私钥，再测试服务器连接和验证微信凭据 |

[设置详解](docs/SETTINGS.md) 包含凭据存储、服务器要求和目录结构。[空配置示例](examples/settings.example.json) 只演示普通设置，不包含密钥字段。

### 本地 Claude Code

插件启动电脑上已安装的 Claude Code，工作目录是当前 Vault。模型请求由 Claude Code 连接其配置的服务处理；“本地调用”不代表离线推理。Claude 的登录由其自身管理，和微信 AppID/AppSecret 无关。

请按 [Claude Code 官方说明](https://code.claude.com/docs/en/setup) 安装并登录。Windows 可配置原生 `claude.exe`，或能够定位原生程序的 `claude.cmd`；可用性检查只运行 `--version`，不验证账号登录。默认 `acceptEdits` 允许 Claude 读写 Vault 文件。不要在对话中粘贴微信凭据或私钥。

### 专用 Skills

```text
<Vault>/.paperdian/skills/
  material-paper-deep-reading/
    SKILL.md
  material-paper-wechat-editor/
    SKILL.md
  your-skill/
    SKILL.md
    references/
    assets/
    scripts/
```

设置页可以安装内置的论文精读和公众号编辑示例；已有同名目录会完整保留。示例也随 `release/skills/` 提供。修改、添加或删除后，重新打开 Skill 选择器刷新。执行时复制选中 Skill 的完整目录作为本轮临时副本。插件不扫描 Claude 的全局 Skill 库，也不在升级时覆盖用户 Skills。

### 微信公众号草稿

1. 配置自己的公众号 AppID/AppSecret，分别点击“保存”。
2. 填写 SSH 主机、用户、端口，选择私钥文件；把服务器出口 IP 加入公众号 API 白名单。
3. 点击“测试服务器连接”，再点击“验证微信凭据”。两项检查均不创建草稿。
4. 打开 Markdown 文章，在工作台的“公众号”页面检查主题、标题、图片和封面，再创建草稿。
5. 到微信公众平台检查、编辑并发布。

本地预览和 Claude 对话不会因微信配置尚未完成而被阻断；**创建草稿必须配置公众号和服务器**。正文图片不可用会显示提醒；封面不可用会阻止创建草稿。附件遵循 Obsidian 的附件目录设置。插件保留文章回执以阻止重复创建。

## 隐私与公开仓库

- AppID/AppSecret 仅写入 Obsidian SecretStorage，不进入插件 `data.json`；输入框不回填旧值，点击“清除”清空对应存储值。
- SSH 私钥只保存路径，交给本机 OpenSSH 读取，不复制正文进插件。
- `data.json` 仍含主机、用户名和本地路径，属于用户配置，不应提交或分享。
- 源码和安装包不包含 Vault、凭据、聊天、论文或运行日志。
- 错误提示不显示微信接口返回的原始错误正文；连接测试不显示真实出口 IP。
- `npm run privacy:check` 检查待发布文件中的常见凭据形态与禁入文件。静态检查有边界，不能代替发布前人工复核。

版本变更见 [CHANGELOG](CHANGELOG.md)，真实环境操作见 [人工验证清单](docs/MANUAL_SMOKE.md)。发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开发与打包

```sh
npm ci
npm run check
npm run package:release
npm run smoke:install
npm run privacy:check
```

`check` 包含类型、Lint、构建及测试；`smoke:install` 在临时 Vault 模拟安装，不使用真实账号。`release/` 和根目录 `main.js` 是生成物，不提交 Git。推送版本标签（如 `0.3.0`，不带 `v`）后，GitHub Actions 会构建安装文件并生成草稿 Release，由维护者审核后发布。

## 许可证

项目采用 [MIT](LICENSE)，第三方归属和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。保留现有作者和上游版权署名。Claude Code 接入及部分交互设计参考了 [Claudian](https://github.com/YishenTu/claudian)。
