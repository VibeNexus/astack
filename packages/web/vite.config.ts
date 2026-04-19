import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// See docs/asset/design.md § Pass 6 for responsive/keyboard requirements.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: "dist",
    target: "es2022"
  }
});
