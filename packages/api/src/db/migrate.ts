import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "..", "migrations");

/**
 * Past alle nog niet toegepaste migraties toe.
 *
 * `appRolePassword` is verplicht: de runtime-rol wordt in 0001 zonder wachtwoord aangemaakt en
 * krijgt het hier. Zo staat er geen wachtwoord in een migratiebestand en kan de rol niet inloggen
 * voordat iemand bewust een wachtwoord heeft gezet.
 */
export async function migrate(connectionString: string, appRolePassword: string): Promise<string[]> {
  if (!appRolePassword || appRolePassword.length < 16) {
    throw new Error("APP_DB_PASSWORD moet minimaal 16 tekens zijn");
  }

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

    // Idempotent: ook als er niets te migreren viel, klopt het wachtwoord na afloop.
    await client.query("ALTER ROLE ailead_app PASSWORD " + quoteLiteral(appRolePassword));
  } finally {
    await client.end();
  }
  return applied;
}

/** SQL-literal met verdubbelde quotes; ALTER ROLE accepteert geen parameters. */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

// CLI: `pnpm db:migrate`
// Let op: `file://${process.argv[1]}` werkt niet op Windows (import.meta.url heeft drie schuine
// strepen), waardoor dit blok stil werd overgeslagen en de migratie niets deed.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const url = process.env.DATABASE_URL_MIGRATOR;
  if (!url) {
    console.error("DATABASE_URL_MIGRATOR ontbreekt");
    process.exit(1);
  }
  const password = process.env.APP_DB_PASSWORD;
  if (!password) {
    console.error("APP_DB_PASSWORD ontbreekt (wachtwoord voor de runtime-rol ailead_app)");
    process.exit(1);
  }
  migrate(url, password).then(
    (applied) => {
      console.log(applied.length ? `Toegepast: ${applied.join(", ")}` : "Niets te doen");
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
