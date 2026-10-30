import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  /**
   * Het dashboard wordt in productie door de API zelf geserveerd (zelfde origin als /api), zodat de
   * sessiecookie geen CORS met credentials nodig heeft. In ontwikkeling doet de proxy hier hetzelfde.
   */
  server: {
    port: 5174,
    host: "127.0.0.1",
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
  },
});
