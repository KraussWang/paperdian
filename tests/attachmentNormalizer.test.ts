import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentNormalizer, type AttachmentFile, type AttachmentVault, type RemoteImageResponse } from "../src/attachments/AttachmentNormalizer";
import { VaultAttachmentResolver } from "../src/attachments/VaultAttachmentResolver";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQkUZ0pv+BiOh/AAA=", "base64");

describe("AttachmentNormalizer", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("downloads remote images, converts WebP, converts local WebP, and updates cover/body references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, {
      "article/paper.md": `---\ncover: https://images.example/cover.webp?size=large\n---\n# Paper\n\n![Figure](https://images.example/figure.webp?size=large)\n![[attachments/local.webp|Local]]\n![Duplicate](https://images.example/figure.webp?size=large)\n`,
      "article/attachments/local.webp": WEBP
    });
    const downloads = new Map<string, RemoteImageResponse>([
      ["https://images.example/cover.webp?size=large", response(WEBP)],
      ["https://images.example/figure.webp?size=large", response(WEBP)]
    ]);
    const requested: string[] = [];
    const converted: Uint8Array[] = [];
    const normalizer = new AttachmentNormalizer({
      vault,
      download: async url => {
        requested.push(url);
        const result = downloads.get(url);
        if (!result) throw new Error("not found");
        return result;
      },
      convertWebpToPng: async bytes => { converted.push(bytes); return new Uint8Array(PNG); }
    });

    const result = await normalizer.normalize(vault.getFileByPath("article/paper.md")!);
    const markdown = await readFile(path.join(root, "article/paper.md"), "utf8");

    expect(result).toMatchObject({ changed: true, downloadedCount: 2, convertedCount: 1, unchangedCount: 0, failures: [] });
    expect(requested).toEqual(["https://images.example/cover.webp?size=large", "https://images.example/figure.webp?size=large"]);
    expect(converted).toHaveLength(3);
    expect(markdown).toContain("cover: cover.png");
    expect(markdown).toContain("![Figure](figure.png)");
    expect(markdown).toContain("![[attachments/local.png|Local]]");
    await expect(access(path.join(root, "article/cover.png"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "article/figure.png"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "article/attachments/local.png"))).resolves.toBeUndefined();
    await expect(access(path.join(root, "article/attachments/local.webp"))).resolves.toBeUndefined();
  });

  it("downloads non-WebP remote images without re-encoding and is idempotent", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, { "paper.md": "![Image](https://images.example/chart.png)\n" });
    let downloadCount = 0;
    let convertCount = 0;
    const normalizer = new AttachmentNormalizer({
      vault,
      download: async () => { downloadCount += 1; return response(PNG); },
      convertWebpToPng: async bytes => { convertCount += 1; return bytes; }
    });

    const file = vault.getFileByPath("paper.md")!;
    await expect(normalizer.normalize(file)).resolves.toMatchObject({ downloadedCount: 1, convertedCount: 0 });
    await expect(normalizer.normalize(file)).resolves.toMatchObject({ changed: false, downloadedCount: 0, convertedCount: 0 });
    expect(downloadCount).toBe(1);
    expect(convertCount).toBe(0);
    expect(await readFile(path.join(root, "paper.md"), "utf8")).toBe("![Image](chart.png)\n");
  });

  it("keeps successful changes and reports failed attachments without removing local WebP", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, {
      "paper.md": "![Good](https://images.example/good.webp)\n![Bad](https://images.example/bad.webp)\n![[local.webp]]\n",
      "local.webp": WEBP
    });
    const normalizer = new AttachmentNormalizer({
      vault,
      download: async url => url.endsWith("good.webp") ? response(WEBP) : (() => { throw new Error("服务器拒绝请求"); })(),
      convertWebpToPng: async () => new Uint8Array(PNG)
    });

    const result = await normalizer.normalize(vault.getFileByPath("paper.md")!);
    const markdown = await readFile(path.join(root, "paper.md"), "utf8");
    expect(result.downloadedCount).toBe(1);
    expect(result.convertedCount).toBe(1);
    expect(result.failures).toEqual([{ reference: "https://images.example/bad.webp", message: "服务器拒绝请求" }]);
    expect(markdown).toContain("![Good](good.png)");
    expect(markdown).toContain("![Bad](https://images.example/bad.webp)");
    expect(markdown).toContain("![[local.png]]");
    await expect(access(path.join(root, "local.webp"))).resolves.toBeUndefined();
  });

  it("uses a unique name instead of overwriting an existing output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, { "paper.md": "![Image](image.webp)\n", "image.webp": WEBP, "image.png": Buffer.from("different") });
    const normalizer = new AttachmentNormalizer({ vault, download: async () => { throw new Error("not used"); }, convertWebpToPng: async () => new Uint8Array(PNG) });

    const result = await normalizer.normalize(vault.getFileByPath("paper.md")!);
    expect(result.outputPaths).toEqual(["image-1.png"]);
    expect(await readFile(path.join(root, "paper.md"), "utf8")).toBe("![Image](image-1.png)\n");
    expect(await readFile(path.join(root, "image.png"))).toEqual(Buffer.from("different"));
  });

  it("converts a WebP disguised as PNG without overwriting the original attachment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, { "paper.md": "![Image](figure.png)\n", "figure.png": WEBP });
    installBrowserWebpDecoder();
    const normalizer = new AttachmentNormalizer({ vault, download: async () => { throw new Error("not used"); } });

    const result = await normalizer.normalize(vault.getFileByPath("paper.md")!);

    expect(result).toMatchObject({ changed: true, convertedCount: 1, failures: [], outputPaths: ["figure-1.png"] });
    expect(await readFile(path.join(root, "paper.md"), "utf8")).toBe("![Image](figure-1.png)\n");
    expect(await readFile(path.join(root, "figure.png"))).toEqual(WEBP);
    expect(await readFile(path.join(root, "figure-1.png"))).toEqual(PNG);
  });

  it("rewrites an unchanged bare wikilink to the configured attachment path without copying the image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, {
      "output/article.md": "![[Pasted image.png|640x480]]\n",
      "raw/assets/Pasted image.png": PNG
    });
    const resolver = new VaultAttachmentResolver({
      attachmentFolderPath: "raw/assets",
      fileExists: filePath => vault.getFileByPath(filePath) !== null
    });
    const normalizer = new AttachmentNormalizer({
      vault,
      attachmentResolver: () => resolver,
      download: async () => { throw new Error("not used"); }
    });

    const result = await normalizer.normalize(vault.getFileByPath("output/article.md")!);

    expect(result).toMatchObject({ changed: true, downloadedCount: 0, convertedCount: 0, unchangedCount: 1, outputPaths: [], failures: [] });
    expect(await readFile(path.join(root, "output/article.md"), "utf8")).toBe("![[../raw/assets/Pasted image.png|640x480]]\n");
    expect(await readFile(path.join(root, "raw/assets/Pasted image.png"))).toEqual(PNG);
  });

  it("downloads remote images into the configured attachment folder", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperdian-attachments-"));
    const vault = await createVault(root, { "output/article.md": "![Image](https://images.example/chart.png)\n" });
    const resolver = new VaultAttachmentResolver({
      attachmentFolderPath: "raw/assets",
      fileExists: filePath => vault.getFileByPath(filePath) !== null
    });
    const normalizer = new AttachmentNormalizer({ vault, attachmentResolver: () => resolver, download: async () => response(PNG) });

    await expect(normalizer.normalize(vault.getFileByPath("output/article.md")!)).resolves.toMatchObject({ downloadedCount: 1, failures: [] });
    expect(await readFile(path.join(root, "output/article.md"), "utf8")).toBe("![Image](../raw/assets/chart.png)\n");
    expect(await readFile(path.join(root, "raw/assets/chart.png"))).toEqual(PNG);
  });
});

function response(bytes: Uint8Array): RemoteImageResponse {
  const copy = Uint8Array.from(bytes);
  return { status: 200, headers: { "content-length": String(copy.length) }, arrayBuffer: copy.buffer };
}

async function createVault(root: string, files: Record<string, Uint8Array | string>): Promise<AttachmentVault> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  const toFile = (filePath: string): AttachmentFile => ({ path: filePath.replaceAll(path.sep, "/"), extension: path.posix.extname(filePath).slice(1) });
  return {
    read: file => readFile(path.join(root, file.path), "utf8"),
    readBinary: async file => {
      const bytes = await readFile(path.join(root, file.path));
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    },
    createBinary: async (filePath, data) => {
      const absolute = path.join(root, filePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, new Uint8Array(data));
      return toFile(filePath);
    },
    getFileByPath: filePath => {
      return existsSync(path.join(root, filePath)) ? toFile(filePath) : null;
    },
    modify: async (file, data) => writeFile(path.join(root, file.path), data)
  };
}

function installBrowserWebpDecoder(): void {
  const bitmap = { width: 1, height: 1, close() {} } as ImageBitmap;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (callback: BlobCallback, type?: string) => callback(new Blob([PNG], { type }))
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.stubGlobal("document", { createElement: () => canvas });
}
