import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, ""), ...loadEnv(mode, __dirname, "") };
  const apiTarget = (env.VITE_DEV_API_PROXY ?? "http://127.0.0.1:3001").replace(/\/$/, "");
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      port: Number(env.VITE_DEV_WEB_PORT ?? 5173) || 5173,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
    },
  };
});
