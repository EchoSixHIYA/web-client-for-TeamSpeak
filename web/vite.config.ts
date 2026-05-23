import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3030",
      "/ws": {
        target: "ws://localhost:3030",
        ws: true,
      },
    },
  },
});
