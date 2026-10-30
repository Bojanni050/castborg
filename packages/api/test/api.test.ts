import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp, normalizeDomain } from "../src/app.js";
import { createPool, withTenant, type Db } from "../src/db/tenant.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider, type ProviderRequest } from "../src/provider.js";
import { issueSessionToken, verifySessionToken } from "../src/token.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;
class TestProvider extends StubProvider {
  fail = false;
  override complete(req: ProviderRequest) {
    if (this.fail) return Promise.reject(new Error("provider down"));
    return super.complete(req);
  }
}
const provider = new TestProvider();

function makeApp(limiters?: Parameters<typeof createApp>[0]["limiters"]) {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminTokens: [{ name: "test", token: ADMIN }],
    provider,
    pricing: { inputEurPerMTok: 0, outputEurPerMTok: 0 },
    maxOutputTokens: 800,
    limiters,
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function createSite(app: ReturnType<typeof makeApp>, name: string, domains: string[]) {
  const res = await app.request("/api/v1/admin/sites", json({ name, domains }, { authorization: `Bearer ${ADMIN}` }));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; publicKey: string; domains: string[] };
}

async function startConversation(app: ReturnType<typeof makeApp>, key: string, origin?: string) {
  const res = await app.request(
    "/api/v1/conversations",
    json({ pageUrl: "https://voorbeeld.nl/diensten" }, { "x-site-key": key, ...(origin ? { origin } : {}) }),
  );
  return res;
}

beforeAll(async () => {
  await migrateTestDb();
  admin = new pg.Client({ connectionString: MIGRATOR_URL });
  await admin.connect();
  await admin.query("TRUNCATE sites CASCADE");
  db = createPool(APP_URL);
});

afterAll(async () => {
  await db?.end();
  await admin?.end();
});

describe("token", () => {
  it("roundtrip, manipulatie en verlopen", () => {
    const t = issueSessionToken({ siteId: "s", conversationId: "c" }, SECRET, 60, 1_000_000);
    expect(verifySessionToken(t, SECRET, 1_000_000)).toMatchObject({ siteId: "s", conversationId: "c" });
    expect(verifySessionToken(t, "andere-geheim-andere-geheim-andere", 1_000_000)).toBeNull();
    expect(verifySessionToken(t, SECRET, 1_000_000 + 61_000)).toBeNull();
    const [payload, sig] = t.split(".");
    const tampered = Buffer.from(JSON.stringify({ siteId: "x", conversationId: "c", exp: 9_999_999_999 })).toString("base64url");
    expect(verifySessionToken(`${tampered}.${sig}`, SECRET, 1_000_000)).toBeNull();
    expect(verifySessionToken(`${payload}`, SECRET)).toBeNull();
    expect(verifySessionToken("a.b.c", SECRET)).toBeNull();
  });
});

describe("normalizeDomain", () => {
  it("haalt schema, www, poort en pad weg", () => {
    expect(normalizeDomain("https://WWW.Voorbeeld.nl:8443/pad?x=1")).toBe("voorbeeld.nl");
    expect(normalizeDomain("voorbeeld.nl")).toBe("voorbeeld.nl");
  });
});

describe("site aanmaken", () => {
  it("vereist de admin-token", async () => {
    const app = makeApp();
    expect((await app.request("/api/v1/admin/sites", json({ name: "x", domains: ["x.nl"] }))).status).toBe(401);
    const bad = await app.request("/api/v1/admin/sites", json({ name: "x", domains: ["x.nl"] }, { authorization: "Bearer fout" }));
    expect(bad.status).toBe(401);
  });

  it("valideert invoer", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/admin/sites", json({ name: "", domains: [] }, { authorization: `Bearer ${ADMIN}` }));
    expect(res.status).toBe(400);
  });

  it("maakt site, instellingen en domeinen aan en geeft een publieke sleutel", async () => {
    const app = makeApp();
    const site = await createSite(app, "Voorbeeld", ["https://www.Voorbeeld.nl/", "voorbeeld.nl"]);
    expect(site.publicKey).toMatch(/^pk_[a-z0-9]{24}$/);
    expect(site.domains).toEqual(["voorbeeld.nl"]);
  });
});

describe("verticale slice: config -> gesprek -> bericht", () => {
  it("doorloopt de hele flow en slaat berichten op", async () => {
    const app = makeApp();
    const site = await createSite(app, "Slice", ["slice.nl"]);

    const cfg = await app.request(`/api/v1/widget/config?key=${site.publicKey}`, { headers: { origin: "https://slice.nl" } });
    expect(cfg.status).toBe(200);
    expect(await cfg.json()).toMatchObject({ position: "bottom-right", primaryColor: "#2563eb" });
    expect(cfg.headers.get("access-control-allow-origin")).toBe("*");

    const start = await startConversation(app, site.publicKey, "https://www.slice.nl");
    expect(start.status).toBe(201);
    const { conversationId, token } = (await start.json()) as { conversationId: string; token: string };

    const msg = await app.request(
      `/api/v1/conversations/${conversationId}/messages`,
      json({ text: "Wat kost een website?" }, { authorization: `Bearer ${token}` }),
    );
    expect(msg.status).toBe(200);
    expect(((await msg.json()) as { reply: string }).reply).toContain("Wat kost een website?");

    const { rows } = await admin.query("SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id", [conversationId]);
    expect(rows.map((r) => r.role)).toEqual(["user", "assistant"]);
  });

  it("weigert een origin die niet bij de site hoort", async () => {
    const app = makeApp();
    const site = await createSite(app, "Origin", ["eigen.nl"]);
    const cfg = await app.request(`/api/v1/widget/config?key=${site.publicKey}`, { headers: { origin: "https://kwaad.example" } });
    expect(cfg.status).toBe(403);
    expect((await startConversation(app, site.publicKey, "https://kwaad.example")).status).toBe(403);
  });

  it("onbekende of misvormde sleutel geeft 404", async () => {
    const app = makeApp();
    expect((await app.request("/api/v1/widget/config?key=pk_onbekend")).status).toBe(404);
    expect((await app.request("/api/v1/widget/config?key=pk_" + "a".repeat(24))).status).toBe(404);
    expect((await app.request("/api/v1/widget/config")).status).toBe(404);
  });

  it("inactieve site is niet bereikbaar", async () => {
    const app = makeApp();
    const site = await createSite(app, "Inactief", ["inactief.nl"]);
    await admin.query("UPDATE sites SET status = 'inactive' WHERE id = $1", [site.id]);
    expect((await app.request(`/api/v1/widget/config?key=${site.publicKey}`)).status).toBe(404);
  });
});

describe("misbruik en isolatie via de API", () => {
  it("bericht zonder, met valse of verkeerd gebonden token wordt geweigerd", async () => {
    const app = makeApp();
    const a = await createSite(app, "A", ["a.nl"]);
    const b = await createSite(app, "B", ["b.nl"]);
    const ca = (await (await startConversation(app, a.publicKey)).json()) as { conversationId: string; token: string };
    const cb = (await (await startConversation(app, b.publicKey)).json()) as { conversationId: string; token: string };

    const post = (id: string, token?: string) =>
      app.request(`/api/v1/conversations/${id}/messages`, json({ text: "hoi" }, token ? { authorization: `Bearer ${token}` } : {}));

    expect((await post(ca.conversationId)).status).toBe(401);
    expect((await post(ca.conversationId, "rommel")).status).toBe(401);
    // token van gesprek B op gesprek A
    expect((await post(ca.conversationId, cb.token)).status).toBe(401);
    // geldige token, maar site-id vervalst en opnieuw ondertekend met een ander geheim
    const forged = issueSessionToken({ siteId: b.id, conversationId: ca.conversationId }, "ander-geheim-ander-geheim-ander-ge");
    expect((await post(ca.conversationId, forged)).status).toBe(401);
  });

  it("een correct ondertekende token met site B en gesprek van A vindt het gesprek niet (RLS)", async () => {
    const app = makeApp();
    const a = await createSite(app, "A2", ["a2.nl"]);
    const b = await createSite(app, "B2", ["b2.nl"]);
    const ca = (await (await startConversation(app, a.publicKey)).json()) as { conversationId: string };
    const crossToken = issueSessionToken({ siteId: b.id, conversationId: ca.conversationId }, SECRET);
    const res = await app.request(
      `/api/v1/conversations/${ca.conversationId}/messages`,
      json({ text: "hoi" }, { authorization: `Bearer ${crossToken}` }),
    );
    expect(res.status).toBe(404);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [ca.conversationId]);
    expect(rows[0].n).toBe(0);
  });

  it("valideert berichtinhoud (leeg en te lang)", async () => {
    const app = makeApp();
    const s = await createSite(app, "V", ["v.nl"]);
    const c = (await (await startConversation(app, s.publicKey)).json()) as { conversationId: string; token: string };
    const post = (text: unknown) =>
      app.request(`/api/v1/conversations/${c.conversationId}/messages`, json({ text }, { authorization: `Bearer ${c.token}` }));
    expect((await post("")).status).toBe(400);
    expect((await post("x".repeat(2001))).status).toBe(400);
    expect((await post(42)).status).toBe(400);
  });

  it("begrenst het aantal berichten per gesprek", async () => {
    const app = makeApp({ message: new RateLimiter(1000, 60_000) });
    const s = await createSite(app, "Limiet", ["limiet.nl"]);
    await admin.query("UPDATE site_settings SET max_messages_per_conversation = 2 WHERE site_id = $1", [s.id]);
    const c = (await (await startConversation(app, s.publicKey)).json()) as { conversationId: string; token: string };
    const post = () =>
      app.request(`/api/v1/conversations/${c.conversationId}/messages`, json({ text: "hoi" }, { authorization: `Bearer ${c.token}` }));
    expect((await post()).status).toBe(200); // user + assistant = 2 berichten
    expect((await post()).status).toBe(429);
  });

  it("rate limiting op gesprekken starten", async () => {
    const app = makeApp({ conversationStart: new RateLimiter(2, 60_000) });
    const s = await createSite(app, "RL", ["rl.nl"]);
    expect((await startConversation(app, s.publicKey)).status).toBe(201);
    expect((await startConversation(app, s.publicKey)).status).toBe(201);
    expect((await startConversation(app, s.publicKey)).status).toBe(429);
  });

  it("als de provider faalt blijft het gebruikersbericht bewaard en krijgt de widget 502", async () => {
    const app = makeApp();
    const s = await createSite(app, "Falen", ["falen.nl"]);
    const c = (await (await startConversation(app, s.publicKey)).json()) as { conversationId: string; token: string };
    provider.fail = true;
    try {
      const res = await app.request(
        `/api/v1/conversations/${c.conversationId}/messages`,
        json({ text: "hoi" }, { authorization: `Bearer ${c.token}` }),
      );
      expect(res.status).toBe(502);
    } finally {
      provider.fail = false;
    }
    const { rows } = await admin.query("SELECT role FROM messages WHERE conversation_id = $1", [c.conversationId]);
    expect(rows).toEqual([{ role: "user" }]);
    const usage = await admin.query("SELECT status FROM usage_events WHERE conversation_id = $1", [c.conversationId]);
    expect(usage.rows).toEqual([{ status: "error" }]);
  });

  it("preflight (OPTIONS) wordt beantwoord", async () => {
    const app = makeApp();
    const res = await app.request("/api/v1/conversations", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Site-Key");
  });
});

describe("db-rechten van de runtime-rol", () => {
  it("kan geen tabellen aanmaken of verwijderen", async () => {
    await expect(db.query("CREATE TABLE hack (id int)")).rejects.toThrow();
    await expect(db.query("DROP TABLE leads")).rejects.toThrow();
    await expect(withTenant(db, "00000000-0000-0000-0000-000000000000", (q) => q.query("TRUNCATE leads"))).rejects.toThrow();
  });
});
