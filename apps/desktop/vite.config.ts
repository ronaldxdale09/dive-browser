import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite serves the chrome to the Tauri webview in dev and builds it to dist/ for bundles.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome120",
    // Tauri embeds every dist asset into the executable, including source maps.
    // Keep maps available for diagnostic builds without shipping them by default.
    sourcemap: loadEnv(mode, ".", "DIVE_UI_").DIVE_UI_SOURCEMAPS === "1",
    // axe-core is an intentionally isolated, on-demand audit payload. Its
    // minified source is just under 600 kB and does not belong on startup.
    chunkSizeWarningLimit: 600,
  },
  test: {
    environment: "jsdom",
    globals: false,
    maxWorkers: 4,
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)", "../../scripts/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
  },
}));
