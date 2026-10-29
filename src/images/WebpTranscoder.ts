const DEFAULT_MAX_PIXELS = 40_000_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export async function convertWebpToPng(bytes: Uint8Array, maxPixels = DEFAULT_MAX_PIXELS): Promise<Uint8Array> {
  if (!isWebp(bytes)) throw new Error("输入不是有效的 WebP 图片。");
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1) throw new Error("WebP 像素上限无效。");

  let bitmap: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  try {
    bitmap = await createImageBitmap(new Blob([bytes.slice().buffer], { type: "image/webp" }));
    const { width, height } = bitmap;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new Error("WebP 图片尺寸无效。");
    }
    if (width * height > maxPixels) throw new Error(`WebP 图片超过 ${maxPixels} 像素上限。`);

    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片画布。");
    context.drawImage(bitmap, 0, 0);

    const pngBlob = await canvasToPng(canvas);
    if (pngBlob.size === 0) throw new Error("浏览器生成了空的 PNG 图片。");
    if (pngBlob.size > MAX_OUTPUT_BYTES) throw new Error("转换后的 PNG 图片超过 10 MB。");
    const png = new Uint8Array(await pngBlob.arrayBuffer());
    if (!isPng(png)) throw new Error("浏览器生成的内容不是有效 PNG 图片。");
    return png;
  } catch (error) {
    throw new Error(`WebP 转 PNG 失败：${errorMessage(error)}`);
  } finally {
    bitmap?.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("浏览器无法编码 PNG 图片。"));
    }, "image/png");
  });
}

function isWebp(bytes: Uint8Array): boolean {
  return bytes.length >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF"
    && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
