import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

export default defineConfig({
  plugins: [react()],
  // Same list as vite.config.ts. Without it, any test that reaches the
  // character roster fails at import time — `src/lib/characters.ts` globs a
  // folder of GLBs, and Vite tries to parse them as JavaScript unless it has
  // been told they are assets. The error names the .glb file, not the test,
  // which makes it a genuinely confusing five minutes.
  assetsInclude: ["**/*.glb", "**/*.gltf"],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
});
