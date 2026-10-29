import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFileSystemAttachmentResolver, type AttachmentResolver } from "../attachments/VaultAttachmentResolver";

export interface DeepReadingOutputFinalizerRequest {
  vaultPath: string;
  sourceNotePath?: string;
  startedAt: Date;
  attachmentResolver?: AttachmentResolver;
}

export interface DeepReadingOutputFinalization {
  relativePath?: string;
  repairs: string[];
  issues: string[];
}

interface FigureImage {
  number: number;
  path: string;
  alt: string;
}

const PAPER_INFO_FIELDS = ["论文题目", "第一作者", "通讯作者", "通讯单位", "DOI"] as const;
const IMAGE_LINE = /^\s*!\[([^\]]*)]\((.+)\)\s*$/;

export async function finalizeDeepReadingOutput(request: DeepReadingOutputFinalizerRequest): Promise<DeepReadingOutputFinalization> {
  const repairs: string[] = [];
  const issues: string[] = [];
  const vaultPath = path.resolve(request.vaultPath);
  const attachmentResolver = request.attachmentResolver ?? createFileSystemAttachmentResolver(vaultPath, "raw/assets");
  const outputRoot = path.join(vaultPath, "output");
  const article = await findCurrentOutput(outputRoot, request.startedAt);
  if (!article) return { repairs, issues: ["本轮未在 output/ 根目录生成精读 Markdown。"] };
  if (!request.sourceNotePath) return { relativePath: article.relativePath, repairs, issues: ["未固定当前原文笔记，无法自动整理精读输出。"] };

  const sourcePath = path.resolve(vaultPath, request.sourceNotePath.replaceAll("/", path.sep));
  if (!isWithin(vaultPath, sourcePath)) return { relativePath: article.relativePath, repairs, issues: ["原文笔记路径超出当前 Vault。"] };

  let markdown: string;
  let source: string;
  try {
    [markdown, source] = await Promise.all([readFile(article.absolutePath, "utf8"), readFile(sourcePath, "utf8")]);
  } catch (error) {
    return { relativePath: article.relativePath, repairs, issues: [`无法读取精读稿或原文：${errorMessage(error)}`] };
  }

  let next = normalizeFrontmatter(markdown, source, repairs, issues);
  next = removeLegacyTitleHeading(next, repairs);
  next = normalizePaperInfo(next, repairs);
  next = normalizeBold(next, repairs);
  const figures = await collectSourceFigureImages(source, sourcePath, vaultPath, attachmentResolver);
  next = normalizeFigurePlacement(next, figures, outputRoot, repairs);

  if (next !== markdown) await writeFile(article.absolutePath, next, "utf8");
  return { relativePath: article.relativePath, repairs, issues };
}

async function findCurrentOutput(outputRoot: string, startedAt: Date): Promise<{ absolutePath: string; relativePath: string } | undefined> {
  let entries;
  try { entries = await readdir(outputRoot, { withFileTypes: true }); }
  catch { return undefined; }
  const candidates: Array<{ absolutePath: string; relativePath: string; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const absolutePath = path.join(outputRoot, entry.name);
    try {
      const info = await stat(absolutePath);
      if (info.mtimeMs >= startedAt.getTime() - 1_000) {
        candidates.push({ absolutePath, relativePath: path.posix.join("output", entry.name), modifiedAt: info.mtimeMs });
      }
    } catch { /* The validator reports unreadable output. */ }
  }
  candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return candidates[0];
}

function normalizeFrontmatter(markdown: string, source: string, repairs: string[], issues: string[]): string {
  const title = parseFrontmatterScalars(markdown).get("title");
  const sourceFields = parseFrontmatterScalars(source);
  const sourceValue = sourceFields.get("source");
  const publishedValue = sourceFields.get("published");
  if (!title) issues.push("精读文件缺少 frontmatter.title，无法自动修正 title。");
  if (sourceValue === undefined) issues.push("原文笔记缺少 source，无法自动修正该属性。");
  if (publishedValue === undefined) issues.push("原文笔记缺少 published，无法自动修正该属性。");
  if (!title || sourceValue === undefined || publishedValue === undefined) return markdown;

  const block = [
    "---",
    `title: ${quoteYamlString(title)}`,
    `source: ${quoteYamlString(sourceValue)}`,
    `published: ${quoteYamlString(publishedValue)}`,
    "---"
  ].join("\n");
  const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
  const next = match ? block + "\n" + markdown.slice(match[0].length) : block + "\n\n" + markdown;
  if (next !== markdown) repairs.push("已统一 title/source/published 属性。");
  return next;
}

function removeLegacyTitleHeading(markdown: string, repairs: string[]): string {
  const title = parseFrontmatterScalars(markdown).get("title");
  if (!title) return markdown;
  const heading = /^#\s+(.+?)\s*\r?\n(?:\r?\n)?/m.exec(stripFrontmatter(markdown));
  if (!heading || heading[1]?.trim() !== title) return markdown;
  const bodyStart = markdown.indexOf(heading[0], markdown.indexOf("---", 3) + 3);
  if (bodyStart < 0) return markdown;
  const next = markdown.slice(0, bodyStart) + markdown.slice(bodyStart + heading[0].length);
  repairs.push("已移除与 frontmatter.title 重复的一级总标题。");
  return next;
}

function normalizePaperInfo(markdown: string, repairs: string[]): string {
  const match = markdown.match(/<small>\s*([\s\S]*?)\s*<\/small>/i);
  if (!match) return markdown;
  const lines = (match[1] ?? "").replace(/<br\s*\/?>/gi, "\n").split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const values = new Map<string, string>();
  for (const line of lines) {
    const field = PAPER_INFO_FIELDS.find(candidate => line.startsWith(`${candidate}：`));
    if (!field || values.has(field)) return markdown;
    values.set(field, line.slice(field.length + 1).trim());
  }
  if (PAPER_INFO_FIELDS.some(field => !values.get(field))) return markdown;
  const body = PAPER_INFO_FIELDS.map((field, index) => `${field}：${values.get(field)}${index < PAPER_INFO_FIELDS.length - 1 ? "<br>" : ""}`);
  const normalized = ["<small>", ...body, "</small>"].join("\n");
  const next = markdown.slice(0, match.index) + normalized + markdown.slice((match.index ?? 0) + match[0].length);
  if (next !== markdown) repairs.push("已规范论文信息区的字段顺序与换行。");
  return next;
}

export function normalizeBoldMarkdown(markdown: string): string {
  const lines = markdown.split(/(\r?\n)/);
  let fenced = false;
  return lines.map(part => {
    if (/^\r?\n$/.test(part)) return part;
    if (/^\s*```/.test(part)) { fenced = !fenced; return part; }
    if (fenced) return part;
    return part.replace(/\*\*([^*\r\n]+?)\*\*/g, (full, raw: string, offset: number, input: string) => {
      const content = raw.trim();
      if (!content) return full;
      const nextCharacter = input[offset + full.length] ?? "";
      const separator = /[：:）)\]】》」』]$/u.test(content) && /[\p{L}\p{N}]/u.test(nextCharacter) ? " " : "";
      return `**${content}**${separator}`;
    });
  }).join("");
}

function normalizeBold(markdown: string, repairs: string[]): string {
  const next = normalizeBoldMarkdown(markdown);
  if (next !== markdown) repairs.push("已修正粗体标记内侧空格和中文标点边界。");
  return next;
}

export async function collectSourceFigureImages(source: string, sourcePath: string, vaultPath: string, attachmentResolver?: AttachmentResolver): Promise<Map<number, FigureImage>> {
  const resolver = attachmentResolver ?? createFileSystemAttachmentResolver(vaultPath, "raw/assets");
  const candidates: FigureImage[] = [];
  for (const match of source.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
    const [rawPath, alias = ""] = (match[1] ?? "").split("|", 2);
    if (rawPath) candidates.push(...figureCandidate(rawPath.trim(), alias.trim()));
  }
  for (const match of source.matchAll(/!\[([^\]]*)]\(([^)\n]+)\)/g)) {
    candidates.push(...figureCandidate(cleanMarkdownTarget(match[2] ?? ""), match[1] ?? ""));
  }

  const grouped = new Map<number, FigureImage[]>();
  for (const candidate of candidates) {
    const resolved = await resolveAsset(candidate.path, sourcePath, vaultPath, resolver);
    if (!resolved) continue;
    const relative = path.relative(path.join(vaultPath, "output"), resolved).replaceAll(path.sep, "/");
    const normalized = { ...candidate, path: relative };
    grouped.set(candidate.number, [...grouped.get(candidate.number) ?? [], normalized]);
  }

  const result = new Map<number, FigureImage>();
  for (const [number, images] of grouped) {
    const unique = [...new Map(images.map(image => [image.path.toLowerCase(), image])).values()];
    if (unique.length === 1 && unique[0]) result.set(number, unique[0]);
  }
  return result;
}

function figureCandidate(reference: string, alt: string): FigureImage[] {
  const label = `${alt} ${path.basename(reference)}`;
  if (/extended\s+data|supp(?:lementary)?/i.test(label)) return [];
  const number = label.match(/(?:figure|fig)\.?\s*[-_ ]?(\d+)/i)?.[1];
  return number ? [{ number: Number(number), path: reference, alt: alt || `Fig. ${number}` }] : [];
}

async function resolveAsset(reference: string, sourcePath: string, vaultPath: string, resolver: AttachmentResolver): Promise<string | undefined> {
  const sourceVaultPath = path.relative(vaultPath, sourcePath).replaceAll(path.sep, "/");
  // Figure repair is optional. A resolver failure must not discard a valid
  // generated article; validation will surface unresolved images separately.
  let resolved: string | undefined;
  try { resolved = await resolver.resolve(reference, sourceVaultPath); }
  catch { return undefined; }
  if (!resolved) return undefined;
  const absolute = path.resolve(vaultPath, resolved.replaceAll("/", path.sep));
  if (!isWithin(vaultPath, absolute)) return undefined;
  try { return (await stat(absolute)).isFile() ? absolute : undefined; }
  catch { return undefined; }
}

function normalizeFigurePlacement(markdown: string, figures: Map<number, FigureImage>, outputRoot: string, repairs: string[]): string {
  const headingPattern = /^###\s+Figure\s+(\d+)\b[^\r\n]*$/gim;
  const headings = [...markdown.matchAll(headingPattern)];
  let next = markdown;
  let changed = false;
  for (let index = headings.length - 1; index >= 0; index -= 1) {
    const heading = headings[index];
    const number = Number(heading[1]);
    const expected = figures.get(number);
    if (!expected || heading.index === undefined) continue;
    const originalStart = heading.index + heading[0].length;
    const originalEnd = headings[index + 1]?.index ?? findNextSecondLevelHeading(markdown, originalStart) ?? markdown.length;
    const section = markdown.slice(originalStart, originalEnd);
    const expectedAbsolute = path.resolve(outputRoot, expected.path.replaceAll("/", path.sep));
    const retained = section.split(/\r?\n/).filter(line => {
      const image = line.match(IMAGE_LINE);
      if (!image) return true;
      const imageNumber = (image[1] ?? "").match(/(?:figure|fig)\.?\s*(\d+)/i)?.[1];
      const imagePath = path.resolve(outputRoot, cleanMarkdownTarget(image[2] ?? "").replaceAll("/", path.sep));
      return Number(imageNumber) !== number && imagePath !== expectedAbsolute;
    }).join("\n").replace(/^\s*/, "");
    const alt = expected.alt.replaceAll("]", "\\]");
    const target = expected.path.includes(" ") ? `<${expected.path}>` : expected.path;
    const replacement = `\n\n![${alt}](${target})\n\n${retained}`;
    if (replacement !== section) changed = true;
    next = next.slice(0, originalStart) + replacement + next.slice(originalEnd);
  }
  if (changed) repairs.push("已将主文 Figure 图片移动到对应标题下方。");
  return next;
}

function findNextSecondLevelHeading(markdown: string, from: number): number | undefined {
  const match = /^##\s+/m.exec(markdown.slice(from));
  return match?.index === undefined ? undefined : from + match.index;
}

export function parseFrontmatterScalars(markdown: string): Map<string, string> {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const fields = new Map<string, string>();
  if (!block) return fields;
  for (const line of (block[1] ?? "").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):[\t ]*(.*)$/);
    if (!match?.[1]) continue;
    fields.set(match[1], semanticYamlScalar(match[2] ?? ""));
  }
  return fields;
}

function semanticYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    if (trimmed.startsWith('"')) {
      try { return String(JSON.parse(trimmed)); }
      catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function quoteYamlString(value: string): string { return JSON.stringify(value); }

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

function cleanMarkdownTarget(value: string): string {
  let result = value.trim().replace(/^<|>$/g, "");
  const titled = result.match(/^([^\s]+)\s+["'][^"']*["']$/);
  if (titled?.[1]) result = titled[1];
  try { return decodeURIComponent(result.split("#", 1)[0] ?? result); }
  catch { return result; }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !(relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative));
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
