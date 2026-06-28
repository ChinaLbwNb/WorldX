import { defineConfig } from "vite";
import path from "node:path";

const devServerOrigin = process.env.VITE_DEV_SERVER_ORIGIN || "http://localhost:3100";
const devWsOrigin = devServerOrigin.replace(/^http/, "ws");

export default defineConfig({
  resolve: {
    alias: {
      "@server-types": path.resolve(__dirname, "../server/src/types"),
    },
  },
  server: {
    port: 3200,
    host: true,
    allowedHosts: [".ngrok-free.dev"],
    proxy: {
      "/api": devServerOrigin,
      "/assets": devServerOrigin,
      "/ws": {
        target: devWsOrigin,
        ws: true,
      },
    },
  },
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "react",
  },
});
