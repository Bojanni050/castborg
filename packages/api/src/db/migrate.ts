import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

export async function migrate(connectionString: string): Promise<string[]> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} mislukt: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// CLI: `pnpm db:migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) {
    console.error("DATABASE_URL_MIGRATOR ontbreekt");
    process.exit(1);
  }
  migrate(url).then((applied) => {
    console.log(applied.length ? `Toegepast: ${applied.join(", ")}` : "Niets te doen");
  });
}
