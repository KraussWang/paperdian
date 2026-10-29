import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import juice from "juice";
import katex from "katex";
import katexCss from "katex/dist/katex.min.css?raw";
import { marked } from "marked";
import { createFileSystemAttachmentResolver, type AttachmentResolver, type AttachmentResolverProvider } from "../attachments/VaultAttachmentResolver";
import { convertWebpToPng } from "../images/WebpTranscoder";
import { renderMarkdownDocument, replaceMarkdownImagesWithPlaceholders, resolveColorToken } from "./WechatMarkdownRenderer";
import type { WeChatThemeName } from "./wechatThemes";

const RESPONSIVE_IMAGE_STYLE = "display: block; max-width: 100%; height: auto; margin: 1em auto;";

export interface ArticleSourceFile { path: string }

export interface PrepareArticleOptions {
  author: string;
  theme?: WeChatThemeName;
  color?: "blue";
}

export interface ArticleMetadata {
  title: string;
  summary: string;
  author: string;
  sourceUrl: string;
}

export interface FrozenImage {
  id: string;
  sourcePath: string;
  fileName: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  hash: string;
  bytes: Uint8Array;
  alt?: string;
}

export interface PreparedArticle {
  sourcePath: string;
  sourceHash: string;
  metadata: ArticleMetadata;
  html: string;
  previewHtml: string;
  cover: FrozenImage;
  images: FrozenImage[];
  theme: { name: WeChatThemeName; color: "blue" };
  generatedAt: string;
  warnings?: string[];
}

export interface ArticlePreviewResult {
  previewHtml: string;
  prepared?: PreparedArticle;
  blockers: string[];
  imageCount: number;
  warnings?: string[];
}

export class ArticleValidationError extends Error {
  constructor(readonly issues: string[]) { super(`文章预检未通过：\n${issues.map(issue => `• ${issue}`).join("\n")}`); }
}

export class WeChatArticlePipeline {
  private readonly vaultPath: string;

  constructor(
    vaultPath: string,
    private readonly maxImageBytes = 10 * 1024 * 1024,
    private readonly reencode: (bytes: Uint8Array, mimeType: FrozenImage["mimeType"]) => Promise<{ bytes: Uint8Array; mimeType: FrozenImage["mimeType"] }> = reencodeForWechat,
    private readonly attachmentResolver?: AttachmentResolverProvider
  ) {
    this.vaultPath = path.resolve(vaultPath);
  }

  async prepare(file: ArticleSourceFile, options: PrepareArticleOptions): Promise<PreparedArticle> {
    const result = await this.preparePreview(file, options);
    if (!result.prepared) throw new ArticleValidationError(result.blockers);
    return result.prepared;
  }

  async preparePreview(file: ArticleSourceFile, options: PrepareArticleOptions): Promise<ArticlePreviewResult> {
    const sourceAbsolute = await this.resolveVaultFile(file.path, this.vaultPath);
    if (path.extname(sourceAbsolute).toLowerCase() !== ".md") throw new ArticleValidationError(["当前文件不是 Markdown。"]);
    const source = await readFile(sourceAbsolute, "utf8");
    const attachmentResolver = this.attachmentResolver
      ? await this.attachmentResolver()
      : createFileSystemAttachmentResolver(this.vaultPath);
    const blockers: string[] = [];
    const warnings: string[] = [];
    const theme = options.theme ?? "default";

    const placeholderPrefix = `PAPER_READING_IMAGE_${createHash("sha256").update(file.path).digest("hex").slice(0, 10)}_`;
    const replaced = replaceMarkdownImagesWithPlaceholders(source, placeholderPrefix);
    const frozenMath = freezeMathExpressions(replaced.markdown, `PAPER_READING_MATH_${createHash("sha256").update(file.path).digest("hex").slice(0, 10)}_`);
    const rendered = await renderMarkdownDocument(frozenMath.markdown, {
      theme,
      primaryColor: resolveColorToken(options.color ?? "blue"),
      author: options.author,
      keepTitle: false
    });
    const metadata = readMetadata(rendered.yamlData, source, options.author);
    if (!metadata.title) addBlockers(blockers, ["文章必须包含 frontmatter.title 或一级标题。"]);
    if (!rendered.contentHtml.trim()) addBlockers(blockers, ["文章正文不能为空。"]);

    const images: FrozenImage[] = [];
    let html = rendered.html;
    for (let index = 0; index < replaced.images.length; index += 1) {
      const image = replaced.images[index]!;
      if (isRemoteImageReference(image.originalPath)) {
        addBlockers(warnings, [`远程正文图片未上传，草稿中将显示缺图提示：${image.originalPath}`]);
        html = html.replaceAll(image.placeholder, unavailableImageHtml(image.originalPath, image.alt));
        continue;
      }
      try {
        const frozen = await this.freezeImage(image.originalPath, file.path, attachmentResolver, `body-${index + 1}`, image.alt);
        images.push(frozen);
        const img = `<img src="paperdian-asset://${frozen.id}" alt="${escapeHtml(frozen.alt ?? "")}" style="${RESPONSIVE_IMAGE_STYLE}" />`;
        html = html.replaceAll(image.placeholder, img);
      } catch (error) {
        if (!(error instanceof ArticleValidationError)) throw error;
        addBlockers(warnings, error.issues);
        html = html.replaceAll(image.placeholder, unavailableImageHtml(image.originalPath, image.alt));
      }
    }

    let cover: FrozenImage | undefined;
    const explicitCover = readString(rendered.yamlData.cover);
    const firstBodyImage = replaceMarkdownImagesWithPlaceholders(stripFrontmatter(source), "PAPER_READING_COVER_").images[0];
    const coverPath = explicitCover || firstBodyImage?.originalPath;
    if (coverPath) {
      try {
        cover = await this.freezeImage(coverPath, file.path, attachmentResolver, "cover", replaced.images.find(image => image.originalPath === coverPath)?.alt);
      } catch (error) {
        if (!(error instanceof ArticleValidationError)) throw error;
        addBlockers(blockers, error.issues.map(issue => `公众号封面不可用：${issue}`));
      }
    } else {
      addBlockers(blockers, ["缺少可上传的公众号封面图片；请设置 frontmatter.cover 或在正文中插入本地图片。"]);
    }
    for (const expression of frozenMath.expressions) {
      html = html.replaceAll(expression.placeholder, renderStaticMath(expression.source, expression.display));
    }
    if (frozenMath.expressions.length > 0) {
      html = juice(html, { extraCss: stripFontFaceRules(katexCss), inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: false });
    }
    const previewHtml = replaceAssetUrls(html, cover ? [cover, ...images] : images, image => `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString("base64")}`);
    if (blockers.length > 0 || !cover) return { previewHtml, blockers, imageCount: replaced.images.length, ...(warnings.length ? { warnings } : {}) };

    const sourceHasher = createHash("sha256")
      .update(source)
      .update(cover.hash)
      .update(images.map(image => image.hash).join("|"));
    if (theme !== "default") sourceHasher.update(`|theme:${theme}`);
    const sourceHash = sourceHasher.digest("hex");
    const prepared: PreparedArticle = {
      sourcePath: normalizeVaultPath(file.path),
      sourceHash,
      metadata,
      html: extractDraftContent(html),
      previewHtml,
      cover,
      images,
      theme: { name: theme, color: "blue" },
      generatedAt: new Date().toISOString(),
      ...(warnings.length ? { warnings } : {})
    };
    return { previewHtml, prepared, blockers, imageCount: replaced.images.length, ...(warnings.length ? { warnings } : {}) };
  }

  private async freezeImage(reference: string, sourcePath: string, resolver: AttachmentResolver, id: string, alt?: string): Promise<FrozenImage> {
    if (/^(https?:|data:|file:|\\\\)/i.test(reference.trim())) throw new ArticleValidationError([`图片必须位于当前 Vault：${reference}`]);
    let absolute: string;
    let bytes: Uint8Array;
    try {
      const resolved = await resolver.resolve(reference, normalizeVaultPath(sourcePath));
      if (!resolved) throw new Error("attachment not found");
      absolute = await this.resolveVaultFile(resolved, this.vaultPath);
      bytes = await readFile(absolute);
    } catch {
      throw new ArticleValidationError([`图片必须位于当前 Vault 且可访问：${reference}`]);
    }
    if (bytes.length === 0 || bytes.length > this.maxImageBytes) throw new ArticleValidationError([`图片大小无效：${reference}`]);
    let mimeType = detectImageMime(bytes);
    if (!mimeType) throw new ArticleValidationError([`无法从文件头识别图片格式：${reference}`]);
    if (mimeType === "image/webp") {
      try {
        const normalized = await this.reencode(bytes, mimeType);
        bytes = normalized.bytes;
        mimeType = normalized.mimeType;
      } catch (error) {
        throw new ArticleValidationError([`图片 WebP 转码失败：${reference}（${errorMessage(error)}）`]);
      }
      if (bytes.length === 0 || bytes.length > this.maxImageBytes) throw new ArticleValidationError([`图片 WebP 转码失败：${reference}（输出大小无效）`]);
      if (mimeType !== "image/png" || detectImageMime(bytes) !== "image/png") {
        throw new ArticleValidationError([`图片 WebP 转码失败：${reference}（输出不是有效 PNG）`]);
      }
    }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const extension = extensionForMime(mimeType);
    return {
      id,
      sourcePath: normalizeVaultPath(path.relative(await realpath(this.vaultPath), absolute)),
      fileName: `${path.basename(absolute, path.extname(absolute))}.${extension}`,
      mimeType,
      hash,
      bytes: new Uint8Array(bytes),
      alt
    };
  }

  private async resolveVaultFile(reference: string, baseDirectory: string): Promise<string> {
    const candidate = path.resolve(baseDirectory, reference.replaceAll("/", path.sep));
    assertWithin(this.vaultPath, candidate);
    const relative = path.relative(this.vaultPath, candidate);
    let cursor = this.vaultPath;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error("不允许经过符号链接。");
    }
    const canonicalVault = await realpath(this.vaultPath);
    const canonicalFile = await realpath(candidate);
    assertWithin(canonicalVault, canonicalFile);
    return canonicalFile;
  }
}

export function replaceAssetUrls(html: string, images: FrozenImage[], urlFor: (image: FrozenImage) => string): string {
  let output = html;
  for (const image of images) output = output.replaceAll(`paperdian-asset://${image.id}`, urlFor(image));
  return output;
}

function readMetadata(frontmatter: Record<string, unknown>, markdown: string, configuredAuthor: string): ArticleMetadata {
  return {
    title: readString(frontmatter.title) || readFirstHeading(markdown),
    summary: readSummary(markdown),
    author: readString(configuredAuthor),
    sourceUrl: readString(frontmatter.source) || readString(frontmatter.Source) || readString(frontmatter.sourceUrl)
  };
}

function readString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }

function readFirstHeading(markdown: string): string {
  return stripFrontmatter(markdown).match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() ?? "";
}

function isRemoteImageReference(reference: string): boolean {
  return /^(https?:)?\/\//i.test(reference.trim());
}

function unavailableImageHtml(reference: string, alt?: string): string {
  const description = alt?.trim() ? `${alt.trim()} · ${reference}` : reference;
  return `<span role="img" aria-label="图片无法预览" style="display:block;margin:1em auto;padding:1em;border:1px dashed #999;color:#666;text-align:center;word-break:break-all;">图片无法预览：${escapeHtml(description)}</span>`;
}

function addBlockers(target: string[], additions: string[]): void {
  for (const blocker of additions) if (!target.includes(blocker)) target.push(blocker);
}

function readSummary(markdown: string): string {
  const body = stripFrontmatter(markdown);
  const summarySection = sectionBody(body, "总结") ?? sectionBody(body, "一句话总结");
  if (!summarySection) return "";
  const paragraph = summarySection.trim().split(/\r?\n\s*\r?\n/, 1)[0]?.trim();
  if (!paragraph) return "";
  const html = marked.parse(paragraph, { async: false, gfm: true }) as string;
  return decodeHtmlText(html.replace(/<\/?(?:p|br|li|h\d)[^>]*>/gi, " ").replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function sectionBody(markdown: string, name: string): string | undefined {
  const heading = new RegExp(`^## ${escapeRegExp(name)}\\s*$`, "m").exec(markdown);
  if (!heading?.index && heading?.index !== 0) return undefined;
  const start = heading.index + heading[0].length;
  const next = /^##\s+/m.exec(markdown.slice(start));
  return markdown.slice(start, next?.index === undefined ? markdown.length : start + next.index);
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, encoded: string) => {
      const codePoint = encoded.startsWith("x") ? Number.parseInt(encoded.slice(1), 16) : Number.parseInt(encoded, 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    });
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/, "");
}

function normalizeVaultPath(value: string): string { return value.replaceAll("\\", "/"); }

function assertWithin(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error("路径超出当前 Vault。");
}

function detectImageMime(bytes: Uint8Array): FrozenImage["mimeType"] | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && Buffer.from(bytes.slice(0, 6)).toString("ascii").startsWith("GIF8")) return "image/gif";
  if (bytes.length >= 12 && Buffer.from(bytes.slice(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.slice(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function extensionForMime(mime: FrozenImage["mimeType"]): string {
  return mime === "image/jpeg" ? "jpg" : mime.slice("image/".length);
}

async function reencodeForWechat(bytes: Uint8Array, mimeType: FrozenImage["mimeType"]): Promise<{ bytes: Uint8Array; mimeType: FrozenImage["mimeType"] }> {
  if (mimeType !== "image/webp") return { bytes, mimeType };
  return { bytes: await convertWebpToPng(bytes), mimeType: "image/png" };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function extractDraftContent(documentHtml: string): string {
  const body = /<body\b([^>]*)>([\s\S]*?)<\/body>/i.exec(documentHtml);
  if (!body) throw new Error("公众号正文渲染结果缺少 body。");
  const content = body[2]!.trim().replace(
    /^(<div id="output"[^>]*><section class="container"[^>]*>)(?:\s*<p\b[^>]*>(?:\s|&nbsp;|&#160;|<br\s*\/?>)*<\/p>)+/i,
    "$1"
  );
  if (!/^<div id="output"(?:\s|>)/i.test(content)) throw new Error("公众号正文渲染结果缺少内容容器。");

  const bodyStyle = /\bstyle="([^"]*)"/i.exec(body[1]!)?.[1] ?? "";
  const inherited = bodyStyle.split(";").map(declaration => declaration.trim()).filter(declaration =>
    /^(?:background|color|counter-reset|font-family|font-size|line-height|letter-spacing|font-variant-numeric|word-break|text-align)\s*:/i.test(declaration)
  );
  if (inherited.length === 0) return content;
  return content.replace(/^<div id="output"([^>]*?)style="([^"]*)"/i, (_match, before: string, rootStyle: string) =>
    `<div id="output"${before}style="${rootStyle.trim()} ${inherited.join("; ")};"`
  );
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

interface FrozenMathExpression {
  placeholder: string;
  source: string;
  display: boolean;
}

function freezeMathExpressions(markdown: string, prefix: string): { markdown: string; expressions: FrozenMathExpression[] } {
  const expressions: FrozenMathExpression[] = [];
  const frontmatter = markdown.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  const header = frontmatter?.[0] ?? "";
  const body = header ? markdown.slice(header.length) : markdown;
  const pattern = /```[\s\S]*?```|`[^`\r\n]*`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\r\n]+?)\\\)|(?<!\\)\$(?!\$)([^$\r\n]+?)(?<!\\)\$/g;
  const output = body.replace(pattern, (match, dollarsBlock: string | undefined, bracketBlock: string | undefined, parenInline: string | undefined, dollarsInline: string | undefined) => {
    if (match.startsWith("`") && !match.startsWith("$$")) return match;
    const source = dollarsBlock ?? bracketBlock ?? parenInline ?? dollarsInline;
    if (source === undefined) return match;
    const placeholder = `${prefix}${expressions.length + 1}`;
    expressions.push({ placeholder, source: source.trim(), display: dollarsBlock !== undefined || bracketBlock !== undefined });
    return placeholder;
  });
  return { markdown: header + output, expressions };
}

function renderStaticMath(source: string, display: boolean): string {
  const content = katex.renderToString(source, { displayMode: display, throwOnError: false, strict: "ignore", trust: false, output: "htmlAndMathml" });
  if (display) return `<section class="paperdian-math is-display" style="margin:1em 0;padding:.6em 1em;text-align:center;overflow-x:auto">${content}</section>`;
  return `<span class="paperdian-math is-inline">${content}</span>`;
}

function stripFontFaceRules(css: string): string {
  return css.replace(/@font-face\s*\{[^}]*\}/g, "");
}
