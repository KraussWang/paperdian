import { isWeChatThemeName, type WeChatThemeName } from "../wechat/wechatThemes";

export interface PaperdianSettings {
  claude: {
    executablePath: string;
    model: string;
    effort: "low" | "medium" | "high";
    permissionMode: "acceptEdits";
    availableModels: string[];
  };
  wechat: {
    theme: WeChatThemeName;
    alias: string;
    author: string;
    sshHost: string;
    sshUser: string;
    sshPort: number;
    sshPrivateKeyPath: string;
    needOpenComment: 0 | 1;
    onlyFansCanComment: 0 | 1;
  };
}

export const WECHAT_APP_ID_SECRET_NAME = "paperdian-wechat-app-id";
export const WECHAT_APP_SECRET_NAME = "paperdian-wechat-app-secret";

export const DEFAULT_SETTINGS: PaperdianSettings = {
  claude: {
    executablePath: "",
    model: "",
    effort: "medium",
    permissionMode: "acceptEdits",
    availableModels: ["", "sonnet", "opus"]
  },
  wechat: {
    theme: "default", alias: "main", author: "", sshHost: "", sshUser: "root", sshPort: 22,
    sshPrivateKeyPath: "", needOpenComment: 0, onlyFansCanComment: 0
  }
};

export function mergeSettings(saved: Partial<PaperdianSettings> | null | undefined): PaperdianSettings {
  const savedClaude = saved?.claude;
  const savedWechat = saved?.wechat;
  return {
    claude: {
      executablePath: savedClaude?.executablePath ?? DEFAULT_SETTINGS.claude.executablePath,
      model: savedClaude?.model ?? DEFAULT_SETTINGS.claude.model,
      effort: savedClaude?.effort ?? DEFAULT_SETTINGS.claude.effort,
      permissionMode: savedClaude?.permissionMode ?? DEFAULT_SETTINGS.claude.permissionMode,
      availableModels: Array.isArray(savedClaude?.availableModels)
        ? [...savedClaude.availableModels]
        : [...DEFAULT_SETTINGS.claude.availableModels]
    },
    wechat: {
      theme: isWeChatThemeName(savedWechat?.theme) ? savedWechat.theme : DEFAULT_SETTINGS.wechat.theme,
      alias: savedWechat?.alias ?? DEFAULT_SETTINGS.wechat.alias,
      author: savedWechat?.author ?? DEFAULT_SETTINGS.wechat.author,
      sshHost: savedWechat?.sshHost ?? DEFAULT_SETTINGS.wechat.sshHost,
      sshUser: savedWechat?.sshUser ?? DEFAULT_SETTINGS.wechat.sshUser,
      sshPort: savedWechat?.sshPort ?? DEFAULT_SETTINGS.wechat.sshPort,
      sshPrivateKeyPath: savedWechat?.sshPrivateKeyPath ?? DEFAULT_SETTINGS.wechat.sshPrivateKeyPath,
      needOpenComment: savedWechat?.needOpenComment ?? DEFAULT_SETTINGS.wechat.needOpenComment,
      onlyFansCanComment: savedWechat?.onlyFansCanComment ?? DEFAULT_SETTINGS.wechat.onlyFansCanComment
    }
  };
}

export function needsSettingsMigration(saved: unknown): boolean {
  if (!isRecord(saved)) return false;
  if ("legacyImport" in saved) return true;
  if (isRecord(saved.claude) && "skillDirectories" in saved.claude) return true;
  const wechat = saved.wechat;
  if (!isRecord(wechat)) return false;
  if (["accountName", "appIdSecretName", "appSecretName", "color"].some(key => key in wechat)) return true;
  return "theme" in wechat && !isWeChatThemeName(wechat.theme);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
