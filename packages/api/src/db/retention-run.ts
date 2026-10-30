import { pathToFileURL } from "node:url";
import type { Actor, Db } from "./tenant.js";
import { createPool } from "./tenant.js";
import { logEvent } from "../log.js";
import { runRetention } from "../retention.js";

/**
 * Past de bewaartermijnen toe voor alle sites. Bedoeld voor een cron of systemd-timer op de VPS:
 *
 *   corepack pnpm retention
 *
 * Waarom een script en geen timer in de API: een proces dat moet blijven draaien om op te ruimen
 * is een proces dat je niet meer durft te herstarten. Zo is opruimen een taak die je kunt plannen,
 * navertellen en opnieuw kunt draaien; dezelfde code zit achter `POST /admin/sites/:id/retention/run`
 * voor als je het met de hand wilt doen.
 *
 * De sites komen uit `dashboard_list_sites()`. Dat is geen sluiproute: die functie geeft alleen
 * id en naam, en elke veegrun daarna loopt gewoon binnen de tenant-context van die ene site.
 */
const RETENTION_ACTOR: Actor = { type: "admin_token", id: "retention-cron" };

export interface SweepResult {
  siteId: string;
  name: string;
  conversations: number;
  messages: number;
  leads: number;
  error?: string;
}

export async function sweepAllSites(db: Db): Promise<SweepResult[]> {
  const sites = (await db.query<{ id: string; name: string }>("SELECT id, name FROM dashboard_list_sites()")).rows;

  const results: SweepResult[] = [];
  for (const site of sites) {
    try {
      const outcome = await runRetention(db, site.id, RETENTION_ACTOR);
      results.push({
        siteId: site.id,
        name: site.name,
        conversations: outcome.conversations,
        messages: outcome.messages,
        leads: outcome.leads,
      });
    } catch (err) {
      // Eén kapotte site mag de rest niet tegenhouden, maar het mag ook niet stil gebeuren.
      const message = err instanceof Error ? err.message : String(err);
      logEvent("error", "retention_site_failed", { siteId: site.id, error: message });
      results.push({ siteId: site.id, name: site.name, conversations: 0, messages: 0, leads: 0, error: message });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL_APP;
  if (!connectionString) {
    console.error("DATABASE_URL_APP ontbreekt.");
    process.exit(1);
  }

  const db = createPool(connectionString);
  try {
    const results = await sweepAllSites(db);
    for (const r of results) {
      if (r.error) {
        console.log(`${r.name}: overgeslagen (${r.error})`);
      } else {
        console.log(`${r.name}: ${r.conversations} gesprekken, ${r.messages} berichten, ${r.leads} leads verwijderd`);
      }
    }
    if (results.length === 0) console.log("Geen sites.");
  } finally {
    await db.end();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main();
}
