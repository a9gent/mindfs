import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": "http://localhost:7331",
      "/ws": {
        target: "ws://localhost:7331",
        ws: true,
      },
    },
  },
});
