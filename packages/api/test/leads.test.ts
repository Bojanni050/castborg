import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createPool, type Db } from "../src/db/tenant.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider } from "../src/provider.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;

function makeApp(opts: { leadWebhook?: { url: string; secret?: string } } = {}) {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminTokens: [{ name: "test", token: ADMIN }],
    provider: new StubProvider(),
    pricing: { inputEurPerMTok: 0, outputEurPerMTok: 0 },
    maxOutputTokens: 800,
    ...opts,
    limiters: { ipMessage: new RateLimiter(10_000, 60_000), message: new RateLimiter(10_000, 60_000) },
  });
}

type App = ReturnType<typeof makeApp>;

const json = (body: unknown) => JSON.stringify(body);

function req(app: App, path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = init.token ?? ADMIN;
  if (token) headers.authorization = `Bearer ${token}`;
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    ...(init.body === undefined ? {} : { body: json(init.body) }),
  });
}

interface Site {
  id: string;
  publicKey: string;
  domains: string[];
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
    body: json({ pageUrl: "https://voorbeeld.nl/" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { conversationId: string; token: string };
}

function submitLead(app: App, conversationId: string, token: string, body: unknown) {
  return app.request(`/api/v1/conversations/${conversationId}/lead`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: json(body),
  });
}

interface Received {
  raw: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/** Kleine HTTP-ontvanger, zodat de webhook echt over de lijn gaat en de ondertekening te controleren is. */
async function startReceiver(): Promise<{ server: Server; url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      received.push({ raw, body: JSON.parse(raw) as Record<string, unknown>, headers: req.headers });
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/hook`, received };
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

describe("lead achterlaten", () => {
  it("vereist het sessietoken van dat gesprek", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Auth");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    expect((await submitLead(app, conversationId, "", { email: "a@b.nl" })).status).toBe(401);

    const other = await startConversation(app, site.publicKey);
    expect((await submitLead(app, conversationId, other.token, { email: "a@b.nl" })).status).toBe(401);
    expect((await submitLead(app, conversationId, token, { email: "a@b.nl" })).status).toBe(201);
  });

  it("weigert een lead zonder contactweg", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Leeg");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    for (const body of [{}, { name: "Bo" }, { message: "bel me" }, { email: "geen-email" }, { email: "" }]) {
      const res = await submitLead(app, conversationId, token, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).hint).toContain("e-mail");
    }
  });

  it("slaat naam, e-mail, telefoon en bericht op, met kleine letters voor e-mail", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Opslaan");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await submitLead(app, conversationId, token, {
      name: "  Bo Jansen ",
      email: "Bo@Voorbeeld.NL ",
      phone: "",
      message: "Graag een offerte voor 40 pagina's",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.created).toBe(true);
    expect(body.leadId).toMatch(/^[0-9a-f-]{36}$/);

    const row = (
      await admin.query(
        "SELECT site_id, conversation_id, name, email, phone, message, status FROM leads WHERE id = $1",
        [body.leadId],
      )
    ).rows[0];
    expect(row.site_id).toBe(site.id);
    expect(row.conversation_id).toBe(conversationId);
    expect(row.name).toBe("Bo Jansen");
    expect(row.email).toBe("bo@voorbeeld.nl");
    expect(row.phone).toBeNull();
    expect(row.message).toBe("Graag een offerte voor 40 pagina's");
    expect(row.status).toBe("new");
  });

  it("is idempotent per gesprek: nog eens sturen werkt de lead bij", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Update");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const first = await (await submitLead(app, conversationId, token, { phone: "+31 6 1234 5678" })).json();
    const second = await submitLead(app, conversationId, token, {
      phone: "+31 6 1234 5678",
      email: "bo@voorbeeld.nl",
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.leadId).toBe(first.leadId);
    expect(body.created).toBe(false);

    const rows = await admin.query("SELECT email FROM leads WHERE conversation_id = $1", [conversationId]);
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].email).toBe("bo@voorbeeld.nl");
  });

  it("weigert onbekende velden in plaats van ze stil te negeren", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Strikt");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await submitLead(app, conversationId, token, { email: "a@b.nl", status: "won" });
    expect(res.status).toBe(400);
  });
});

describe("leads lezen", () => {
  it("vereist de admin-token", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Beheer");
    expect((await req(app, `/api/v1/admin/sites/${site.id}/leads`, { token: "" })).status).toBe(401);
    expect((await req(app, `/api/v1/admin/sites/${site.id}/leads`)).status).toBe(200);
  });

  it("geeft 404 voor een onbekende of ongeldige site", async () => {
    const app = makeApp();
    expect((await req(app, "/api/v1/admin/sites/00000000-0000-4000-8000-000000000000/leads")).status).toBe(404);
    expect((await req(app, "/api/v1/admin/sites/geen-uuid/leads")).status).toBe(404);
  });

  it("toont de leads van deze site, nieuwste eerst, met een limiet", async () => {
    const app = makeApp();
    const site = await createSite(app, "Leads Lijst");

    for (const email of ["een@voorbeeld.nl", "twee@voorbeeld.nl", "drie@voorbeeld.nl"]) {
      const { conversationId, token } = await startConversation(app, site.publicKey);
      expect((await submitLead(app, conversationId, token, { email })).status).toBe(201);
    }

    const res = await req(app, `/api/v1/admin/sites/${site.id}/leads`);
    expect(res.status).toBe(200);
    const { leads } = await res.json();
    expect(leads).toHaveLength(3);
    expect(leads.map((l: { email: string }) => l.email)).toEqual([
      "drie@voorbeeld.nl",
      "twee@voorbeeld.nl",
      "een@voorbeeld.nl",
    ]);
    expect(leads[0].conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(leads[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const limited = await (await req(app, `/api/v1/admin/sites/${site.id}/leads?limit=2`)).json();
    expect(limited.leads).toHaveLength(2);
    expect((await req(app, `/api/v1/admin/sites/${site.id}/leads?limit=0`)).status).toBe(400);
  });

  it("laat geen leads van een andere site zien", async () => {
    const app = makeApp();
    const siteA = await createSite(app, "Leads Isolatie A");
    const siteB = await createSite(app, "Leads Isolatie B");

    const { conversationId, token } = await startConversation(app, siteB.publicKey);
    expect((await submitLead(app, conversationId, token, { email: "geheim@voorbeeld.nl" })).status).toBe(201);

    const res = await req(app, `/api/v1/admin/sites/${siteA.id}/leads`);
    expect(res.status).toBe(200);
    expect((await res.json()).leads).toHaveLength(0);
  });
});

describe("melding bij een lead", () => {
  it("stuurt een ondertekende melding bij een nieuwe lead", async () => {
    const receiver = await startReceiver();
    try {
      const app = makeApp({ leadWebhook: { url: receiver.url, secret: "s3cret" } });
      const site = await createSite(app, "Lead Melding");
      const { conversationId, token } = await startConversation(app, site.publicKey);

      const res = await submitLead(app, conversationId, token, { name: "Bo", email: "Bo@Voorbeeld.nl" });
      expect(res.status).toBe(201);
      const { leadId } = (await res.json()) as { leadId: string };

      await waitFor(() => receiver.received.length === 1);
      const hit = receiver.received[0]!;
      expect(hit.body).toMatchObject({
        event: "lead.created",
        leadId,
        siteId: site.id,
        siteName: "Lead Melding",
        siteKey: site.publicKey,
        conversationId,
        name: "Bo",
        email: "bo@voorbeeld.nl",
        phone: null,
      });
      expect(String(hit.body.receivedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(hit.headers["x-ai-lead-event"]).toBe("lead.created");

      const expected = createHmac("sha256", "s3cret").update(hit.raw).digest("hex");
      expect(hit.headers["x-ai-lead-signature"]).toBe(`sha256=${expected}`);
    } finally {
      receiver.server.close();
    }
  });

  it("meldt een bijgewerkte lead als updated", async () => {
    const receiver = await startReceiver();
    try {
      const app = makeApp({ leadWebhook: { url: receiver.url } });
      const site = await createSite(app, "Lead Melding Update");
      const { conversationId, token } = await startConversation(app, site.publicKey);

      await submitLead(app, conversationId, token, { email: "bo@voorbeeld.nl" });
      await submitLead(app, conversationId, token, { email: "bo@voorbeeld.nl", phone: "+31612345678" });

      await waitFor(() => receiver.received.length === 2);
      expect(receiver.received.map((hit) => hit.body.event)).toEqual(["lead.created", "lead.updated"]);
      expect(receiver.received[1]!.body.phone).toBe("+31612345678");
      // Zonder geheim geen signature-header; wel de gebeurtenis, zodat de ontvanger kan routeren.
      expect(receiver.received[0]!.headers["x-ai-lead-signature"]).toBeUndefined();
    } finally {
      receiver.server.close();
    }
  });

  it("laat de lead niet mislukken als de webhook stuk is", async () => {
    // Poort 1 luistert vrijwel zeker niet: verbinding geweigerd, meteen.
    const app = makeApp({ leadWebhook: { url: "http://127.0.0.1:1/hook" } });
    const site = await createSite(app, "Lead Melding Stuk");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await submitLead(app, conversationId, token, { email: "bo@voorbeeld.nl" });
    expect(res.status).toBe(201);
    const { leadId } = (await res.json()) as { leadId: string };
    const stored = await admin.query("SELECT 1 FROM leads WHERE id = $1", [leadId]);
    expect(stored.rowCount).toBe(1);
  });

  it("slaat een lead met gevulde honeypot niet op en meldt hem niet", async () => {
    const receiver = await startReceiver();
    try {
      const app = makeApp({ leadWebhook: { url: receiver.url } });
      const site = await createSite(app, "Lead Honeypot");
      const { conversationId, token } = await startConversation(app, site.publicKey);

      const res = await submitLead(app, conversationId, token, { email: "bot@spam.nl", website: "http://spam" });
      // Doen alsof het gelukt is: een bot die een fout ziet, past zijn invoer aan.
      expect(res.status).toBe(201);
      expect((await res.json()).created).toBe(true);

      const stored = await admin.query("SELECT 1 FROM leads WHERE conversation_id = $1", [conversationId]);
      expect(stored.rowCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(receiver.received).toHaveLength(0);
    } finally {
      receiver.server.close();
    }
  });

});
