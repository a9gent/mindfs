import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
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
