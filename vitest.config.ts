import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/test/**/*.unit.test.ts"],
    exclude: ["src/test/extension.test.ts", "out/**", "node_modules/**"],
    environment: "node",
  },
});
