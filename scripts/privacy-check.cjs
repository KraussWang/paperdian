// Heuristic release check. Reports locations and categories, never matching values.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const files = new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean));
function addTree(relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const child = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symbolic link: ${child}`);
    if (entry.isDirectory()) addTree(child); else files.add(child);
  }
}
if (fs.existsSync(path.join(root, "main.js"))) files.add("main.js");
addTree("release");
const rules = [
  ["private key body", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/],
  ["WeChat AppID-shaped value", /\bwx[a-fA-F0-9]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["model API key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{30,}\b/],
  ["credential in URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ["Windows personal home path", /[A-Z]:[\\/]+Users[\\/]+(?!Public\b|Default\b)[^\s"'<>\\/]+/i],
  ["Unix personal home path", /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
  ["long assigned credential", /["']?(?:appsecret|api_key|access_token)["']?\s*[:=]\s*["'][A-Za-z0-9_-]{24,}["']/i]
];
const forbidden = /(?:^|\/)(?:data\.json|\.env(?:\..+)?|id_rsa|id_ed25519|\.obsidian|\.paper-reading|\.paperdian)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;
let failures = 0;
for (const relative of [...files].sort()) {
  if (forbidden.test(relative)) { process.stderr.write(`${relative}: forbidden personal file\n`); failures++; continue; }
  const full = path.join(root, relative);
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
  const content = fs.readFileSync(full, "utf8");
  for (const [name, expression] of rules) {
    const match = expression.exec(content);
    if (match) {
      const line = content.slice(0, match.index).split("\n").length;
      process.stderr.write(`${relative}:${line}: ${name}\n`); failures++;
    }
  }
}
if (failures) { process.stderr.write(`Privacy check requires review: ${failures} findings.\n`); process.exitCode = 1; }
else process.stdout.write(`Privacy patterns checked: ${files.size} source/build/release files; no matches. This is a heuristic check, not a guarantee.\n`);
