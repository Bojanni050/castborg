import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Testbestanden delen één Postgres en doen TRUNCATE; daarom niet parallel.
    fileParallelism: false,
  },
});
