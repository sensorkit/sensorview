import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";

// Read at build time so the renderer can display the running app's version
// without us having to bump a hardcoded string in two places.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
) as { version: string };

// Relative base so the built app loads correctly from Electron's file:// URL
// (where it's hosted as resources/app.asar/dist/index.html). For normal
// browser dev the default base works fine.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    // Dev-only proxies so browser-based `npm run dev` keeps working.
    // In Electron runtime the frontend uses absolute URLs from the backends store.
    proxy: {
      "/api": {
        target: "http://localhost:8001",
        changeOrigin: true,
      },
      "/sk": {
        target: "http://localhost:8000",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/sk/, ""),
      },
    },
  },
  build: {
    // Chromium (WebView2 on Windows, Electron runtime on all platforms).
    target: "chrome110",
  },
});
