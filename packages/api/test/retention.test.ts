import { beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createPool, type Db } from "../src/db/tenant.js";
import { sweepAllSites } from "../src/db/retention-run.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider } from "../src/provider.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;

function makeApp() {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminTokens: [{ name: "test", token: ADMIN }],
    provider: new StubProvider(),
    pricing: { inputEurPerMTok: 0, outputEurPerMTok: 0 },
    maxOutputTokens: 800,
    limiters: { ipMessage: new RateLimiter(10_000, 60_000), message: new RateLimiter(10_000, 60_000) },
  });
}

type App = ReturnType<typeof makeApp>;

function req(app: App, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token ?? ADMIN;
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

interface Site {
  id: string;
  publicKey: string;
}

async function createSite(app: App, name: string): Promise<Site> {
  const res = await req(app, "/api/v1/admin/sites", { body: { name, domains: [`${name.toLowerCase()}.nl`] } });
  expect(res.status).toBe(201);
  return (await res.json()) as Site;
}

async function startConversation(app: App, key: string) {
  const res = await app.request("/api/v1/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-key": key },
    body: JSON.stringify({ pageUrl: "https://voorbeeld.nl/" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { conversationId: string; token: string };
}

async function sendMessage(app: App, conversationId: string, token: string, text: string) {
  const res = await app.request(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  expect(res.status).toBe(200);
}

async function submitLead(app: App, conversationId: string, token: string) {
  const res = await app.request(`/api/v1/conversations/${conversationId}/lead`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "Bo", email: "bo@voorbeeld.nl" }),
  });
  expect(res.status).toBe(201);
}

async function truncateAll() {
  await admin.query("TRUNCATE sites CASCADE");
}

/** Zet een tijdstip terug in het verleden. Alleen tests doen dit; de API kent geen tijdreizen. */
async function backdate(table: "conversations" | "leads", column: "updated_at" | "created_at", id: string, days: number) {
  await admin.query(`UPDATE ${table} SET ${column} = now() - make_interval(days => $1) WHERE id = $2`, [days, id]);
}

beforeAll(async () => {
  await migrateTestDb();
  admin = new pg.Client({ connectionString: MIGRATOR_URL });
  await admin.connect();
  await truncateAll();
  db = createPool(APP_URL);
});

describe("gesprekken opruimen", () => {
  it("verwijdert een gesprek met berichten, laat de lead staan en houdt de kosten", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Opruim");
    const conv = await startConversation(app, site.publicKey);
    await sendMessage(app, conv.conversationId, conv.token, "Hallo, wat kost een site?");
    await sendMessage(app, conv.conversationId, conv.token, "En hoe lang duurt het?");
    await submitLead(app, conv.conversationId, conv.token);

    const res = await req(app, `/api/v1/admin/sites/${site.id}/conversations/${conv.conversationId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: { conversations: 1, messages: 4, leads: 0, leadsDetached: 1 },
    });

    // Berichten weg, gesprek weg.
    expect((await admin.query("SELECT 1 FROM messages WHERE conversation_id = $1", [conv.conversationId])).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [conv.conversationId])).rowCount).toBe(0);

    // De lead is het geld van de klant: die blijft, maar raakt zijn gesprek kwijt.
    const lead = (await admin.query<{ conversation_id: string | null }>("SELECT conversation_id FROM leads")).rows;
    expect(lead).toHaveLength(1);
    expect(lead[0]!.conversation_id).toBeNull();

    // De kostenadministratie blijft kloppen: rijen blijven, het gesprek hangt er niet meer aan.
    const usage = (await admin.query<{ conversation_id: string | null }>("SELECT conversation_id FROM usage_events")).rows;
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((row) => row.conversation_id === null)).toBe(true);

    // En het staat in het log, met aantallen en zonder inhoud.
    const logged = (
      await admin.query<{ source: string; subject: string; conversations: number; messages: number; actor_id: string }>(
        "SELECT source, subject, conversations, messages, actor_id FROM deletion_log",
      )
    ).rows;
    expect(logged).toEqual([{ source: "manual", subject: "conversation", conversations: 1, messages: 4, actor_id: "test" }]);
  });

  it("weigert een gesprek van een andere site", async () => {
    await truncateAll();
    const app = makeApp();
    const a = await createSite(app, "Eigen");
    const b = await createSite(app, "Ander");
    const conv = await startConversation(app, b.publicKey);

    const res = await req(app, `/api/v1/admin/sites/${a.id}/conversations/${conv.conversationId}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [conv.conversationId])).rowCount).toBe(1);
  });

  it("geeft 404 voor een onbekend of ongeldig id", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Leeg");
    expect((await req(app, `/api/v1/admin/sites/${site.id}/conversations/${crypto.randomUUID()}`, { method: "DELETE" })).status).toBe(404);
    expect((await req(app, `/api/v1/admin/sites/${site.id}/conversations/geen-uuid`, { method: "DELETE" })).status).toBe(404);
  });

  it("toont de gesprekken met een stukje van het eerste bezoekersbericht", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Lijst");
    const first = await startConversation(app, site.publicKey);
    await sendMessage(app, first.conversationId, first.token, "Eerste vraag");
    const second = await startConversation(app, site.publicKey);
    await sendMessage(app, second.conversationId, second.token, "Tweede vraag");
    // Het tweede gesprek is het laatst actief en hoort bovenaan.
    await admin.query("UPDATE conversations SET updated_at = now() + interval '1 minute' WHERE id = $1", [second.conversationId]);

    const res = await req(app, `/api/v1/admin/sites/${site.id}/conversations`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ id: string; preview: string; messageCount: number }> };
    expect(body.conversations.map((c) => c.id)).toEqual([second.conversationId, first.conversationId]);
    expect(body.conversations[0]!.preview).toBe("Tweede vraag");
    expect(body.conversations[0]!.messageCount).toBe(2);

    expect((await req(app, `/api/v1/admin/sites/${site.id}/conversations?limit=0`)).status).toBe(400);
    expect((await req(app, `/api/v1/admin/sites/${site.id}/conversations`, { token: "" })).status).toBe(401);
  });
});

describe("leads opruimen", () => {
  it("verwijdert één lead en logt dat, zonder het gesprek aan te raken", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Leadweg");
    const conv = await startConversation(app, site.publicKey);
    await submitLead(app, conv.conversationId, conv.token);

    const leadId = (await admin.query<{ id: string }>("SELECT id FROM leads")).rows[0]!.id;
    const res = await req(app, `/api/v1/admin/sites/${site.id}/leads/${leadId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect((await admin.query("SELECT 1 FROM leads")).rowCount).toBe(0);
    // Het gesprek blijft: de inhoud is een aparte bewaartermijn.
    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [conv.conversationId])).rowCount).toBe(1);

    expect((await req(app, `/api/v1/admin/sites/${site.id}/leads/${leadId}`, { method: "DELETE" })).status).toBe(404);
    const logged = (await admin.query<{ subject: string; leads: number }>("SELECT subject, leads FROM deletion_log")).rows;
    expect(logged).toEqual([{ subject: "lead", leads: 1 }]);
  });
});

describe("bewaartermijnen", () => {
  it("ruimt oude gesprekken op en laat recente staan", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Termijn");
    expect((await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { conversationRetentionDays: 30 } })).status).toBe(200);

    const old = await startConversation(app, site.publicKey);
    await sendMessage(app, old.conversationId, old.token, "Van vorige maand");
    await backdate("conversations", "updated_at", old.conversationId, 40);

    const recent = await startConversation(app, site.publicKey);
    await sendMessage(app, recent.conversationId, recent.token, "Van vandaag");

    const res = await req(app, `/api/v1/admin/sites/${site.id}/retention/run`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deleted: { conversations: 1, messages: 2, leads: 0, conversationRetentionDays: 30, leadRetentionDays: 365 },
    });

    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [old.conversationId])).rowCount).toBe(0);
    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [recent.conversationId])).rowCount).toBe(1);
  });

  it("ruimt oude leads op met hun eigen termijn", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Leadtermijn");
    const conv = await startConversation(app, site.publicKey);
    await submitLead(app, conv.conversationId, conv.token);

    const leadId = (await admin.query<{ id: string }>("SELECT id FROM leads")).rows[0]!.id;
    await backdate("leads", "created_at", leadId, 400);

    const res = await req(app, `/api/v1/admin/sites/${site.id}/retention/run`, { method: "POST" });
    expect(((await res.json()) as { deleted: { leads: number } }).deleted.leads).toBe(1);
    expect((await admin.query("SELECT 1 FROM leads")).rowCount).toBe(0);
  });

  it("doet niets bij termijn 0", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Bewaar");
    expect(
      (await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { conversationRetentionDays: 0, leadRetentionDays: 0 } }))
        .status,
    ).toBe(200);

    const conv = await startConversation(app, site.publicKey);
    await sendMessage(app, conv.conversationId, conv.token, "Lang geleden");
    await backdate("conversations", "updated_at", conv.conversationId, 3000);
    await submitLead(app, conv.conversationId, conv.token);
    const leadId = (await admin.query<{ id: string }>("SELECT id FROM leads")).rows[0]!.id;
    await backdate("leads", "created_at", leadId, 3000);

    const res = await req(app, `/api/v1/admin/sites/${site.id}/retention/run`, { method: "POST" });
    expect(((await res.json()) as { deleted: { conversations: number; leads: number } }).deleted).toMatchObject({
      conversations: 0,
      leads: 0,
    });
    expect((await admin.query("SELECT 1 FROM conversations WHERE id = $1", [conv.conversationId])).rowCount).toBe(1);
    expect((await admin.query("SELECT 1 FROM leads")).rowCount).toBe(1);
  });

  it("legt een gewijzigde termijn vast in de instellingenhistorie", async () => {
    await truncateAll();
    const app = makeApp();
    const site = await createSite(app, "Historie");
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { conversationRetentionDays: 45 } });

    const last = (
      await admin.query<{ changed_fields: string[]; after: Record<string, unknown> }>(
        "SELECT changed_fields, after FROM site_settings_history ORDER BY changed_at DESC LIMIT 1",
      )
    ).rows[0]!;
    expect(last.changed_fields).toEqual(["conversation_retention_days"]);
    expect(last.after.conversation_retention_days).toBe(45);
  });

  it("de cron veegt alle sites in één run", async () => {
    await truncateAll();
    const app = makeApp();
    const a = await createSite(app, "CronA");
    const b = await createSite(app, "CronB");
    const convA = await startConversation(app, a.publicKey);
    const convB = await startConversation(app, b.publicKey);
    await sendMessage(app, convA.conversationId, convA.token, "A");
    await sendMessage(app, convB.conversationId, convB.token, "B");
    await backdate("conversations", "updated_at", convA.conversationId, 200);
    await backdate("conversations", "updated_at", convB.conversationId, 200);

    const results = await sweepAllSites(db);
    const mine = results.filter((r) => r.siteId === a.id || r.siteId === b.id);
    expect(mine.map((r) => r.conversations).sort()).toEqual([1, 1]);
    expect(mine.every((r) => r.error === undefined)).toBe(true);
    expect((await admin.query("SELECT 1 FROM conversations")).rowCount).toBe(0);
  });
});

describe("het verwijderlog", () => {
  it("is per site leesbaar en niet te wijzigen door de runtime-rol", async () => {
    await truncateAll();
    const app = makeApp();
    const a = await createSite(app, "LogA");
    const b = await createSite(app, "LogB");
    const conv = await startConversation(app, a.publicKey);
    await req(app, `/api/v1/admin/sites/${a.id}/conversations/${conv.conversationId}`, { method: "DELETE" });

    const own = (await (await req(app, `/api/v1/admin/sites/${a.id}/deletions`)).json()) as { deletions: Array<{ subject: string }> };
    expect(own.deletions).toHaveLength(1);
    expect(own.deletions[0]!.subject).toBe("conversation");

    const other = (await (await req(app, `/api/v1/admin/sites/${b.id}/deletions`)).json()) as { deletions: unknown[] };
    expect(other.deletions).toEqual([]);
    expect((await req(app, `/api/v1/admin/sites/${a.id}/deletions`, { token: "" })).status).toBe(401);

    const privileges = (
      await admin.query<{ upd: boolean; del: boolean; ins: boolean }>(
        `SELECT has_table_privilege('ailead_app', 'deletion_log', 'UPDATE') AS upd,
                has_table_privilege('ailead_app', 'deletion_log', 'DELETE') AS del,
                has_table_privilege('ailead_app', 'deletion_log', 'INSERT') AS ins`,
      )
    ).rows[0]!;
    expect(privileges).toEqual({ upd: false, del: false, ins: true });
  });
});
