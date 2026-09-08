import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Root is the web/ directory itself; output goes to ../dist/web so the backend build
// (tsc -> dist/index.js) and this build land side by side under dist/ (see docs/SPEC.md 2.9).
export default defineConfig({
  root: __dirname,
  base: "/",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "../dist/web"),
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
});
