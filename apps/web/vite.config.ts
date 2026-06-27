import path from "path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins } from "vite-plus";

const webHost = process.env.WEB_HOST ?? "0.0.0.0";
const webPort = Number(process.env.WEB_PORT ?? "5173");
const apiHost = process.env.API_HOST ?? "127.0.0.1";
const apiPort = process.env.API_PORT ?? "8000";

// https://vite.dev/config/
export default defineConfig({
  plugins: lazyPlugins(() => [react(), tailwindcss()]),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    allowedHosts: ["azubot.xyz"],
    proxy: {
      "/api/v1": {
        target: `http://${apiHost}:${apiPort}`,
        changeOrigin: true,
      },
    },
  },
});
