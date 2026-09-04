import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite serves the chrome to the Tauri webview in dev and builds it to dist/ for bundles.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome120",
    sourcemap: true,
    // axe-core is an intentionally isolated, on-demand audit payload. Its
    // minified source is just under 600 kB and does not belong on startup.
    chunkSizeWarningLimit: 600,
  },
  test: { environment: "jsdom", globals: false, maxWorkers: 4, setupFiles: ["src/test-setup.ts"] },
});
