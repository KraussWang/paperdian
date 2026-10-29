import { afterEach, describe, expect, it, vi } from "vitest";
import { convertWebpToPng } from "../src/images/WebpTranscoder";

const WEBP = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAdQkUZ0pv+BiOh/AAA=", "base64");
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("convertWebpToPng", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("decodes WebP through Chromium and returns validated PNG bytes", async () => {
    let closed = false;
    const bitmap = { width: 1, height: 1, close: () => { closed = true; } } as ImageBitmap;
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback, type?: string) => callback(new Blob([PNG], { type }))
    } as unknown as HTMLCanvasElement;
    vi.stubGlobal("createImageBitmap", vi.fn(async (blob: Blob) => {
      expect(blob.type).toBe("image/webp");
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(WEBP);
      return bitmap;
    }));
    vi.stubGlobal("document", { createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      return canvas;
    } });

    const result = await convertWebpToPng(new Uint8Array(WEBP));

    expect(Buffer.from(result)).toEqual(PNG);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(closed).toBe(true);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("reports Chromium decode failures", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("decoder rejected input"); }));

    await expect(convertWebpToPng(new Uint8Array(WEBP))).rejects.toThrow("WebP 转 PNG 失败：decoder rejected input");
  });

  it("rejects images over the pixel limit and closes the decoded bitmap", async () => {
    let closed = false;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 10_000, height: 5_000, close: () => { closed = true; } })));

    await expect(convertWebpToPng(new Uint8Array(WEBP))).rejects.toThrow("超过 40000000 像素上限");
    expect(closed).toBe(true);
  });

  it("reports an unavailable canvas and releases decoded resources", async () => {
    let closed = false;
    const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 1, height: 1, close: () => { closed = true; } })));
    vi.stubGlobal("document", { createElement: () => canvas });

    await expect(convertWebpToPng(new Uint8Array(WEBP))).rejects.toThrow("浏览器无法创建图片画布");
    expect(closed).toBe(true);
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("rejects an empty PNG result", async () => {
    installCanvasResult(new Blob([], { type: "image/png" }));

    await expect(convertWebpToPng(new Uint8Array(WEBP))).rejects.toThrow("浏览器生成了空的 PNG 图片");
  });

  it("rejects a PNG result over 10 MB", async () => {
    installCanvasResult(new Blob([new ArrayBuffer(10 * 1024 * 1024 + 1)], { type: "image/png" }));

    await expect(convertWebpToPng(new Uint8Array(WEBP))).rejects.toThrow("转换后的 PNG 图片超过 10 MB");
  });
});

function installCanvasResult(result: Blob | null): void {
  const bitmap = { width: 1, height: 1, close() {} } as ImageBitmap;
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
    toBlob: (callback: BlobCallback) => callback(result)
  } as unknown as HTMLCanvasElement;
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  vi.stubGlobal("document", { createElement: () => canvas });
}
