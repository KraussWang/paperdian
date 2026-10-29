const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const release = path.join(root, "release");
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "paperdian-fresh-vault-"));

function assertSameTree(source, packaged) {
  const sourceEntries = fs.readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const packagedEntries = fs.readdirSync(packaged, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  if (sourceEntries.map(entry => entry.name).join("\n") !== packagedEntries.map(entry => entry.name).join("\n")) {
    throw new Error(`Release contents differ from source: ${source}`);
  }
  for (const entry of sourceEntries) {
    const sourcePath = path.join(source, entry.name);
    const packagedPath = path.join(packaged, entry.name);
    if (entry.isDirectory() !== fs.statSync(packagedPath).isDirectory()) throw new Error(`Release file type differs: ${sourcePath}`);
    if (entry.isDirectory()) assertSameTree(sourcePath, packagedPath);
    else if (!fs.readFileSync(sourcePath).equals(fs.readFileSync(packagedPath))) throw new Error(`Release file differs: ${sourcePath}`);
  }
}

try {
  for (const skill of ["material-paper-deep-reading", "material-paper-wechat-editor"]) {
    assertSameTree(path.join(root, "src", "skills", "builtin", skill), path.join(release, "skills", skill));
  }
  for (const [source, packaged] of [
    ["main.js", "paperdian/main.js"], ["manifest.json", "paperdian/manifest.json"],
    ["styles.css", "paperdian/styles.css"], ["LICENSE", "LICENSE"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"], ["docs/INSTALL.md", "INSTALL.md"]
  ]) {
    if (!fs.readFileSync(path.join(root, source)).equals(fs.readFileSync(path.join(release, packaged)))) {
      throw new Error(`Release file differs: ${packaged}`);
    }
  }
  const plugin = path.join(vault, ".obsidian", "plugins", "paperdian");
  const skills = path.join(vault, ".paperdian", "skills");
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.cpSync(path.join(release, "paperdian"), plugin, { recursive: true });
  fs.cpSync(path.join(release, "skills"), skills, { recursive: true });
  const output = execFileSync(process.execPath, [
    path.join(root, "scripts", "plugin-load-harness.cjs"),
    path.join(plugin, "main.js"),
    `--vault=${vault}`,
    "--preview", "--obsidian-eval", "--math", "--settings-migration", "--assert-skills"
  ], { encoding: "utf8", timeout: 30_000 });
  for (const signal of ["PLUGIN_LOAD_OK", "PLUGIN_SKILLS_OK", "PLUGIN_PREVIEW_OK", "SETTINGS_MIGRATION_OK"]) {
    if (!output.includes(signal)) throw new Error(`Missing smoke-test signal: ${signal}`);
  }
  process.stdout.write("FRESH_VAULT_SMOKE_OK\n");
} finally {
  fs.rmSync(vault, { recursive: true, force: true });
}
