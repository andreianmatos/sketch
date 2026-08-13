import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

declare const process: { env: Record<string, string | undefined> };

const pages = process.env.GITHUB_PAGES === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: pages ? "/sketch/" : "/",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        walk: "walk.html",
      },
    },
  },
});
