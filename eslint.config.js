import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", ".remember/**", ".omc/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "max-lines-per-function": ["error", { max: 30, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 3],
      "max-params": ["error", 4],
      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      complexity: ["error", 10],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    // Test bodies are long by nature; structure limits stay on for src.
    files: ["tests/**/*.ts"],
    rules: { "max-lines-per-function": "off", "max-lines": "off" },
  },
);
