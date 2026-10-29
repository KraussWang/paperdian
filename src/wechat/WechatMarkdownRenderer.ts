import hljs from "highlight.js";
import juice from "juice";
import { marked, Renderer, type Tokens } from "marked";
import { parseDocument } from "yaml";
import { maskMarkdownCode } from "../markdownCodeMask";
import { getWeChatThemeCss, isAcademicThemeName, isWeChatThemeName, type WeChatThemeName } from "./wechatThemes";

export interface ImagePlaceholder {
  originalPath: string;
  placeholder: string;
  alt?: string;
}

export interface RenderMarkdownDocumentOptions {
  author?: string;
  defaultTitle?: string;
  keepTitle?: boolean;
  primaryColor?: string;
  theme?: WeChatThemeName;
}

export interface RenderMarkdownDocumentResult {
  contentHtml: string;
  html: string;
  yamlData: Record<string, unknown>;
}

const PAPER_INFO_PATTERN = /<small>\r?\n论文题目：[^\r\n]+<br>\r?\n第一作者：[^\r\n]+<br>\r?\n通讯作者：[^\r\n]+<br>\r?\n通讯单位：[^\r\n]+<br>\r?\nDOI：(?:https:\/\/doi\.org\/\S+|文中未明确说明)\r?\n<\/small>/g;

export function resolveColorToken(value?: string): string | undefined {
  if (!value) return undefined;
  return value === "blue" ? "#0f4c81" : value;
}

export function replaceMarkdownImagesWithPlaceholders(markdown: string, placeholderPrefix: string): { images: ImagePlaceholder[]; markdown: string } {
  const images: ImagePlaceholder[] = [];
  let counter = 0;
  const visible = maskMarkdownCode(markdown);
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)|!\[\[([^\]\n]+)\]\]/g;
  const rewritten = markdown.replace(imagePattern, (full, markdownAlt: string | undefined, markdownPath: string | undefined, wikilink: string | undefined, offset: number) => {
    if (visible[offset] !== "!") return full;
    const parsed = wikilink ? parseImageWikilink(wikilink) : { originalPath: markdownPath ?? "", alt: markdownAlt ?? "" };
    if (!parsed) return full;
    const placeholder = `${placeholderPrefix}${++counter}`;
    images.push({ ...parsed, placeholder });
    return placeholder;
  });
  return { images, markdown: rewritten };
}

export async function renderMarkdownDocument(markdown: string, options: RenderMarkdownDocumentOptions = {}): Promise<RenderMarkdownDocumentResult> {
  if (options.theme !== undefined && !isWeChatThemeName(options.theme)) throw new Error(`不支持的公众号主题：${String(options.theme)}`);
  const parsed = parseFrontmatter(markdown);
  const renderer = new PaperdianRenderer();
  const paperInfo = freezePaperInfo(parsed.body);
  let contentHtml = await marked.parse(paperInfo.markdown, { async: true, gfm: true, breaks: false, renderer });
  contentHtml = restorePaperInfo(contentHtml, paperInfo.blocks);
  if (options.keepTitle === false) contentHtml = contentHtml.replace(/^<h1[\s\S]*?<\/h1>\s*/i, "");
  if (isAcademicThemeName(options.theme)) contentHtml = formatAcademicBlocks(contentHtml);
  const metadata = buildMetadata(parsed.attributes, parsed.body, options.defaultTitle, options.author);
  const color = options.primaryColor ?? "#0f4c81";
  const css = getWeChatThemeCss(options.theme ?? "default", color);
  const html = buildDocument(metadata, contentHtml, css);
  return { contentHtml, html: juice(html, { inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: true }), yamlData: parsed.attributes };
}

function formatAcademicBlocks(html: string): string {
  // Images have already been replaced by standalone placeholders in the publication pipeline.
  const image = String.raw`(?:<img\b[^>]*\/?>(?:\s*)|PAPER_READING_IMAGE_[a-f\d]+_\d+)`;
  const caption = new RegExp(`(<p>\\s*${image}\\s*<\\/p>\\s*)<p>((?:<em>)?图\\s*\\d+(?=[\\s：:．.、]|$)[\\s\\S]*?)<\\/p>`, "gi");
  const withCaptions = html.replace(caption, '$1<p class="paperdian-caption">$2</p>');
  return withCaptions.replace(
    /(?:<h[2-6]>论文信息<\/h[2-6]>|<p><strong>论文信息<\/strong><\/p>)\s*(<ul>[\s\S]*?<\/ul>)\s*$/i,
    '<section class="paperdian-paper-info paperdian-bibliography"><h2>论文信息</h2>$1</section>\n'
  );
}

function parseFrontmatter(markdown: string): { attributes: Record<string, unknown>; body: string } {
  const match = markdown.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return { attributes: {}, body: markdown };
  const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
  if (document.errors.length) throw new Error(`文章 frontmatter 无效：${document.errors[0]?.message ?? "YAML 格式错误"}`);
  const attributes: unknown = document.toJS({ maxAliasCount: 100 });
  if (attributes !== null && (typeof attributes !== "object" || Array.isArray(attributes))) {
    throw new Error("文章 frontmatter 必须是 YAML 对象。");
  }
  return { attributes: (attributes ?? {}) as Record<string, unknown>, body: markdown.slice(match[0].length) };
}

class PaperdianRenderer extends Renderer {
  private subscriptDepth = 0;

  code(token: Tokens.Code): string {
    const language = token.lang?.trim().split(/\s+/, 1)[0] ?? "";
    const highlighted = language && hljs.getLanguage(language)
      ? hljs.highlight(token.text, { language, ignoreIllegals: true }).value
      : escapeHtml(token.text);
    const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
    return `<pre><code${className}>${highlighted}</code></pre>\n`;
  }

  html(token: Tokens.HTML): string {
    if (!token.block && token.text === "<sub>") {
      this.subscriptDepth += 1;
      return token.text;
    }
    if (!token.block && token.text === "</sub>" && this.subscriptDepth > 0) {
      this.subscriptDepth -= 1;
      return token.text;
    }
    const escaped = escapeHtml(token.text);
    return token.block ? `<p>${escaped}</p>` : escaped;
  }
}

interface FrozenPaperInfo {
  placeholder: string;
  html: string;
}

function freezePaperInfo(markdown: string): { markdown: string; blocks: FrozenPaperInfo[] } {
  const blocks: FrozenPaperInfo[] = [];
  const rewritten = markdown.replace(PAPER_INFO_PATTERN, match => {
    const placeholder = `PAPER_READING_INFO_${blocks.length + 1}_PLACEHOLDER`;
    const lines = match.split(/\r?\n/).slice(1, -1).map(line => line.replace(/<br>$/, ""));
    blocks.push({
      placeholder,
      html: `<section class="paperdian-paper-info">${lines.map(line => `<span>${escapeHtml(line)}</span>`).join("")}</section>`
    });
    return placeholder;
  });
  return { markdown: rewritten, blocks };
}

function restorePaperInfo(html: string, blocks: FrozenPaperInfo[]): string {
  let output = html;
  for (const block of blocks) {
    const paragraph = new RegExp(`<p>\\s*${block.placeholder}\\s*<\\/p>\\s*`, "g");
    output = output.replace(paragraph, `${block.html}\n`);
  }
  return output;
}

function parseImageWikilink(value: string): { originalPath: string; alt?: string } | undefined {
  const [rawPath, rawAlias] = value.split("|", 2);
  const imagePath = rawPath?.trim() ?? "";
  if (!/\.(?:png|jpe?g|gif|webp)(?:#.*)?$/i.test(imagePath)) return undefined;
  const alias = rawAlias?.trim();
  return { originalPath: imagePath, alt: alias && !/^\d+(?:x\d+)?$/i.test(alias) ? alias : "" };
}

function buildMetadata(attributes: Record<string, unknown>, body: string, defaultTitle = "document", configuredAuthor?: string): { title: string; author?: string; description?: string } {
  const title = readString(attributes.title) || body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || defaultTitle;
  const author = configuredAuthor === undefined ? readString(attributes.author) || undefined : readString(configuredAuthor) || undefined;
  const description = readString(attributes.summary) || readString(attributes.description) || undefined;
  return { title, author, description };
}

function buildDocument(metadata: { title: string; author?: string; description?: string }, contentHtml: string, css: string): string {
  const meta = [
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(metadata.title)}</title>`,
    metadata.author ? `<meta name="author" content="${escapeAttribute(metadata.author)}">` : "",
    metadata.description ? `<meta name="description" content="${escapeAttribute(metadata.description)}">` : ""
  ].filter(Boolean).join("\n");
  return `<!doctype html>\n<html>\n<head>\n${meta}\n<style>${css}</style>\n</head>\n<body>\n<div id="output"><section class="container">${contentHtml}</section></div>\n</body>\n</html>`;
}

function readString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function escapeAttribute(value: string): string { return escapeHtml(value).replace(/`/g, "&#96;"); }
