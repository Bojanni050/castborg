import pg from "pg";

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Wie de wijziging doet. Later wordt 'admin_token' vanzelf 'user' zodra dashboard-auth er is. */
export type ActorType = "admin_token" | "user";

export interface Actor {
  type: ActorType;
  /** Naam van het token, of later een user_id. */
  id: string;
}

/**
 * Voert `fn` uit in een transactie met de tenant-context gezet.
 *
 * - `set_config(..., true)` is transactie-lokaal (gelijk aan SET LOCAL) en dus veilig met pooling:
 *   na COMMIT/ROLLBACK is de waarde weg, een volgende request op dezelfde connectie erft niets.
 * - Elke query voor tenantdata hoort via deze functie te lopen. Er is bewust geen "kale" pool.query
 *   voor tenanttabellen in de rest van de applicatie.
 * - Geef `actor` mee bij beheerwijzigingen: de trigger op site_settings schrijft die naar
 *   site_settings_history. Zonder actor wordt een wijziging als 'unknown' vastgelegd, wat precies
 *   is wat je wilt zien bij een handmatige UPDATE buiten de API om.
 */
export async function withTenant<T>(
  db: Db,
  siteId: string,
  fn: (q: pg.PoolClient) => Promise<T>,
  actor?: Actor,
): Promise<T> {
  if (!UUID_RE.test(siteId)) throw new Error("Ongeldig site_id");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.site_id', $1, true)", [siteId]);
    if (actor) {
      await client.query("SELECT set_config('app.actor_type', $1, true)", [actor.type]);
      await client.query("SELECT set_config('app.actor_id', $1, true)", [actor.id]);
    }
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Zoekt het site-id bij een publieke sleutel. Werkt zonder tenant-context via een smalle SECURITY DEFINER-functie. */
export async function resolveSiteByPublicKey(db: Db, publicKey: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string | null }>(
    "SELECT resolve_site_by_public_key($1) AS id",
    [publicKey],
  );
  return rows[0]?.id ?? null;
}
