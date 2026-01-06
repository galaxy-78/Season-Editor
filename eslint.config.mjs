import typescriptEslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default [
  {
    files: ["**/*.ts"],
    plugins: {
      "@typescript-eslint": typescriptEslint.plugin,
    },
    languageOptions: {
      parser: typescriptEslint.parser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "import", format: ["camelCase", "PascalCase"] },
      ],

      curly: "off",
      eqeqeq: "off",
      "no-throw-literal": "warn",
    },
  },

  prettier,
];
