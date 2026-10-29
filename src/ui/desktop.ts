import { mkdir } from "node:fs/promises";

export async function openSkillDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const { shell } = getElectron();
  const error = await shell.openPath(directory);
  if (error) throw new Error("无法打开目录，请使用复制路径后在文件管理器中打开。");
}

export async function selectedFilePath(file: File): Promise<string> {
  const { webUtils } = getElectron();
  const filePath = webUtils?.getPathForFile(file) || (file as File & { path?: string }).path;
  if (!filePath) throw new Error("当前桌面版本无法读取所选文件的路径，请手动填写。");
  return filePath;
}

function getElectron(): typeof import("electron") {
  // Obsidian provides CommonJS require; native import() cannot resolve its host modules.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("electron") as typeof import("electron");
}
