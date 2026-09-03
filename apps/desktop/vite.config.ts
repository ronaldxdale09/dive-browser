import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Vite serves the chrome to the Tauri webview in dev and builds it to dist/ for bundles.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: { target: "chrome120", sourcemap: true },
  test: { environment: "jsdom", globals: false },
});
