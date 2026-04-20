import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// E2E harness needs the dev server to proxy to a throwaway daemon on a
// non-default port, not to the user's real 7432 daemon.
// See packages/web/playwright.config.ts for the harness that sets this.
const daemonPort = process.env.ASTACK_E2E_PORT
  ? parseInt(process.env.ASTACK_E2E_PORT, 10)
  : 7432;
const daemonTarget = `http://127.0.0.1:${daemonPort}`;

// See docs/asset/design.md § Pass 6 for responsive/keyboard requirements.
export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Proxy API + SSE to the local daemon during development so the dashboard
    // doesn't have to cross an origin boundary. In production the dashboard
    // is served by the daemon itself so no proxy is needed.
    proxy: {
      "/api": {
        target: daemonTarget,
        changeOrigin: true,
        ws: false
      },
      "/health": {
        target: daemonTarget,
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: "dist",
    target: "es2022"
  }
});
