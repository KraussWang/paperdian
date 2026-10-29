import { readFile } from "node:fs/promises";
import { defineConfig, type Plugin } from "vitest/config";

const cssAsText: Plugin = {
  name: "css-as-text",
  enforce: "pre",
  resolveId(source) {
    return source === "katex/dist/katex.min.css?raw" ? "\0paperdian-katex-css" : undefined;
  },
  async load(id) {
    if (id !== "\0paperdian-katex-css") return undefined;
    const css = await readFile("node_modules/katex/dist/katex.min.css", "utf8");
    return `export default ${JSON.stringify(css)};`;
  }
};

const markdownAsText: Plugin = {
  name: "markdown-as-text",
  enforce: "pre",
  async load(id) {
    if (!id.endsWith(".md")) return undefined;
    const markdown = await readFile(id, "utf8");
    return `export default ${JSON.stringify(markdown)};`;
  }
};

export default defineConfig({
  plugins: [cssAsText, markdownAsText],
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "coverage"
    }
  }
});
