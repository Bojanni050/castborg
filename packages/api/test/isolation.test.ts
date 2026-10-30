import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPool, resolveSiteByPublicKey, withTenant, type Db } from "../src/db/tenant.js";
import { APP_URL, MIGRATOR_URL, migrateTestDb } from "./support.js";

let admin: pg.Client; // superuser/eigenaar: alleen voor seeding
let app: Db; // runtime-rol: onderworpen aan RLS

let siteA: string;
let siteB: string;
let convA: string;
let convB: string;

async function seedSite(name: string, publicKey: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    "INSERT INTO sites (name, public_key) VALUES ($1, $2) RETURNING id",
    [name, publicKey],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  await migrateTestDb();
  admin = new pg.Client({ connectionString: MIGRATOR_URL });
  await admin.connect();
  await admin.query("TRUNCATE sites CASCADE");

  siteA = await seedSite("Site A", "pk_aaaaaaaaaaaaaaaaaaaaaaaa");
  siteB = await seedSite("Site B", "pk_bbbbbbbbbbbbbbbbbbbbbbbb");

  for (const [id, label] of [[siteA, "A"], [siteB, "B"]] as const) {
    await admin.query("INSERT INTO site_settings (site_id, system_prompt) VALUES ($1, $2)", [id, `prompt ${label}`]);
    await admin.query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [id, `${label.toLowerCase()}.example`]);
  }

  convA = (await admin.query<{ id: string }>(
    "INSERT INTO conversations (site_id) VALUES ($1) RETURNING id", [siteA])).rows[0]!.id;
  convB = (await admin.query<{ id: string }>(
    "INSERT INTO conversations (site_id) VALUES ($1) RETURNING id", [siteB])).rows[0]!.id;

  await admin.query("INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1,$2,'user','geheim van A')", [siteA, convA]);
  await admin.query("INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1,$2,'user','geheim van B')", [siteB, convB]);
  await admin.query("INSERT INTO leads (site_id, conversation_id, email) VALUES ($1,$2,'a@lead.example')", [siteA, convA]);
  await admin.query("INSERT INTO leads (site_id, conversation_id, email) VALUES ($1,$2,'b@lead.example')", [siteB, convB]);

  app = createPool(APP_URL);
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
});

describe("runtime-rol", () => {
  it("is geen superuser en omzeilt RLS niet", async () => {
    const { rows } = await app.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});

describe("tenant-isolatie", () => {
  const tables = ["sites", "site_domains", "site_settings", "conversations", "messages", "leads"] as const;

  it("zonder tenant-context ziet de app-rol niets (fail closed)", async () => {
    for (const t of tables) {
      const { rows } = await app.query(`SELECT * FROM ${t}`);
      expect(rows, `tabel ${t}`).toHaveLength(0);
    }
  });

  it("site A ziet alleen eigen rijen in elke tabel", async () => {
    await withTenant(app, siteA, async (q) => {
      for (const t of tables) {
        const { rows } = await q.query<{ site_id?: string; id: string }>(`SELECT * FROM ${t}`);
        expect(rows.length, `tabel ${t}`).toBeGreaterThan(0);
        for (const r of rows) {
          expect(t === "sites" ? r.id : r.site_id, `tabel ${t}`).toBe(siteA);
        }
      }
    });
  });

  it("site A kan gesprek, berichten en lead van B niet ophalen, ook niet op id", async () => {
    await withTenant(app, siteA, async (q) => {
      expect((await q.query("SELECT * FROM conversations WHERE id = $1", [convB])).rows).toHaveLength(0);
      expect((await q.query("SELECT * FROM messages WHERE conversation_id = $1", [convB])).rows).toHaveLength(0);
      expect((await q.query("SELECT * FROM leads WHERE conversation_id = $1", [convB])).rows).toHaveLength(0);
      expect((await q.query("SELECT * FROM leads WHERE site_id = $1", [siteB])).rows).toHaveLength(0);
    });
  });

  it("site A kan niet schrijven namens B (WITH CHECK)", async () => {
    await expect(
      withTenant(app, siteA, (q) =>
        q.query("INSERT INTO leads (site_id, email) VALUES ($1, 'indringer@x.example')", [siteB]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("site A kan rijen van B niet wijzigen of verwijderen", async () => {
    await withTenant(app, siteA, async (q) => {
      const upd = await q.query("UPDATE leads SET status = 'won' WHERE site_id = $1", [siteB]);
      expect(upd.rowCount).toBe(0);
      const del = await q.query("DELETE FROM messages WHERE site_id = $1", [siteB]);
      expect(del.rowCount).toBe(0);
    });
    const { rows } = await admin.query("SELECT status FROM leads WHERE site_id = $1", [siteB]);
    expect(rows[0]).toEqual({ status: "new" });
  });

  it("een SQL-injectiepoging via site_id wordt geweigerd", async () => {
    await expect(withTenant(app, "'; DROP TABLE sites; --", async () => 1)).rejects.toThrow(/Ongeldig site_id/);
  });

  it("de tenant-context lekt niet via de pool naar een volgende request", async () => {
    await withTenant(app, siteA, async (q) => {
      expect((await q.query("SELECT count(*)::int AS n FROM leads")).rows[0]).toEqual({ n: 1 });
    });
    // Alle connecties kunnen hergebruikt worden; zonder context moet het weer leeg zijn.
    const results = await Promise.all(
      Array.from({ length: 20 }, () => app.query("SELECT count(*)::int AS n FROM leads")),
    );
    for (const r of results) expect(r.rows[0]).toEqual({ n: 0 });
  });

  it("een transactie met context zet de waarde niet door na afloop", async () => {
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.site_id', $1, true)", [siteA]);
      await client.query("COMMIT");
      const { rows } = await client.query("SELECT current_setting('app.site_id', true) AS v");
      expect(rows[0]!.v === null || rows[0]!.v === "").toBe(true);
    } finally {
      client.release();
    }
  });
});

describe("publieke sleutel", () => {
  it("resolve geeft alleen het site-id van een actieve site", async () => {
    expect(await resolveSiteByPublicKey(app, "pk_aaaaaaaaaaaaaaaaaaaaaaaa")).toBe(siteA);
    expect(await resolveSiteByPublicKey(app, "pk_onbekend")).toBeNull();
  });

  it("inactieve sites worden niet geresolved", async () => {
    await admin.query("UPDATE sites SET status = 'inactive' WHERE id = $1", [siteB]);
    expect(await resolveSiteByPublicKey(app, "pk_bbbbbbbbbbbbbbbbbbbbbbbb")).toBeNull();
    await admin.query("UPDATE sites SET status = 'active' WHERE id = $1", [siteB]);
  });
});

describe("dubbele leads", () => {
  it("één gesprek kan maar één lead opleveren", async () => {
    await expect(
      withTenant(app, siteA, (q) =>
        q.query("INSERT INTO leads (site_id, conversation_id, email) VALUES ($1,$2,'dubbel@x.example')", [siteA, convA]),
      ),
    ).rejects.toThrow(/unique|duplicate/i);
  });
});
