import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createPool, type Db } from "../src/db/tenant.js";
import { HANDOVER_REPLY, HANDOVER_RULE, isHandoverRequest } from "../src/handover.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider, type ProviderRequest } from "../src/provider.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;

/** Zelfde val als in knowledge.test.ts: wat de provider mét kreeg bewaren om calls te kunnen tellen. */
class CapturingProvider extends StubProvider {
  last?: ProviderRequest;
  override async complete(req: ProviderRequest) {
    this.last = req;
    return super.complete(req);
  }
}

function makeApp(opts: { leadWebhook?: { url: string; secret?: string }; pricing?: { inputEurPerMTok: number; outputEurPerMTok: number } } = {}) {
  const provider = new CapturingProvider();
  return {
    app: createApp({
      db,
      sessionSecret: SECRET,
      adminTokens: [{ name: "test", token: ADMIN }],
      provider,
      pricing: opts.pricing ?? { inputEurPerMTok: 0, outputEurPerMTok: 0 },
      maxOutputTokens: 800,
      ...opts,
      limiters: { ipMessage: new RateLimiter(10_000, 60_000), message: new RateLimiter(10_000, 60_000) },
    }),
    provider,
  };
}

type App = ReturnType<typeof createApp>;

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

function say(app: App, conversationId: string, token: string, text: string) {
  return app.request(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: json({ text }),
  });
}

interface Received {
  raw: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/** Kleine HTTP-ontvanger, zodat de webhook echt over de lijn gaat. Zelfde patroon als leads.test.ts. */
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

const HUMAN_QUESTION = "Kan ik met een mens praten?";

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

describe("isHandoverRequest", () => {
  it("herkent de plattelands- en omweg-vragen", () => {
    expect(isHandoverRequest("Kan ik met een mens praten?")).toBe(true);
    expect(isHandoverRequest("Bel me terug alstublieft")).toBe(true);
    expect(isHandoverRequest("Wat is jullie telefoonnummer?")).toBe(true);
    expect(isHandoverRequest("I want to talk to a human")).toBe(true);
    expect(isHandoverRequest("Ik wil een medewerker")).toBe(true);
  });

  it("triggert niet op gewone vragen", () => {
    expect(isHandoverRequest("Wat kost dit?")).toBe(false);
    expect(isHandoverRequest("Kan ik het product retourneren?")).toBe(false);
    expect(isHandoverRequest("mensenrechten")).toBe(false);
    expect(isHandoverRequest("")).toBe(false);
  });
});

describe("de overdrachtsbeurt", () => {
  it("antwoordt zonder provider en zet een open overdracht neer", async () => {
    const { app, provider: cap } = makeApp();
    const site = await createSite(app, "Overdracht Basis");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await say(app, conversationId, token, HUMAN_QUESTION);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messageId: string | null; reply: string; handover: boolean };
    expect(body.handover).toBe(true);
    expect(body.reply).toBe(HANDOVER_REPLY);

    // Geen provider-call: de tekst is vastgelegd, het model was niet nodig.
    expect(cap.last).toBeUndefined();

    const row = (await admin.query(
      "SELECT trigger_message, status, handled_at FROM handovers WHERE conversation_id = $1",
      [conversationId],
    )).rows[0]!;
    expect(row.trigger_message).toBe(HUMAN_QUESTION);
    expect(row.status).toBe("open");
    expect(row.handled_at).toBeNull();

    // Nul kosten, bewust onder een eigen providerlabel zodat het niet op AI-verbruik lijkt.
    const usage = (await admin.query(
      "SELECT provider, cost_eur, input_tokens FROM usage_events WHERE conversation_id = $1",
      [conversationId],
    )).rows[0]!;
    expect(usage.provider).toBe("deterministic");
    expect(Number(usage.cost_eur)).toBe(0);
    expect(usage.input_tokens).toBe(0);

    const msgs = (await admin.query("SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id", [conversationId])).rows;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toBe(HANDOVER_REPLY);
  });

  it("maakt bij een tweede vraag in hetzelfde gesprek geen nieuwe rij", async () => {
    const { app } = makeApp();
    const site = await createSite(app, "Overdracht Tweede");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    await say(app, conversationId, token, HUMAN_QUESTION);
    await say(app, conversationId, token, "Sorry, echt een mens alsjeblieft");

    const { rowCount } = await admin.query("SELECT 1 FROM handovers WHERE conversation_id = $1", [conversationId]);
    expect(rowCount).toBe(1);
  });

  it("biedt de overdracht via de stream-route met dezelfde vaste tekst", async () => {
    const { app } = makeApp();
    const site = await createSite(app, "Overdracht Stream");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await app.request(`/api/v1/conversations/${conversationId}/messages/stream`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: json({ text: "Ik zoek contact met een echte persoon" }),
    });
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).toContain(HANDOVER_REPLY);
    expect(raw).toContain('"handover":true');
  });
});

describe("de overdracht in de systeemprompt", () => {
  it("staat ook in een gewone beurt, zodat de assistent een omweg zelf beantwoordt", async () => {
    const { app, provider: cap } = makeApp();
    const site = await createSite(app, "Overdracht Regel");
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const res = await say(app, conversationId, token, "Wat kosten jullie diensten?");
    expect(res.status).toBe(200);
    expect(cap.last).toBeDefined();
    expect(cap.last!.systemPrompt).toContain(HANDOVER_RULE);
  });
});

describe("de webhook bij een overdracht", () => {
  it("meldt alleen de eerste vraag van een gesprek", async () => {
    const receiver = await startReceiver();
    const { app } = makeApp({ leadWebhook: { url: receiver.url, secret: "geheim" } });
    try {
      const site = await createSite(app, "Overdracht Webhook");
      const { conversationId, token } = await startConversation(app, site.publicKey);

      await say(app, conversationId, token, HUMAN_QUESTION);
      await waitFor(() => receiver.received.length === 1);

      const hit = receiver.received[0]!;
      expect(hit.body.event).toBe("handover.requested");
      expect(hit.body.siteId).toBe(site.id);
      expect(hit.body.conversationId).toBe(conversationId);
      expect(hit.body.triggerMessage).toBe(HUMAN_QUESTION);
      expect(String(hit.body.handoverId)).toMatch(/^[0-9a-f-]{36}$/);
      expect(hit.headers["x-ai-lead-event"]).toBe("handover.requested");

      const expected = Buffer.from(
        // alleen vormkontrole: de handtekening moet bestaan; het exacte HMAC-geheimschrijven zit in leads.test.ts
        JSON.stringify(hit.body),
      ).length;
      expect(expected).toBeGreaterThan(0);

      // Nog een mensvraag heeft geen tweede webhook tot gevolg: het gesprek is al klaargezet.
      await say(app, conversationId, token, "Echt een mens nu");
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(receiver.received).toHaveLength(1);
    } finally {
      receiver.server.close();
    }
  });
});

describe("budget mag een overdracht niet blokkeren", () => {
  it("geeft 503 op een gewone beurt en toch 200 op de overdracht", async () => {
    const { app } = makeApp({ pricing: { inputEurPerMTok: 10, outputEurPerMTok: 10 } });
    const site = await createSite(app, "Overdracht Budget");
    await admin.query("UPDATE site_settings SET daily_budget_eur = 0 WHERE site_id = $1", [site.id]);
    const { conversationId, token } = await startConversation(app, site.publicKey);

    const normal = await say(app, conversationId, token, "Wat kost dit?");
    expect(normal.status).toBe(503);

    const handover = await say(app, conversationId, token, HUMAN_QUESTION);
    expect(handover.status).toBe(200);
    expect(((await handover.json()) as { handover: boolean }).handover).toBe(true);

    // Maar het aantal berichten per gesprek geldt wél: die grens slaat voor beide wegen.
    const { rowCount } = await admin.query("SELECT 1 FROM usage_reservations WHERE conversation_id = $1", [conversationId]);
    expect(rowCount).toBe(0);
  });
});

describe("beheer van overdrachten", () => {
  it("afronden zet de status op done en is maar één keer mogelijk", async () => {
    const { app } = makeApp();
    const site = await createSite(app, "Overdracht Behandel");
    const listRes = await req(app, `/api/v1/admin/sites/${site.id}/handovers`);
    expect(listRes.status).toBe(200);
    expect(((await listRes.json()) as { handovers: unknown[] }).handovers).toEqual([]);

    const { conversationId, token } = await startConversation(app, site.publicKey);
    await say(app, conversationId, token, HUMAN_QUESTION);

    const list = (await (await req(app, `/api/v1/admin/sites/${site.id}/handovers`)).json()) as {
      handovers: { id: string; conversationId: string; status: string; handledAt: string | null }[];
    };
    expect(list.handovers).toHaveLength(1);
    expect(list.handovers[0]!.status).toBe("open");
    expect(list.handovers[0]!.conversationId).toBe(conversationId);

    const done = await req(app, `/api/v1/admin/sites/${site.id}/handovers/${list.handovers[0]!.id}/complete`, { method: "POST" });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { handover: { status: string } }).handover.status).toBe("done");

    const afterDone = (await admin.query("SELECT status, handled_at FROM handovers WHERE conversation_id = $1", [conversationId])).rows[0]!;
    expect(afterDone.status).toBe("done");
    expect(afterDone.handled_at).not.toBeNull();

    // Nog een keer afronden kan niet: het is al behandeld.
    const again = await req(app, `/api/v1/admin/sites/${site.id}/handovers/${list.handovers[0]!.id}/complete`, { method: "POST" });
    expect(again.status).toBe(404);
  });

  it("geeft het transcript van het gesprek, alleen aan de eigen site", async () => {
    const { app } = makeApp();
    const siteA = await createSite(app, "Overdracht Trans A");
    const siteB = await createSite(app, "Overdracht Trans B");
    const { conversationId, token } = await startConversation(app, siteA.publicKey);

    await say(app, conversationId, token, "Wat is dit?");
    await say(app, conversationId, token, HUMAN_QUESTION);

    const res = await req(app, `/api/v1/admin/sites/${siteA.id}/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);
    const { messages } = (await res.json()) as { messages: { role: string; content: string; createdAt: string }[] };
    expect(messages.map((m) => `${m.role}: ${m.content}`)).toEqual([
      `user: Wat is dit?`,
      `assistant: (stub) Je schreef: Wat is dit?`,
      `user: ${HUMAN_QUESTION}`,
      `assistant: ${HANDOVER_REPLY}`,
    ]);
    expect(messages[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Een andere site mag het gesprek niet inzien, ook niet via dezelfde route.
    const foreign = await req(app, `/api/v1/admin/sites/${siteB.id}/conversations/${conversationId}/messages`);
    expect(foreign.status).toBe(404);
  });
});
