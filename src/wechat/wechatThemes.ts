import { WECHAT_TEAL_CSS } from "./wechatTealTheme";

export const ACADEMIC_THEMES = {
  mono: { label: "经典黑白", primary: "#202020", secondary: "#c3c3c3", soft: "#e4e4e5", surface: "#f5f5f5" },
  "academic-blue": { label: "学术蓝", primary: "#183a7b", secondary: "#5089bb", soft: "#b4d1e5", surface: "#deeaf2" },
  "nature-green": { label: "自然绿", primary: "#075035", secondary: "#60957b", soft: "#c6dcd1", surface: "#eaf1ee" },
  "editorial-red": { label: "知性红", primary: "#843131", secondary: "#bd7f7e", soft: "#e5c9c7", surface: "#f3e9e8" },
  "elegant-purple": { label: "优雅紫", primary: "#4c3878", secondary: "#8c7bb1", soft: "#d0c9e1", surface: "#edeaf3" },
  teal: { label: "湖蓝青", primary: "#03677a", secondary: "#53a9b8", soft: "#bbdce3", surface: "#e5f0f2" },
  "warm-brown": { label: "温润棕", primary: "#5a3f23", secondary: "#af977c", soft: "#ddd0bf", surface: "#f1eeea" },
  slate: { label: "高级灰", primary: "#39495b", secondary: "#748493", soft: "#b5bdc8", surface: "#e9eaed" }
} as const;

export type AcademicThemeName = keyof typeof ACADEMIC_THEMES;
export type WeChatThemeName = AcademicThemeName;

export const DEFAULT_WECHAT_THEME: WeChatThemeName = "academic-blue";

export const WECHAT_THEME_OPTIONS: ReadonlyArray<{ name: WeChatThemeName; label: string }> =
  Object.entries(ACADEMIC_THEMES).map(([name, theme]) => ({ name: name as AcademicThemeName, label: `${theme.label}·学术阅读` }));

export function isAcademicThemeName(value: unknown): value is AcademicThemeName {
  return typeof value === "string" && Object.hasOwn(ACADEMIC_THEMES, value);
}

export function isWeChatThemeName(value: unknown): value is WeChatThemeName {
  return isAcademicThemeName(value);
}

export function getWeChatThemeCss(theme: WeChatThemeName): string {
  const palette = ACADEMIC_THEMES[theme];
  return WECHAT_TEAL_CSS.replaceAll("#03677a", palette.primary).replaceAll("#e5f0f2", palette.surface);
}
