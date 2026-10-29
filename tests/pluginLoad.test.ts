import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("packaged Obsidian plugin", () => {
  it("keeps settings credentials explicit, private and separate from connection checks", () => {
    const output = execFileSync(process.execPath, [path.resolve("scripts/plugin-load-harness.cjs"), path.resolve("main.js"), "--settings-ui"], { encoding: "utf8" });
    expect(output).toContain("SETTINGS_UI_OK");
  });
  it("loads the CommonJS bundle and completes onload", () => {
    const output = execFileSync(process.execPath, [
      path.resolve("scripts/plugin-load-harness.cjs"),
      path.resolve("main.js"),
      "--preview",
      "--obsidian-eval",
      "--math",
      "--settings-migration"
    ], { encoding: "utf8" });

    expect(output).toContain("PLUGIN_PREVIEW_OK");
    expect(output).toContain("SETTINGS_MIGRATION_OK");
    expect(output).toContain("PLUGIN_LOAD_OK");
    const bundle = readFileSync(path.resolve("main.js"), "utf8");
    expect(bundle).toContain("paperdian-skill-option-note");
    expect(bundle.includes("material-paper-wechat-editor")).toBe(true);
    expect(bundle).not.toContain(".claude\\skills");
    expect(bundle).toContain("normalize-current-file-attachments");
    expect(bundle).not.toContain("literature-radar-scan-now");
    expect(bundle).not.toContain(".baoyu-skills");
    expect(bundle).not.toContain("读取公众号外部配置失败");
    expect(bundle).not.toContain("paperdian-skill-option-warning");
  });
});
