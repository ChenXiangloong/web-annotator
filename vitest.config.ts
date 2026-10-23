import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@annotator/core": path.resolve(__dirname, "packages/core/src/index.ts"),
      "@annotator/storage": path.resolve(__dirname, "packages/storage/src/index.ts"),
      "@annotator/ui": path.resolve(__dirname, "packages/ui/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.test.ts"],
  },
});
