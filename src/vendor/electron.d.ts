declare module "electron" {
  export const shell: { openPath(path: string): Promise<string> };
  export const webUtils: { getPathForFile(file: File): string } | undefined;
}
