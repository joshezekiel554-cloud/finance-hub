import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.PORT || "3001";

  return {
    root: path.resolve(__dirname, "src/web"),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "~": path.resolve(__dirname, "src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
        "/oauth": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: path.resolve(__dirname, "dist/web"),
      emptyOutDir: true,
      // Two SPAs from one build: finance (index.html) and Hold Orders
      // (holds.html, served on holdorders.feldart.com by Host — see
      // src/server/server.ts). Dev: http://localhost:5173/holds.html.
      rollupOptions: {
        input: {
          main: path.resolve(__dirname, "src/web/index.html"),
          holds: path.resolve(__dirname, "src/web/holds.html"),
        },
      },
    },
  };
});
