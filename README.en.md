# Paperdian

English | [中文](README.md)

An Obsidian desktop plugin that runs your locally installed Claude Code to deep-read papers with dedicated Skills, then previews Markdown and creates WeChat Official Account drafts.

> The full documentation is in Chinese. This page is a short overview.

## Requirements

- Obsidian desktop ≥ 1.11.4. Windows is the primary target; macOS/Linux have not been verified in real environments yet.
- [Claude Code](https://code.claude.com/docs/en/setup), installed and logged in from a terminal. Model requests go through Claude Code's own configured service; this is not offline inference.
- For draft creation: your own WeChat Official Account AppID/AppSecret, plus an SSH server with a fixed public IP and local OpenSSH.

Why SSH? The WeChat API only accepts calls from whitelisted IPs, and home/office egress IPs usually change. Paperdian tunnels API calls through your SSH server so you only whitelist that server's IP. An optional direct-connection mode is planned.

## Install

1. Download `main.js`, `manifest.json` and `styles.css` from the latest [GitHub Release](https://github.com/KraussWang/paperdian/releases).
2. Put them in `<Vault>/.obsidian/plugins/paperdian/`.
3. Restart Obsidian and enable **Paperdian** under Community plugins.
4. Optional: example Skills are in `paperdian-skills.zip`, or use "Install example Skills" in the settings tab.

## Privacy

- AppID/AppSecret are stored only in Obsidian SecretStorage, never in `data.json`.
- Only the path of your SSH private key is saved; the key is read by local OpenSSH.
- The plugin creates drafts only. You publish from the WeChat Official Account platform yourself.
- `data.json` still contains host, user and local paths. Do not commit or share it.

## Development

```sh
npm ci
npm run check
npm run smoke:install
npm run privacy:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Claude Code integration and parts of the interaction design were inspired by [Claudian](https://github.com/YishenTu/claudian).
