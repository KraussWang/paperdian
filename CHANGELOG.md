# Changelog

版本号与 `manifest.json` 一致，Release 标签不带 `v` 前缀。

## 0.3.0

首个公开版本。

- Obsidian 工作台：调用本机 Claude Code 进行论文精读对话，支持续聊、取消、模型与推理强度选择。
- 专用 Skill 库：使用 Vault 内 `.paperdian/skills/`，内置论文精读与公众号编辑两套示例 Skill。
- 微信公众号：Markdown 预览（多套主题，支持公式与代码高亮），经 SSH 隧道创建草稿，保留回执阻止重复创建。
- 凭据：AppID/AppSecret 仅存入 Obsidian SecretStorage；SSH 私钥只保存路径。
- 设置页：独立的服务器连接测试与微信凭据验证，均不创建草稿、不显示真实出口 IP。
- 附件：下载并规范化远程图片与 WebP，遵循 Vault 附件目录设置。
