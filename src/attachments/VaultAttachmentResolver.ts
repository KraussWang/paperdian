import { lstat } from "node:fs/promises";
import path from "node:path";

export interface AttachmentConfigVault {
  configDir: string;
  adapter: {
    read(filePath: string): Promise<string>;
  };
}

export interface VaultAttachmentResolverOptions {
  attachmentFolderPath?: string;
  fileExists: (vaultPath: string) => boolean | Promise<boolean>;
  resolveLinkpath?: (linkpath: string, sourcePath: string) => string | undefined | Promise<string | undefined>;
}

export interface AttachmentResolver {
  resolve(reference: string, sourcePath: string): Promise<string | undefined>;
  destinationPath(fileName: string, sourcePath: string): string;
  relativePath(sourcePath: string, targetPath: string, encode?: boolean): string;
}

export type AttachmentResolverProvider = () => AttachmentResolver | Promise<AttachmentResolver>;

export async function readAttachmentFolderPath(vault: AttachmentConfigVault): Promise<string | undefined> {
  const configPath = joinVaultPath(vault.configDir, "app.json");
  try {
    const parsed = JSON.parse(await vault.adapter.read(configPath)) as { attachmentFolderPath?: unknown };
    if (typeof parsed.attachmentFolderPath !== "string") return undefined;
    return validAttachmentFolderPath(parsed.attachmentFolderPath);
  } catch {
    return undefined;
  }
}

export class VaultAttachmentResolver implements AttachmentResolver {
  private readonly attachmentFolderPath: string | undefined;

  constructor(private readonly options: VaultAttachmentResolverOptions) {
    this.attachmentFolderPath = options.attachmentFolderPath === undefined
      ? undefined
      : validAttachmentFolderPath(options.attachmentFolderPath);
  }

  async resolve(reference: string, sourcePath: string): Promise<string | undefined> {
    const cleaned = cleanAttachmentReference(reference);
    if (!cleaned || isNonVaultReference(cleaned)) return undefined;
    const normalizedSource = assertVaultPath(sourcePath);
    const candidates: string[] = [];
    const rootRelative = cleaned.startsWith("/");
    const portableReference = cleaned.replaceAll("\\", "/");

    if (rootRelative) {
      candidates.push(assertVaultPath(portableReference.replace(/^\/+/, "")));
    } else {
      candidates.push(resolveWithinVault(path.posix.dirname(normalizedSource), portableReference));
      if (isBareFileName(portableReference) && this.attachmentFolderPath !== undefined) {
        candidates.push(joinVaultPath(this.attachmentDirectory(normalizedSource), portableReference));
      }
      if (!portableReference.startsWith(".")) candidates.push(assertVaultPath(portableReference));
    }

    for (const candidate of unique(candidates)) {
      if (await this.options.fileExists(candidate)) return candidate;
    }

    if (this.options.resolveLinkpath) {
      const resolved = await this.options.resolveLinkpath(cleaned, normalizedSource);
      if (resolved) {
        const safePath = assertVaultPath(resolved);
        if (await this.options.fileExists(safePath)) return safePath;
      }
    }
    return undefined;
  }

  destinationPath(fileName: string, sourcePath: string): string {
    const normalizedSource = assertVaultPath(sourcePath);
    const safeName = path.posix.basename(fileName.replaceAll("\\", "/"));
    if (!safeName || safeName === "." || safeName === "..") throw new Error("附件文件名无效。");
    return joinVaultPath(this.attachmentDirectory(normalizedSource), safeName);
  }

  relativePath(sourcePath: string, targetPath: string, encode = true): string {
    const sourceDirectory = path.posix.dirname(assertVaultPath(sourcePath));
    const target = assertVaultPath(targetPath);
    const relative = path.posix.relative(sourceDirectory, target) || path.posix.basename(target);
    return encode ? relative.split("/").map(segment => encodeURIComponent(segment)).join("/") : relative;
  }

  private attachmentDirectory(sourcePath: string): string {
    const configured = this.attachmentFolderPath;
    if (configured === undefined) return path.posix.dirname(sourcePath);
    if (configured === "" || configured === "/") return "";
    if (configured === "." || configured === "./") return path.posix.dirname(sourcePath);
    if (configured.startsWith("./")) return resolveWithinVault(path.posix.dirname(sourcePath), configured.slice(2));
    return assertVaultPath(configured);
  }
}

export function createFileSystemAttachmentResolver(vaultPath: string, attachmentFolderPath?: string): AttachmentResolver {
  const root = path.resolve(vaultPath);
  return new VaultAttachmentResolver({
    attachmentFolderPath,
    fileExists: async vaultRelativePath => {
      const candidate = path.resolve(root, vaultRelativePath.replaceAll("/", path.sep));
      if (!isWithin(root, candidate)) return false;
      try { return (await lstat(candidate)).isFile(); }
      catch { return false; }
    }
  });
}

export function cleanAttachmentReference(value: string): string {
  let result = value.trim().replace(/^<|>$/g, "");
  const titled = result.match(/^([^\s]+)\s+["'][^"']*["']$/);
  if (titled?.[1]) result = titled[1];
  try { result = decodeURIComponent(result); } catch { /* Keep malformed percent-encoding unchanged. */ }
  return result.split("#", 1)[0] ?? result;
}

function validAttachmentFolderPath(value: string): string | undefined {
  const portable = value.trim().replaceAll("\\", "/");
  if (portable === "" || portable === "/" || portable === "." || portable === "./") return portable;
  if (/^[A-Za-z]:\//.test(portable) || portable.startsWith("//")) return undefined;
  try {
    if (portable.startsWith("./")) return `./${assertVaultPath(portable.slice(2))}`;
    return assertVaultPath(portable.replace(/^\/+/, ""));
  } catch {
    return undefined;
  }
}

function isNonVaultReference(value: string): boolean {
  return /^(?:https?:|data:|file:|blob:|\\\\)/i.test(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function isBareFileName(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && value !== "." && value !== "..";
}

function resolveWithinVault(base: string, reference: string): string {
  return assertVaultPath(path.posix.normalize(path.posix.join(base, reference)));
}

function joinVaultPath(...parts: string[]): string {
  const joined = path.posix.join(...parts.filter(Boolean));
  return joined ? assertVaultPath(joined) : "";
}

function assertVaultPath(value: string): string {
  const portable = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (/^[A-Za-z]:\//.test(portable)) throw new Error("附件路径超出当前 Vault。");
  const normalized = path.posix.normalize(portable);
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error("附件路径超出当前 Vault。");
  }
  return normalized === "." ? "" : normalized;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative));
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
