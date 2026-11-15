import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  root: "src/web",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4311",
      "/ws": { target: "ws://127.0.0.1:4311", ws: true },
    },
  },
  build: { outDir: "../../dist/web", emptyOutDir: true },
});
