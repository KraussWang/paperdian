import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  needsSettingsMigration,
  WECHAT_APP_ID_SECRET_NAME,
  WECHAT_APP_SECRET_NAME,
  type PaperdianSettings
} from "../src/config/settings";
import { ACADEMIC_THEMES, WECHAT_THEME_OPTIONS, type AcademicThemeName } from "../src/wechat/wechatThemes";

describe("Paper Reading settings", () => {
  it("offers and preserves each academic theme across settings reloads", () => {
    for (const theme of Object.keys(ACADEMIC_THEMES) as AcademicThemeName[]) {
      expect(WECHAT_THEME_OPTIONS.some(option => option.name === theme)).toBe(true);
      const saved = { ...DEFAULT_SETTINGS, wechat: { ...DEFAULT_SETTINGS.wechat, theme } };
      const reloaded = JSON.parse(JSON.stringify(saved)) as Partial<PaperdianSettings>;
      expect(mergeSettings(reloaded).wechat.theme).toBe(theme);
      expect(needsSettingsMigration(saved)).toBe(false);
    }
  });
  it("preserves saved models and removes the legacy skill directory setting", () => {
    expect(mergeSettings(undefined).claude.availableModels).toEqual(["", "sonnet", "opus"]);

    const saved = {
      claude: {
        ...DEFAULT_SETTINGS.claude,
        availableModels: ["opus", "claude-custom"],
        skillDirectories: ["C:/skills"]
      }
    };
    const merged = mergeSettings(saved);
    expect(merged.claude.availableModels).toEqual(["opus", "claude-custom"]);
    expect(merged.claude).not.toHaveProperty("skillDirectories");
    expect(needsSettingsMigration(saved)).toBe(true);
    expect(needsSettingsMigration(merged)).toBe(false);
    expect(merged.wechat.theme).toBe("academic-blue");
  });

  it("normalizes legacy saved settings without losing active WeChat values", () => {
    const saved = {
      claude: DEFAULT_SETTINGS.claude,
      legacyImport: { envPath: "C:/legacy/.env", extendPath: "C:/legacy/EXTEND.md" },
      wechat: {
        ...DEFAULT_SETTINGS.wechat,
        accountName: "Legacy account",
        appIdSecretName: WECHAT_APP_ID_SECRET_NAME,
        appSecretName: WECHAT_APP_SECRET_NAME,
        theme: "default",
        color: "blue",
        alias: "KK",
        author: "Sample Author",
        sshHost: "api.example.com",
        needOpenComment: 1 as const,
        onlyFansCanComment: 0 as const
      }
    };

    expect(needsSettingsMigration(saved)).toBe(true);
    const merged = mergeSettings(saved as unknown as Partial<PaperdianSettings>);
    expect(merged.wechat).toMatchObject({
      alias: "KK",
      author: "Sample Author",
      sshHost: "api.example.com",
      needOpenComment: 1,
      onlyFansCanComment: 0
    });
    expect(merged).not.toHaveProperty("legacyImport");
    expect(merged.wechat).not.toHaveProperty("accountName");
    expect(merged.wechat.theme).toBe("academic-blue");
    expect(merged.wechat).not.toHaveProperty("color");
  });

  it("persists supported WeChat themes and migrates invalid theme values", () => {
    expect(DEFAULT_SETTINGS.wechat.theme).toBe("academic-blue");

    expect(mergeSettings({
      ...DEFAULT_SETTINGS,
      wechat: { ...DEFAULT_SETTINGS.wechat, theme: "teal" }
    }).wechat.theme).toBe("teal");
    expect(needsSettingsMigration({
      ...DEFAULT_SETTINGS,
      wechat: { ...DEFAULT_SETTINGS.wechat, theme: "teal" }
    })).toBe(false);

    const invalid = {
      ...DEFAULT_SETTINGS,
      wechat: { ...DEFAULT_SETTINGS.wechat, theme: "sepia" }
    };
    expect(needsSettingsMigration(invalid)).toBe(true);
    expect(mergeSettings(invalid as unknown as Partial<PaperdianSettings>).wechat.theme).toBe("academic-blue");

    for (const removed of ["default", "dark-blue"]) {
      const legacy = { ...DEFAULT_SETTINGS, wechat: { ...DEFAULT_SETTINGS.wechat, theme: removed } };
      expect(needsSettingsMigration(legacy)).toBe(true);
      expect(mergeSettings(legacy as unknown as Partial<PaperdianSettings>).wechat.theme).toBe("academic-blue");
    }
  });

  it("keeps the existing SecretStorage identifiers stable", () => {
    expect(WECHAT_APP_ID_SECRET_NAME).toBe("paperdian-wechat-app-id");
    expect(WECHAT_APP_SECRET_NAME).toBe("paperdian-wechat-app-secret");
  });
});
