import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL("..", import.meta.url)),
  test: {
    environment: "node",
    include: ["bench/**/*.{bench,test}.ts"],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
  },
});
