import { migrate } from "../src/db/migrate.js";

/**
 * Migratie-URL en het wachtwoord dat de tests op de runtime-rol zetten.
 *
 * De APP-URL wordt hier afgeleid van de migratie-URL in plaats van uit DATABASE_URL_APP gelezen:
 * `migrate()` zet het wachtwoord van ailead_app, dus de pool moet exact datzelfde wachtwoord
 * gebruiken. Twee losse bronnen lopen gegarandeerd uit elkaar.
 *
 * Daarom ook eerst de .env laden: draaien de tests met een ander wachtwoord dan de app, dan zet
 * elke testrun de rol op een wachtwoord dat de dev-server niet kent en krijg je 500's met
 * "password authentication failed". In CI zonder .env gelden de defaults hieronder.
 */
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {
  /* geen .env: dan de defaults */
}

export const MIGRATOR_URL = process.env.DATABASE_URL_MIGRATOR ?? "postgres://postgres:postgres@127.0.0.1:5435/ailead";
export const APP_PASSWORD = process.env.APP_DB_PASSWORD ?? "test-app-password-0123456789";

export const APP_URL = (() => {
  const url = new URL(MIGRATOR_URL);
  url.username = "ailead_app";
  url.password = APP_PASSWORD;
  return url.toString();
})();

export async function migrateTestDb(): Promise<void> {
  await migrate(MIGRATOR_URL, APP_PASSWORD);
}

export const SECRET = "x".repeat(40);
export const ADMIN = "admin-test-token";
