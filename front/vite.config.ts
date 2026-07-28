import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite dev server config. The /api proxy means the front-end can call
// same-origin "/api/upload" during development, and Vite forwards it to
// the Go gateway — no CORS headaches needed on localhost. In production,
// VITE_API_URL (see .env.example) points directly at the deployed
// gateway instead.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_URL || "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
