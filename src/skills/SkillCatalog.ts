import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_SKILL_BYTES = 100_000;
const MAX_SELECTED_SKILL_BYTES = 200_000;
const MAX_SELECTED_RESOURCE_BYTES = 50_000_000;
const MAX_SELECTED_RESOURCE_FILES = 500;
const MAX_RESOURCE_FILE_BYTES = 25_000_000;
export const MATERIAL_PAPER_DEEP_READING_SKILL_ID = "builtin:material-paper-deep-reading";
export const MATERIAL_PAPER_WECHAT_EDITOR_SKILL_ID = "builtin:material-paper-wechat-editor";

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  source: "local";
  sourcePath?: string;
}

export interface SelectedSkillSnapshot {
  id: string;
  name: string;
  instructions: string;
  resourceDirectory?: string;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
}

export interface SkillCatalogResult {
  skills: SkillDefinition[];
  diagnostics: SkillDiagnostic[];
}

export interface SkillCatalogOptions {
  directory: string;
  onWarning?: (message: string) => void;
  removeDirectory?: (directory: string) => Promise<void>;
}

export class SkillCatalog {
  private readonly directory: string;
  private readonly onWarning?: (message: string) => void;
  private readonly removeDirectory: (directory: string) => Promise<void>;

  constructor(options: SkillCatalogOptions) {
    this.directory = options.directory;
    this.onWarning = options.onWarning;
    this.removeDirectory = options.removeDirectory ?? (directory => rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }));
  }

  async list(): Promise<SkillCatalogResult> {
    const diagnostics: SkillDiagnostic[] = [];
    const candidates = await findSkillFiles(this.directory, diagnostics);
    let canonicalRoot: string | undefined;
    try { canonicalRoot = await realpath(this.directory); }
    catch (error) { if (!isMissing(error)) diagnostics.push({ path: this.directory, message: errorMessage(error) }); }

    const seen = new Set<string>();
    const localSkills: SkillDefinition[] = [];
    for (const candidate of candidates) {
      let canonical: string;
      try {
        canonical = await realpath(candidate);
      } catch (error) {
        diagnostics.push({ path: candidate, message: errorMessage(error) });
        continue;
      }
      if (!canonicalRoot || !isWithinDirectory(canonicalRoot, canonical)) {
        diagnostics.push({ path: candidate, message: "Skill 文件位于专用库目录之外。" });
        continue;
      }
      const key = canonical.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const parsed = await readSkill(canonical, path.basename(path.dirname(candidate)), diagnostics);
      if (parsed) localSkills.push(parsed);
    }

    localSkills.sort((left, right) => left.name.localeCompare(right.name) || (left.sourcePath ?? "").localeCompare(right.sourcePath ?? ""));
    diagnostics.sort((left, right) => left.path.localeCompare(right.path));
    return { skills: localSkills, diagnostics };
  }

  async withSelection<T>(ids: string[], callback: (skills: SelectedSkillSnapshot[]) => Promise<T>): Promise<T> {
    const result = await this.list();
    const selectedIds = new Set(ids);
    const definitions = result.skills.filter(skill => selectedIds.has(skill.id));
    if (definitions.length !== selectedIds.size) throw new Error("所选 Skill 已不可用，请重新打开工具箱后再试。");
    const total = definitions.reduce((bytes, skill) => bytes + Buffer.byteLength(skill.instructions, "utf8"), 0);
    if (total > MAX_SELECTED_SKILL_BYTES) throw new Error("所选 Skill 指令合计超过 200 KB，请减少选择后重试。");
    const selected = definitions.map(({ id, name, instructions }) => ({ id, name, instructions }));
    const localDefinitions = definitions.filter(skill => skill.sourcePath);
    if (!localDefinitions.length) return callback(selected);

    const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "paperdian-skills-"));
    try {
      const stagedById = new Map<string, string>();
      const budget: ResourceBudget = { bytes: 0, files: 0 };
      for (const [index, skill] of localDefinitions.entries()) {
        const destination = path.join(stagingRoot, `${index}-${safePathSegment(skill.name)}`);
        await copySkillDirectory(path.dirname(skill.sourcePath!), destination, skill.name, budget);
        stagedById.set(skill.id, destination);
      }
      return await callback(selected.map(skill => ({ ...skill, resourceDirectory: stagedById.get(skill.id) })));
    } finally {
      try { await this.removeDirectory(stagingRoot); }
      catch (error) { this.reportWarning(`无法清理 Skill 临时目录：${errorMessage(error)}`); }
    }
  }

  private reportWarning(message: string): void {
    try { this.onWarning?.(message); }
    catch (error) { console.warn(message, error); }
  }
}

interface ResourceBudget {
  bytes: number;
  files: number;
}

async function copySkillDirectory(source: string, destination: string, skillName: string, budget: ResourceBudget): Promise<void> {
  const canonicalRoot = await realpath(source);
  await copySkillNode(canonicalRoot, destination, "", canonicalRoot, skillName, budget, new Set());
}

async function copySkillNode(
  source: string,
  destination: string,
  relativePath: string,
  canonicalRoot: string,
  skillName: string,
  budget: ResourceBudget,
  ancestorDirectories: Set<string>
): Promise<void> {
  const linkInfo = await lstat(source);
  let resolvedSource = source;
  if (linkInfo.isSymbolicLink()) {
    try { resolvedSource = await realpath(source); }
    catch { throw new Error(`Skill “${skillName}” 包含损坏软链接：${relativePath || "."}`); }
    if (!isWithinDirectory(canonicalRoot, resolvedSource)) {
      throw new Error(`Skill “${skillName}” 包含越界软链接：${relativePath || "."}`);
    }
  }

  const info = await stat(resolvedSource);
  if (info.isDirectory()) {
    const canonicalDirectory = await realpath(resolvedSource);
    const directoryKey = process.platform === "win32" ? canonicalDirectory.toLocaleLowerCase() : canonicalDirectory;
    if (ancestorDirectories.has(directoryKey)) throw new Error(`Skill “${skillName}” 包含循环软链接：${relativePath || "."}`);
    const nextAncestors = new Set(ancestorDirectories).add(directoryKey);
    await mkdir(destination, { recursive: true });
    const entries = await readdir(resolvedSource, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const childRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
      await copySkillNode(
        path.join(resolvedSource, entry.name),
        path.join(destination, entry.name),
        childRelativePath,
        canonicalRoot,
        skillName,
        budget,
        nextAncestors
      );
    }
  } else if (info.isFile()) {
    if (relativePath.toLocaleLowerCase() !== "skill.md") {
      const displayPath = portablePath(relativePath);
      if (info.size > MAX_RESOURCE_FILE_BYTES) {
        throw new Error(`Skill “${skillName}” 附属资源单文件超过 25 MB：${displayPath}`);
      }
      budget.files += 1;
      budget.bytes += info.size;
      if (budget.files > MAX_SELECTED_RESOURCE_FILES) throw new Error(`Skill “${skillName}” 附属资源文件数超过 500：${displayPath}`);
      if (budget.bytes > MAX_SELECTED_RESOURCE_BYTES) throw new Error(`Skill “${skillName}” 附属资源合计超过 50 MB：${displayPath}`);
    }
    await copyFile(resolvedSource, destination);
    await chmod(destination, info.mode & 0o777);
  } else throw new Error(`Skill “${skillName}” 包含不支持的附属资源：${portablePath(relativePath)}`);
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safePathSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "");
  return (normalized || "skill").slice(0, 80);
}

function portablePath(value: string): string {
  return value.split(path.sep).join("/");
}

async function findSkillFiles(directory: string, diagnostics: SkillDiagnostic[]): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try { isDirectory = (await stat(child)).isDirectory(); }
        catch (error) { diagnostics.push({ path: child, message: errorMessage(error) }); continue; }
      }
      if (!isDirectory) continue;
      const skillFile = path.join(child, "SKILL.md");
      try {
        if ((await stat(skillFile)).isFile()) files.push(skillFile);
      } catch (error) {
        if (!isMissing(error)) diagnostics.push({ path: skillFile, message: errorMessage(error) });
      }
    }
  } catch (error) {
    if (!isMissing(error)) diagnostics.push({ path: directory, message: errorMessage(error) });
  }
  return files;
}

async function readSkill(filePath: string, directoryName: string, diagnostics: SkillDiagnostic[]): Promise<SkillDefinition | undefined> {
  try {
    const info = await stat(filePath);
    if (info.size > MAX_SKILL_BYTES) {
      diagnostics.push({ path: filePath, message: "SKILL.md 超过 100 KB。" });
      return undefined;
    }
    const raw = await readFile(filePath, "utf8");
    const parsed = parseSkillMarkdown(raw);
    if (!parsed) {
      diagnostics.push({ path: filePath, message: "缺少有效的 name、description frontmatter 或正文。" });
      return undefined;
    }
    return {
      id: directoryName === "material-paper-deep-reading" ? MATERIAL_PAPER_DEEP_READING_SKILL_ID
        : directoryName === "material-paper-wechat-editor" ? MATERIAL_PAPER_WECHAT_EDITOR_SKILL_ID
          : `local:${filePath}`,
      name: parsed.name,
      description: parsed.description,
      instructions: parsed.instructions,
      source: "local",
      sourcePath: filePath
    };
  } catch (error) {
    diagnostics.push({ path: filePath, message: errorMessage(error) });
    return undefined;
  }
}

function parseSkillMarkdown(raw: string): { name: string; description: string; instructions: string } | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    fields.set(line.slice(0, separator).trim(), unquote(line.slice(separator + 1).trim()));
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  const instructions = match[2].trim();
  return name && description && instructions ? { name, description, instructions } : undefined;
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
