import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { inlineSelectorWasm } from "./src/build/inlineSelectorWasm";

export default defineConfig({
  plugins: [react(), inlineSelectorWasm()],
  optimizeDeps: { exclude: ["@gkd-kit/selector-beta", "regex-wasm"] },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
