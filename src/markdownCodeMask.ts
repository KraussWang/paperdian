/** Preserve offsets while hiding Markdown code regions from image-reference scans. */
export function maskMarkdownCode(markdown: string): string {
  let output = "";
  let fence: { marker: string; length: number } | undefined;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const text = line.replace(/\r?\n$/, "");
    const newline = line.slice(text.length);
    if (fence) {
      output += " ".repeat(text.length) + newline;
      const closing = text.match(/^ {0,3}(`+|~+)\s*$/);
      if (closing && closing[1]?.[0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
      continue;
    }
    const opening = text.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      output += " ".repeat(text.length) + newline;
      continue;
    }
    if (/^(?: {4}|\t)/.test(text)) {
      output += " ".repeat(text.length) + newline;
      continue;
    }
    output += text.replace(/(`+)([\s\S]*?)\1/g, match => " ".repeat(match.length)) + newline;
  }
  return output;
}
