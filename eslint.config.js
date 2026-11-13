import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // 빌드 결과물과, 분석 대상으로만 쓰는 평가 케이스의 코드는 검사하지 않는다.
    ignores: [
      "skill/pr-map/scripts/**",
      "skill/pr-map/assets/**",
      "out/**",
      "eval/cases/**",
      "eval/results/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // 테스트는 YAML과 JSON 출력을 그대로 읽어 값을 비교하므로 any 관련 규칙을 끈다.
    files: ["test/**"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },
  {
    files: ["src/viewer/**"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
);
