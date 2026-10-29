# 参与贡献

欢迎提交 Issue 与 Pull Request。

## 开发环境

需要 Node.js 22+、npm 和 Git。

```sh
npm ci
npm run dev      # 监听构建
npm run check    # 类型检查、Lint、构建与测试
npm run smoke:install
npm run privacy:check
```

开发时可将仓库根目录生成的 `main.js`、`manifest.json`、`styles.css` 复制到测试 Vault 的 `.obsidian/plugins/paperdian/`。请使用独立测试 Vault，不要把整个源码仓库放进 Vault。

## Pull Request

- 提交前 `npm run check` 与 `npm run privacy:check` 需通过。
- 修改行为时补充或更新 `tests/` 中的测试；修改公众号渲染时同步更新 `tests/snapshots/`。
- 涉及真实 Obsidian、Claude Code、SSH 或微信后台的改动，请参照 [人工验证清单](docs/MANUAL_SMOKE.md) 说明验证范围。
- 用户可见变更请更新 [CHANGELOG.md](CHANGELOG.md)。

## 隐私

不要在 Issue、PR、测试或快照中包含真实 AppID/AppSecret、私钥、服务器地址、`data.json`、聊天记录或论文全文。测试数据请使用 `example.com`、`203.0.113.0/24` 等保留地址。

## 发布（维护者）

1. 同步更新 `package.json`、`manifest.json`、`versions.json` 与 `CHANGELOG.md` 的版本号。
2. 推送不带 `v` 前缀的标签，例如 `git tag 0.3.1 && git push origin 0.3.1`。
3. GitHub Actions 生成草稿 Release，审核附件后手动发布。
