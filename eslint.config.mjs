import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["main.js", "release/**", "node_modules/**", "coverage/**", "coverage-claude-analysis/**", "**/*.mjs", "**/*.cjs"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    rules: {
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-deprecated": "off",
      "@typescript-eslint/no-misused-promises": ["error", { "checksVoidReturn": false }]
      ,"@typescript-eslint/no-non-null-assertion": "off"
      ,"@typescript-eslint/no-unnecessary-condition": "off"
      ,"@typescript-eslint/no-unnecessary-type-assertion": "off"
      ,"@typescript-eslint/require-await": "off"
      ,"@typescript-eslint/restrict-template-expressions": "off"
    }
  }
);
