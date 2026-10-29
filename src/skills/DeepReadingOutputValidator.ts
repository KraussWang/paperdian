import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { marked } from "marked";
import { createFileSystemAttachmentResolver, type AttachmentResolver } from "../attachments/VaultAttachmentResolver";
import { collectSourceFigureImages, parseFrontmatterScalars } from "./DeepReadingOutputFinalizer";

const REQUIRED_SECTION_GROUPS = [
  ["研究背景"],
  ["图表解读"],
  ["实验样品制备方法"],
  ["知识拓展：创新点分析"],
  ["总结", "一句话总结"]
];
const REQUIRED_METADATA_FIELDS = ["title", "source", "published"];
const PAPER_INFO = /<small>\r?\n论文题目：[^\r\n]+<br>\r?\n第一作者：[^\r\n]+<br>\r?\n通讯作者：[^\r\n]+<br>\r?\n通讯单位：[^\r\n]+<br>\r?\nDOI：(?:https:\/\/doi\.org\/\S+|文中未明确说明)\r?\n<\/small>/;
const IMAGE_LINE = /^\s*!\[[^\]]*]\((?:<[^>\r\n]+>|[^)\r\n]+)\)\s*$/;

export interface DeepReadingOutputRequest {
  vaultPath: string;
  sourceNotePath?: string;
  startedAt: Date;
  attachmentResolver?: AttachmentResolver;
}

export type DeepReadingOutputValidation =
  | { ok: true; relativePath: string; warnings: string[] }
  | { ok: false; issues: string[] };

interface SourceDocument {
  markdown: string;
  path: string;
  fields: Map<string, string>;
}

interface DirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

interface MarkdownImage {
  alt: string;
  path: string;
}

export async function validateDeepReadingOutput(request: DeepReadingOutputRequest): Promise<DeepReadingOutputValidation> {
  const outputRoot = path.resolve(request.vaultPath, "output");
  const attachmentResolver = request.attachmentResolver ?? createFileSystemAttachmentResolver(request.vaultPath, "raw/assets");
  let entries;
  try { entries = await readdir(outputRoot, { withFileTypes: true }); }
  catch (error) {
    if (isMissing(error)) return { ok: false, issues: ["本轮未在 output/ 根目录生成精读 Markdown。"] };
    return { ok: false, issues: [`无法检查精读输出：${errorMessage(error)}`] };
  }

  const changed = await collectChangedEntries(outputRoot, entries, request.startedAt);
  const markdowns = changed.filter(entry => entry.kind === "file" && entry.name.toLowerCase().endsWith(".md"));
  if (!markdowns.length) return { ok: false, issues: ["本轮未在 output/ 根目录生成精读 Markdown。", ...validateChangedEntries(changed, "")] };
  markdowns.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const article = markdowns[0];

  let markdown: string;
  try { markdown = await readFile(article.path, "utf8"); }
  catch (error) { return { ok: false, issues: [`无法读取精读输出：${errorMessage(error)}`] }; }
  if (!markdown.trim()) return { ok: false, issues: ["本轮生成的精读 Markdown 为空。"] };

  const source = await readSourceDocument(request.vaultPath, request.sourceNotePath);
  const warnings = validateChangedEntries(changed, article.name);
  if ("issues" in source) warnings.push(...source.issues);
  else warnings.push(...await validateMarkdown(markdown, article.name, outputRoot, request.vaultPath, source, attachmentResolver));
  return { ok: true, relativePath: path.posix.join("output", article.name), warnings: unique(warnings) };
}

async function readSourceDocument(vaultPath: string, sourceNotePath: string | undefined): Promise<SourceDocument | { issues: string[] }> {
  if (!sourceNotePath) return { issues: ["未固定当前原文笔记，无法校验笔记属性。"] };
  const sourcePath = path.resolve(vaultPath, sourceNotePath.replaceAll("/", path.sep));
  if (!isWithin(vaultPath, sourcePath)) return { issues: ["原文笔记路径超出当前 Vault。"] };
  let markdown: string;
  try { markdown = await readFile(sourcePath, "utf8"); }
  catch (error) { return { issues: [`无法读取原文笔记属性：${errorMessage(error)}`] }; }
  const fields = parseFrontmatterScalars(markdown);
  const missing = ["source", "published"].filter(field => !fields.has(field));
  return missing.length ? { issues: [`原文笔记缺少属性：${missing.join("、")}。`] } : { markdown, path: sourcePath, fields };
}

async function collectChangedEntries(root: string, entries: readonly DirectoryEntry[], startedAt: Date): Promise<Array<{ name: string; path: string; kind: "file" | "directory"; modifiedAt: number }>> {
  const changed: Array<{ name: string; path: string; kind: "file" | "directory"; modifiedAt: number }> = [];
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const entryPath = path.join(root, entry.name);
    try {
      const info = await stat(entryPath);
      if (info.mtimeMs >= startedAt.getTime() - 1_000) changed.push({ name: entry.name, path: entryPath, kind: entry.isDirectory() ? "directory" : "file", modifiedAt: info.mtimeMs });
    } catch (error) { if (!isMissing(error)) throw error; }
  }
  return changed;
}

function validateChangedEntries(changed: Array<{ name: string; kind: "file" | "directory" }>, articleName: string): string[] {
  const issues: string[] = [];
  for (const entry of changed) {
    if (entry.kind === "directory") issues.push(`本轮不应在 output/ 中创建目录：${entry.name}。`);
    else if (entry.name !== articleName) issues.push(`本轮不应在 output/ 中创建附属文件：${entry.name}。`);
  }
  return issues;
}

async function validateMarkdown(markdown: string, fileName: string, outputRoot: string, vaultPath: string, source: SourceDocument, attachmentResolver: AttachmentResolver): Promise<string[]> {
  const issues: string[] = [];
  const metadata = parseFrontmatterScalars(markdown);
  const metadataKeys = frontmatterKeys(markdown);
  if (!metadataKeys) issues.push("精读文件缺少 YAML frontmatter。");
  else {
    if (metadataKeys.length !== REQUIRED_METADATA_FIELDS.length || metadataKeys.some(key => !REQUIRED_METADATA_FIELDS.includes(key))) {
      issues.push("精读文件的 frontmatter 只能包含 title、source、published。");
    }
    const title = metadata.get("title");
    const published = source.fields.get("published");
    const expectedName = title && published ? fileNameFromTitle(title, published) : undefined;
    if (!isWeChatTitle(title)) issues.push("笔记属性 title 必须为“期刊缩写: 通俗的研究看点”。");
    else if (!expectedName) issues.push("原文笔记属性 published 必须包含四位年份，以生成输出文件名。");
    else if (fileName !== expectedName) issues.push(`文件名必须与笔记属性 title 及年份对应：${expectedName}。`);
    for (const field of ["source", "published"]) {
      if (metadata.get(field) !== source.fields.get(field)) issues.push(`笔记属性 ${field} 必须与原文语义值一致。`);
    }
  }
  if (/^#\s+/m.test(stripFrontmatter(markdown))) issues.push("精读文件不得包含一级总标题，请仅保留 frontmatter.title。");

  const paperInfo = markdown.match(PAPER_INFO)?.[0];
  if (!paperInfo) issues.push("论文信息区必须使用固定五行顺序，前四行以 <br> 结尾。" );
  const outsidePaperInfo = paperInfo ? markdown.replace(paperInfo, "") : markdown;
  if (/<\/?[A-Za-z][^>]*>/.test(outsidePaperInfo)) issues.push("除规范论文信息区外不得包含原生 HTML 标签。");

  for (const alternatives of REQUIRED_SECTION_GROUPS) {
    if (!alternatives.some(section => new RegExp(`^## ${escapeRegExp(section)}\\s*$`, "m").test(markdown))) {
      issues.push(`缺少“${alternatives.join("”或“")}”章节。`);
    }
  }

  issues.push(...validateBold(markdown));
  issues.push(...await validateFigures(markdown, outputRoot, vaultPath, source, attachmentResolver));
  issues.push(...await validateImagePaths(markdown, path.posix.join("output", fileName), vaultPath, attachmentResolver));
  return unique(issues);
}

function validateBold(markdown: string): string[] {
  const issues: string[] = [];
  const body = stripFrontmatter(markdown).replace(PAPER_INFO, "");
  const rendered = marked.parse(body, { async: false, gfm: true }) as string;
  if (rendered.includes("**")) issues.push("存在未被解析的 ** 粗体标记，请检查配对、空格和中文标点边界。");
  if (hasNestedStrong(rendered)) issues.push("存在由中文标点边界导致的嵌套粗体，请在闭合标记后留一个空格。");

  const background = sectionBody(markdown, "研究背景");
  if (background !== undefined && strongCount(background) !== 2) issues.push("“研究背景”必须且只能包含 2 处粗体。");

  const figureBody = sectionBody(markdown, "图表解读");
  if (figureBody !== undefined) {
    for (const figure of figureSections(figureBody)) {
      if (strongCount(figure.body) !== 2) issues.push(`Figure ${figure.number} 解读必须且只能包含 2 处粗体。`);
    }
  }

  const preparation = sectionBody(markdown, "实验样品制备方法");
  if (preparation !== undefined) {
    const stepLines = preparation.split(/\r?\n/).filter(line => /^\*\*[①②③④⑤⑥⑦⑧⑨⑩]/.test(line.trim()));
    if (!stepLines.length) issues.push("“实验样品制备方法”必须使用带圈数字步骤和加粗步骤标题。");
    if (strongCount(preparation) !== stepLines.length || stepLines.some(line => strongCount(line) !== 1)) {
      issues.push("实验制备每个步骤只能加粗步骤标题，步骤正文不得包含其他粗体。");
    }
  }

  for (const section of ["知识拓展：创新点分析", "总结", "一句话总结"]) {
    const content = sectionBody(markdown, section);
    if (content !== undefined && strongCount(content) !== 0) issues.push(`“${section}”不得使用粗体。`);
  }
  return issues;
}

async function validateFigures(markdown: string, outputRoot: string, vaultPath: string, source: SourceDocument, attachmentResolver: AttachmentResolver): Promise<string[]> {
  const issues: string[] = [];
  const body = sectionBody(markdown, "图表解读");
  if (body === undefined) return issues;
  if (/^###\s+(?:Extended\s+Data|Supplementary)\s+Fig(?:ure)?/im.test(body)) issues.push("图表解读默认不得包含 Extended Data 或 Supplementary Figure。");
  const figures = figureSections(body);
  const numbers = figures.map(figure => figure.number);
  if (numbers.some((number, index) => number !== index + 1)) issues.push("主文 Figure 必须从 1 开始按编号升序排列且不得重复。");

  const expected = await collectSourceFigureImages(source.markdown, source.path, vaultPath, attachmentResolver);
  for (const number of expected.keys()) {
    if (!numbers.includes(number)) issues.push(`缺少原文主文 Figure ${number} 的解读小节。`);
  }

  for (const figure of figures) {
    const nonEmpty = figure.body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const images = markdownImages(figure.body);
    if (!IMAGE_LINE.test(nonEmpty[0] ?? "")) issues.push(`Figure ${figure.number} 图片必须是标题后的第一个非空行。`);
    if (images.length !== 1) issues.push(`Figure ${figure.number} 小节必须且只能包含 1 张图片。`);
    const image = images[0];
    if (image) {
      const altNumber = image.alt.match(/(?:figure|fig)\.?\s*(\d+)/i)?.[1];
      if (Number(altNumber) !== figure.number) issues.push(`Figure ${figure.number} 的图片说明编号不匹配。`);
      const expectedImage = expected.get(figure.number);
      if (expectedImage && normalizeTarget(image.path) !== normalizeTarget(expectedImage.path)) {
        issues.push(`Figure ${figure.number} 必须使用原文对应图片：${expectedImage.path}。`);
      }
    }
  }
  return issues;
}

function figureSections(body: string): Array<{ number: number; body: string }> {
  const matches = [...body.matchAll(/^###\s+Figure\s+(\d+)\b[^\r\n]*$/gim)];
  return matches.map((match, index) => ({
    number: Number(match[1]),
    body: body.slice((match.index ?? 0) + match[0].length, matches[index + 1]?.index ?? body.length)
  }));
}

function sectionBody(markdown: string, name: string): string | undefined {
  const heading = new RegExp(`^## ${escapeRegExp(name)}\\s*$`, "m").exec(markdown);
  if (heading?.index === undefined) return undefined;
  const start = heading.index + heading[0].length;
  const next = /^##\s+/m.exec(markdown.slice(start));
  return markdown.slice(start, next?.index === undefined ? markdown.length : start + next.index);
}

function strongCount(markdown: string): number {
  const rendered = marked.parse(markdown, { async: false, gfm: true }) as string;
  return (rendered.match(/<strong>/g) ?? []).length;
}

function hasNestedStrong(html: string): boolean {
  let depth = 0;
  for (const match of html.matchAll(/<\/?strong>/g)) {
    if (match[0] === "<strong>") {
      depth += 1;
      if (depth > 1) return true;
    } else {
      depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

function frontmatterKeys(markdown: string): string[] | undefined {
  const block = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return undefined;
  const keys: string[] = [];
  for (const line of (block[1] ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):/);
    keys.push(match?.[1] ?? `invalid:${line}`);
  }
  return keys;
}

interface WeChatTitleParts {
  journal: string;
  finding: string;
}

function isWeChatTitle(title: string | undefined): title is string {
  return title !== undefined && parseWeChatTitle(title) !== undefined;
}

function fileNameFromTitle(title: string, published: string): string | undefined {
  const parts = parseWeChatTitle(title);
  const year = published.match(/\b(?:19|20)\d{2}\b/)?.[0];
  if (!parts || !year) return undefined;
  return `${[parts.journal, parts.finding, year].map(sanitizeFileNameSegment).join("_")}.md`;
}

function parseWeChatTitle(title: string): WeChatTitleParts | undefined {
  const match = title.match(/^([A-Za-z][A-Za-z0-9. &+()/-]*): (.+)$/u);
  if (!match?.[1] || !match[2]) return undefined;
  const journal = match[1].trim();
  const finding = match[2].trim();
  if (!journal || !finding || title.includes("|")) return undefined;
  return { journal, finding };
}

function sanitizeFileNameSegment(value: string): string {
  let sanitized = "";
  for (const character of value) sanitized += isWindowsIllegalFileNameCharacter(character) ? "-" : character;
  sanitized = sanitized.trim();
  return sanitized || "-";
}

function isWindowsIllegalFileNameCharacter(character: string): boolean {
  return "<>:\"/\\|?*".includes(character) || character.codePointAt(0)! < 32;
}

async function validateImagePaths(markdown: string, outputArticlePath: string, vaultPath: string, attachmentResolver: AttachmentResolver): Promise<string[]> {
  const issues: string[] = [];
  for (const image of markdownImages(markdown)) {
    let resolved: string | undefined;
    try { resolved = await attachmentResolver.resolve(image.path, outputArticlePath); }
    catch { resolved = undefined; }
    if (!resolved) {
      issues.push(`图片不存在或路径超出当前 Vault：${image.path}。`);
      continue;
    }
    const canonical = attachmentResolver.relativePath(outputArticlePath, resolved);
    if (normalizeTarget(image.path) !== normalizeTarget(canonical)) {
      issues.push(`图片必须使用从精读稿到实际附件的相对路径：${image.path}（应为 ${canonical}）。`);
      continue;
    }
    const absolute = path.resolve(vaultPath, resolved.replaceAll("/", path.sep));
    if (!isWithin(vaultPath, absolute)) {
      issues.push(`图片路径超出当前 Vault：${image.path}。`);
      continue;
    }
    try { if (!(await stat(absolute)).isFile()) issues.push(`图片不存在：${image.path}。`); }
    catch (error) {
      if (isMissing(error)) issues.push(`图片不存在：${image.path}。`);
      else issues.push(`无法检查图片 ${image.path}：${errorMessage(error)}`);
    }
  }
  return issues;
}

function markdownImages(markdown: string): MarkdownImage[] {
  return [...markdown.matchAll(/!\[([^\]]*)]\((<[^>\r\n]+>|[^)\r\n]+)\)/g)].map(match => ({
    alt: match[1] ?? "",
    path: cleanMarkdownTarget(match[2] ?? "")
  }));
}

function cleanMarkdownTarget(value: string): string {
  let result = value.trim().replace(/^<|>$/g, "");
  const titled = result.match(/^([^\s]+)\s+["'][^"']*["']$/);
  if (titled?.[1]) result = titled[1];
  try { return decodeURIComponent(result.split("#", 1)[0] ?? result); }
  catch { return result; }
}

function normalizeTarget(value: string): string { return cleanMarkdownTarget(value).replaceAll("\\", "/").toLowerCase(); }
function stripFrontmatter(markdown: string): string { return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, ""); }
function unique(values: string[]): string[] { return [...new Set(values)]; }

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return !(relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative));
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function isMissing(error: unknown): error is NodeJS.ErrnoException { return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
