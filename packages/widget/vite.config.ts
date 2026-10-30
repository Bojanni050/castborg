import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  build: {
    // Eén IIFE-bestand, zodat een site alleen een <script> hoeft te plaatsen.
    // De CSS gaat als string mee de bundle in (zie src/styles.ts), dus er is geen los stylesheet
    // dat kan vergeten worden of te laat laden.
    lib: {
      entry: "src/embed.tsx",
      name: "AiLeadWidget",
      formats: ["iife"],
      fileName: () => "widget.js",
    },
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: "esbuild",
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
  },
});
