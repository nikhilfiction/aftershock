/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API and the app are one server: `aftershock serve` answers /api and serves
// the build below at every other address. While developing the UI, `npm run dev`
// forwards /api to that server, so the app always calls its own /api.
const API_SERVER = process.env.AFTERSHOCK_API ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": API_SERVER },
  },
  build: {
    // inside the Python package, so `aftershock serve` (and pip installs) find it
    outDir: "../aftershock/web",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    env: { VITE_API_URL: "http://localhost:8000/api" },
  },
});
