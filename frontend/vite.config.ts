import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds into the Python package so FastAPI serves it. `/assets` belongs to the legacy studio, so the
// bundle lives under `/ui/` instead. In development, API calls go to the Python server on 8765.
export default defineConfig({
  plugins: [react()],
  base: "/",
  build: { outDir: "../person_studio/web/dist", emptyOutDir: true, assetsDir: "ui", sourcemap: false },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8765", "/assets": "http://127.0.0.1:8765" } },
});
