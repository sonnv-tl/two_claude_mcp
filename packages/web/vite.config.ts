import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hub = process.env.HUB_HTTP ?? "http://127.0.0.1:4747";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": hub,
      "/ws": { target: hub.replace(/^http/, "ws"), ws: true },
    },
  },
});
