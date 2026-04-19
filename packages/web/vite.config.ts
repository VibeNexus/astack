import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// See docs/asset/design.md § Pass 6 for responsive/keyboard requirements.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Proxy API + SSE to the local daemon during development so the dashboard
    // doesn't have to cross an origin boundary. In production the dashboard
    // is served by the daemon itself so no proxy is needed.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7432",
        changeOrigin: true,
        ws: false
      },
      "/health": {
        target: "http://127.0.0.1:7432",
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    target: "es2022"
  }
});
