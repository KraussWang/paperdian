import { createHash } from "node:crypto";
import path from "node:path";
import { maskMarkdownCode } from "../markdownCodeMask";
import { convertWebpToPng as convertWebpBytesToPng } from "../images/WebpTranscoder";
import { VaultAttachmentResolver, cleanAttachmentReference, type AttachmentResolver, type AttachmentResolverProvider } from "./VaultAttachmentResolver";

export type SupportedImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface AttachmentFile {
  path: string;
  extension: string;
}

export interface AttachmentVault {
  read(file: AttachmentFile): Promise<string>;
  readBinary(file: AttachmentFile): Promise<ArrayBuffer>;
  createBinary(filePath: string, data: ArrayBuffer): Promise<AttachmentFile>;
  ensureFolder?(folderPath: string): Promise<void>;
  getFileByPath(filePath: string): AttachmentFile | null;
  modify(file: AttachmentFile, data: string): Promise<void>;
}

export interface RemoteImageResponse {
  status: number;
  headers?: Record<string, string>;
  arrayBuffer: ArrayBuffer;
}

export interface AttachmentNormalizationDependencies {
  vault: AttachmentVault;
  download: (url: string) => Promise<RemoteImageResponse>;
  attachmentResolver?: AttachmentResolverProvider;
  convertWebpToPng?: (bytes: Uint8Array) => Promise<Uint8Array>;
  maxImageBytes?: number;
}

export interface AttachmentNormalizationFailure {
  reference: string;
  message: string;
}

export interface AttachmentNormalizationResult {
  sourcePath: string;
  changed: boolean;
  downloadedCount: number;
  convertedCount: number;
  unchangedCount: number;
  outputPaths: string[];
  failures: AttachmentNormalizationFailure[];
}

interface ImageReference {
  target: string;
  targetStart: number;
  targetEnd: number;
  format: "frontmatter" | "markdown" | "wikilink";
}

interface ResolvedReference extends ImageReference {
  kind: "remote" | "local";
  key: string;
  localPath?: string;
}

interface ProcessedAttachment {
  outputPath: string;
  action: "downloaded" | "converted" | "unchanged";
}

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export class AttachmentNormalizer {
  private readonly maxImageBytes: number;

  constructor(private readonly dependencies: AttachmentNormalizationDependencies) {
    this.maxImageBytes = dependencies.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  async normalize(file: AttachmentFile): Promise<AttachmentNormalizationResult> {
    if (file.extension.toLowerCase() !== "md") throw new Error("当前文件不是 Markdown。");
    const source = await this.dependencies.vault.read(file);
    const references = collectImageReferences(source);
    const result: AttachmentNormalizationResult = {
      sourcePath: normalizeVaultPath(file.path),
      changed: false,
      downloadedCount: 0,
      convertedCount: 0,
      unchangedCount: 0,
      outputPaths: [],
      failures: []
    };
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    const processed = new Map<string, ProcessedAttachment>();
    const outputPaths = new Set<string>();
    const resolver = this.dependencies.attachmentResolver
      ? await this.dependencies.attachmentResolver()
      : new VaultAttachmentResolver({ fileExists: filePath => this.dependencies.vault.getFileByPath(filePath) !== null });

    for (const reference of references) {
      try {
        const resolved = await this.resolveReference(reference, file.path, resolver);
        if (!resolved) {
          result.unchangedCount += 1;
          continue;
        }
        let attachment = processed.get(resolved.key);
        if (!attachment) {
          attachment = await this.processReference(resolved, file.path, resolver);
          processed.set(resolved.key, attachment);
          if (attachment.action === "downloaded") result.downloadedCount += 1;
          else if (attachment.action === "converted") result.convertedCount += 1;
          else result.unchangedCount += 1;
          if (attachment.action !== "unchanged") outputPaths.add(attachment.outputPath);
        }
        const canonicalPath = resolver.relativePath(file.path, attachment.outputPath, reference.format === "markdown");
        if (attachment.action !== "unchanged" || cleanAttachmentReference(canonicalPath) !== cleanAttachmentReference(reference.target)) {
          replacements.push({
            start: reference.targetStart,
            end: reference.targetEnd,
            value: canonicalPath
          });
        }
      } catch (error) {
        result.failures.push({ reference: reference.target, message: errorMessage(error) });
      }
    }

    if (replacements.length > 0) {
      const updated = applyReplacements(source, replacements);
      if (updated !== source) {
        await this.dependencies.vault.modify(file, updated);
        result.changed = true;
      }
    }
    result.outputPaths = [...outputPaths].sort();
    return result;
  }

  private async resolveReference(reference: ImageReference, notePath: string, resolver: AttachmentResolver): Promise<ResolvedReference | undefined> {
    const target = cleanReference(reference.target);
    if (/^https?:\/\//i.test(target)) {
      return { ...reference, kind: "remote", key: `remote:${stripUrlFragment(target)}` };
    }
    if (!target || /^(?:data:|file:|blob:)/i.test(target)) return undefined;
    const localPath = await resolver.resolve(target, notePath);
    const file = localPath ? this.dependencies.vault.getFileByPath(localPath) : null;
    if (!file) throw new Error(`附件不存在：${target}`);
    return { ...reference, kind: "local", key: `local:${localPath}`, localPath };
  }

  private async processReference(reference: ResolvedReference, notePath: string, resolver: AttachmentResolver): Promise<ProcessedAttachment> {
    if (reference.kind === "remote") return this.processRemote(reference.target, notePath, resolver);
    const sourcePath = reference.localPath!;
    const sourceFile = this.dependencies.vault.getFileByPath(sourcePath);
    if (!sourceFile) throw new Error(`附件不存在：${reference.target}`);
    const sourceBytes = new Uint8Array(await this.dependencies.vault.readBinary(sourceFile));
    validateImageSize(sourceBytes, this.maxImageBytes, reference.target);
    const mimeType = detectImageMime(sourceBytes);
    if (!mimeType) throw new Error(`无法识别图片格式：${reference.target}`);
    if (mimeType !== "image/webp") return { outputPath: sourcePath, action: "unchanged" };
    const pngBytes = await this.convertWebpToPng(sourceBytes);
    validateImageSize(pngBytes, this.maxImageBytes, reference.target);
    validatePng(pngBytes, reference.target);
    const outputPath = await this.writeUniqueImage(sourcePath, pngBytes, "png");
    return { outputPath, action: "converted" };
  }

  private async processRemote(url: string, notePath: string, resolver: AttachmentResolver): Promise<ProcessedAttachment> {
    const cleanUrl = stripUrlFragment(cleanReference(url));
    const response = await this.dependencies.download(cleanUrl);
    if (response.status < 200 || response.status >= 300) throw new Error(`下载失败（HTTP ${response.status}）。`);
    const contentLength = Number(response.headers?.["content-length"] ?? response.headers?.["Content-Length"] ?? "");
    if (Number.isFinite(contentLength) && contentLength > this.maxImageBytes) throw new Error(`图片超过 ${this.maxImageBytes / 1024 / 1024} MB。`);
    const bytes = new Uint8Array(response.arrayBuffer);
    validateImageSize(bytes, this.maxImageBytes, url);
    const mimeType = detectImageMime(bytes);
    if (!mimeType) throw new Error("下载内容不是支持的 PNG、JPG、GIF 或 WebP 图片。");
    const outputBytes = mimeType === "image/webp" ? await this.convertWebpToPng(bytes) : bytes;
    const outputMime = mimeType === "image/webp" ? "png" : extensionForMime(mimeType);
    validateImageSize(outputBytes, this.maxImageBytes, url);
    if (mimeType === "image/webp") validatePng(outputBytes, url);
    const outputPath = await this.writeUniqueImage(resolver.destinationPath(fileNameFromUrl(cleanUrl), notePath), outputBytes, outputMime);
    return { outputPath, action: "downloaded" };
  }

  private async convertWebpToPng(bytes: Uint8Array): Promise<Uint8Array> {
    if (this.dependencies.convertWebpToPng) return this.dependencies.convertWebpToPng(bytes);
    return convertWebpBytesToPng(bytes);
  }

  private async writeUniqueImage(candidatePath: string, bytes: Uint8Array, extension: string): Promise<string> {
    const normalizedCandidate = replaceExtension(normalizeVaultPath(candidatePath), extension);
    const bytesHash = createHash("sha256").update(bytes).digest("hex");
    for (let index = 0; index < 10_000; index += 1) {
      const currentPath = index === 0 ? normalizedCandidate : addSuffix(normalizedCandidate, index);
      const existing = this.dependencies.vault.getFileByPath(currentPath);
      if (existing) {
        const existingBytes = new Uint8Array(await this.dependencies.vault.readBinary(existing));
        if (createHash("sha256").update(existingBytes).digest("hex") === bytesHash) return currentPath;
        continue;
      }
      const parent = path.posix.dirname(currentPath);
      if (parent !== ".") await this.dependencies.vault.ensureFolder?.(parent);
      await this.dependencies.vault.createBinary(currentPath, toArrayBuffer(bytes));
      return currentPath;
    }
    throw new Error("无法为附件生成不冲突的文件名。");
  }
}

export function collectImageReferences(markdown: string): ImageReference[] {
  const references: ImageReference[] = [];
  const visible = maskMarkdownCode(markdown);
  const frontmatter = markdown.match(/^---\s*\r?\n[\s\S]*?^---\s*(?:\r?\n|$)/m);
  if (frontmatter) {
    const coverPattern = /^(\s*cover\s*:\s*)(["']?)([^\r\n]*?)(\2)\s*$/gim;
    for (const match of frontmatter[0].matchAll(coverPattern)) {
      const value = match[3]?.trim();
      if (!value || match.index === undefined) continue;
      const valueStart = match.index + (match[0].indexOf(match[3] ?? "") || 0);
      references.push({ target: value, targetStart: valueStart, targetEnd: valueStart + value.length, format: "frontmatter" });
    }
  }
  const markdownPattern = /!\[[^\]\n]*\]\(([^)\n]+)\)/g;
  for (const match of visible.matchAll(markdownPattern)) {
    const raw = match[1] ?? "";
    const target = markdownLinkTarget(raw);
    if (!target || match.index === undefined) continue;
    const offset = raw.indexOf(target);
    references.push({ target, targetStart: match.index + match[0].indexOf(raw) + offset, targetEnd: match.index + match[0].indexOf(raw) + offset + target.length, format: "markdown" });
  }
  const wikilinkPattern = /!\[\[([^\]\n]+)\]\]/g;
  for (const match of visible.matchAll(wikilinkPattern)) {
    const raw = match[1] ?? "";
    const target = raw.split("|", 1)[0]?.trim() ?? "";
    if (!target || match.index === undefined) continue;
    const offset = raw.indexOf(target);
    references.push({ target, targetStart: match.index + match[0].indexOf(raw) + offset, targetEnd: match.index + match[0].indexOf(raw) + offset + target.length, format: "wikilink" });
  }
  return references.sort((left, right) => left.targetStart - right.targetStart);
}

function markdownLinkTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("<")) return trimmed.match(/^<([^>]+)>/)?.[1]?.trim() ?? "";
  return trimmed.split(/\s+/, 1)[0] ?? "";
}

function cleanReference(value: string): string {
  let result = value.trim().replace(/^<|>$/g, "");
  try { result = decodeURIComponent(result); } catch { /* Keep malformed percent-encoding unchanged. */ }
  return result.split("#", 1)[0] ?? result;
}

function stripUrlFragment(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.split("#", 1)[0] ?? value;
  }
}

function applyReplacements(source: string, replacements: Array<{ start: number; end: number; value: string }>): string {
  let output = source;
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
    output = `${output.slice(0, replacement.start)}${replacement.value}${output.slice(replacement.end)}`;
  }
  return output;
}

function fileNameFromUrl(url: string): string {
  let name = "attachment";
  try { name = decodeURIComponent(path.posix.basename(new URL(url).pathname)) || name; } catch { /* Use fallback name. */ }
  name = name.replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+|\.+$/g, "").trim() || "attachment";
  return name;
}

function addSuffix(filePath: string, index: number): string {
  const extension = path.posix.extname(filePath);
  return `${filePath.slice(0, -extension.length)}-${index}${extension}`;
}

function replaceExtension(filePath: string, extension: string): string {
  const currentExtension = path.posix.extname(filePath);
  const base = currentExtension ? filePath.slice(0, -currentExtension.length) : filePath;
  return `${base}.${extension}`;
}

function detectImageMime(bytes: Uint8Array): SupportedImageMime | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && Buffer.from(bytes.slice(0, 6)).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function extensionForMime(mime: SupportedImageMime): string {
  return mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
}

function validateImageSize(bytes: Uint8Array, maxBytes: number, reference: string): void {
  if (bytes.length === 0 || bytes.length > maxBytes) throw new Error(`图片大小无效：${reference}`);
}

function validatePng(bytes: Uint8Array, reference: string): void {
  if (detectImageMime(bytes) !== "image/png") throw new Error(`图片转换失败，输出不是有效 PNG：${reference}`);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function normalizeVaultPath(value: string): string { return value.replaceAll("\\", "/").replace(/^\/+/, ""); }

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
