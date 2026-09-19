import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json" with { type: "json" };
export default defineConfig(({ mode }) => ({
  cacheDir: mode === "test" ? ".local/vite-test" : ".local/vite-dev",
  plugins: [react(), tailwindcss()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  server: {
    host: "127.0.0.1",
    port: 6001,
    strictPort: true,
    allowedHosts: ["eagle.dev.hexly.ai"],
    proxy: {
      "/api": { target: "http://127.0.0.1:36001", changeOrigin: false },
    },
  },
}));
