# 安装与升级

Paperdian 面向 Windows 桌面版 Obsidian ≥ 1.11.4。macOS/Linux 尚未完成真实环境验证。完整功能需要本机 Claude Code、自己的微信公众号凭据和 SSH 出口服务器。

## 从 GitHub Release 安装

在 [Releases](https://github.com/KraussWang/paperdian/releases) 下载最新版本的 `main.js`、`manifest.json`、`styles.css`，按下文“全新 Vault 安装”放入插件目录。示例 Skills 在同一页面的 `paperdian-skills.zip` 中。

## 从源码构建

安装 Node.js 22 或更新的受支持版本、npm 和 Git，在仓库根目录运行：

```sh
npm ci
npm run check
npm run package:release
npm run smoke:install
npm run privacy:check
```

`release/` 包含插件三个程序文件、两套示例 Skill、安装说明和许可证。该目录为生成物，重新打包会替换脚本生成的内容。

## 全新 Vault 安装

1. 关闭目标 Vault 的 Obsidian 窗口。
2. 将 `release/paperdian/` 的三个文件复制到 `<Vault>/.obsidian/plugins/paperdian/`。
3. 重新打开 Obsidian，在“设置 → 第三方插件”启用 **Paperdian**。
4. 在插件设置中依次配置本地 Claude Code、专用 Skill 库、微信公众号与服务器。
5. 从侧栏书本图标或命令“打开 Paperdian 工作台”进入。

插件 ID 为 `paperdian`，安装目录名须与之一致。不用复制 `node_modules` 或源码。

## 本地 Claude Code

自行安装并在终端登录 Claude Code；Windows 使用原生 `claude.exe`，或能定位原生程序的 `claude.cmd`。自动发现失败时填写程序绝对路径，再点击“检查可用性”。检查只运行 `--version`，登录状态仍需在终端确认。

插件以 Vault 为工作目录，默认允许 Claude 创建、修改文件。模型服务由 Claude Code 负责连接，不是离线模型。

## 专用 Skill 库

在设置页点击“安装示例 Skills”，或将 `release/skills/<Skill名称>/` 完整复制到 `<Vault>/.paperdian/skills/<Skill名称>/`。包括 `SKILL.md` 及其附属资源。自动安装会跳过已有同名目录。重新打开工作台的 Skill 选择器刷新列表。

## 微信公众号与服务器

这是创建草稿的必备配置：

1. 输入自己的 AppID、AppSecret，分别点击保存；它们只进入 Obsidian SecretStorage。
2. 填写自己的 SSH 主机、用户名、端口，选择已有私钥文件或填写其绝对路径。
3. 本机需安装 OpenSSH。连接使用非交互认证；加密私钥请先加载到本机 ssh-agent。
4. 在公众号 API 白名单中配置服务器的公网出口 IP。可由服务器管理员确认；插件不在测试提示中显示 IP。
5. 先测试服务器连接，再验证微信凭据。验证会请求微信访问令牌，但不上传图片、不创建草稿、不将令牌写入磁盘。
6. 预览文章后创建草稿，再到微信公众平台审核并正式发布。

服务器首次连接使用 OpenSSH `StrictHostKeyChecking=accept-new`；已知主机指纹变更会导致失败，应在终端核对。服务器连接测试经 SSH 访问微信 API 主机并向 `api.ipify.org` 查询公网出口；该外部服务不可用也会使测试失败。

文章需有非空标题、正文与可用封面。封面优先使用 `frontmatter.cover`，否则使用正文首张图片。远程图片或 WebP 可先用“下载并规范化当前文件附件”处理；插件遵循 Vault 的附件目录配置。

## 升级与回退

先备份 Vault，关闭 Obsidian，只替换插件目录内的 `main.js`、`manifest.json`、`styles.css`。保留 `data.json`、`.paperdian/` 和 SecretStorage。已有 Skill 不会自动覆盖；需更新时先备份并手动比较。回退时恢复旧程序文件。

换电脑时重新配置微信凭据，单独迁移私钥并检查路径。不要把真实配置、私钥或整个 Vault 上传 GitHub。
