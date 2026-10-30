import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { migrate } from "../src/db/migrate.js";
import { createPool, type Db } from "../src/db/tenant.js";
import { MistralProvider } from "../src/mistral.js";
import { RateLimiter } from "../src/ratelimit.js";

const MIGRATOR_URL =
  process.env.DATABASE_URL_MIGRATOR ?? "postgres://postgres:postgres@127.0.0.1:5432/ailead";
const APP_URL =
  process.env.DATABASE_URL_APP ?? "postgres://ailead_app:change-me-in-production@127.0.0.1:5432/ailead";
const SECRET = "y".repeat(40);
const ADMIN = "admin-test-token";

// Hoge prijzen zodat een paar tokens al zichtbare kosten geven: 20 in + 5 uit = 0,02 + 0,01 = 0,03 euro
const PRICING = { inputEurPerMTok: 1000, outputEurPerMTok: 2000 };

let admin: pg.Client;
let db: Db;
let fake: Server;
let handler: (req: IncomingMessage, res: ServerResponse) => void;
let fakeCalls = 0;

const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
const delta = (t: string) => sse({ choices: [{ delta: { content: t } }] });
const usageChunk = (i: number, o: number) => sse({ choices: [{ delta: {} }], usage: { prompt_tokens: i, completion_tokens: o } });

function happyStream(res: ServerResponse, withUsage = true) {
  res.setHeader("content-type", "text/event-stream");
  res.write(delta("Hallo "));
  res.write(delta("daar"));
  if (withUsage) res.write(usageChunk(20, 5));
  res.end("data: [DONE]\n\n");
}

function makeApp() {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminToken: ADMIN,
    provider: new MistralProvider({
      apiKey: "k",
      baseUrl: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      timeoutMs: 5000,
    }),
    pricing: PRICING,
    limiters: { message: new RateLimiter(1000, 60_000) },
  });
}

type TestApp = ReturnType<typeof makeApp>;

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function newConversation(app: TestApp, name: string) {
  const site = (await (
    await app.request("/api/v1/admin/sites", post({ name, domains: [`${name.toLowerCase()}.nl`] }, { authorization: `Bearer ${ADMIN}` }))
  ).json()) as { id: string; publicKey: string };
  const conv = (await (await app.request("/api/v1/conversations", post({}, { "x-site-key": site.publicKey }))).json()) as {
    conversationId: string;
    token: string;
  };
  return { site, ...conv };
}

const stream = (app: TestApp, c: { conversationId: string; token: string }, text = "hoi") =>
  app.request(`/api/v1/conversations/${c.conversationId}/messages/stream`, post({ text }, { authorization: `Bearer ${c.token}` }));

const plain = (app: TestApp, c: { conversationId: string; token: string }, text = "hoi") =>
  app.request(`/api/v1/conversations/${c.conversationId}/messages`, post({ text }, { authorization: `Bearer ${c.token}` }));

function parseSse(body: string) {
  return body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { event, data: data ? JSON.parse(data) : null };
    });
}

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("waitFor: time-out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeAll(async () => {
  await migrate(MIGRATOR_URL);
  admin = new pg.Client({ connectionString: MIGRATOR_URL });
  await admin.connect();
  await admin.query("TRUNCATE sites CASCADE");
  db = createPool(APP_URL);
  fake = createServer((req, res) => {
    fakeCalls++;
    req.resume();
    req.on("end", () => handler(req, res));
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
});

afterAll(async () => {
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
  await db?.end();
  await admin?.end();
});

describe("streaming-route", () => {
  it("streamt deltas, slaat het volledige antwoord op en registreert verbruik en kosten", async () => {
    handler = (_q, res) => happyStream(res);
    const app = makeApp();
    const c = await newConversation(app, "Streamer");

    const res = await stream(app, c, "Wat doen jullie?");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const events = parseSse(await res.text());
    expect(events.filter((e) => e.event === "delta").map((e) => e.data.text).join("")).toBe("Hallo daar");
    const done = events.at(-1)!;
    expect(done.event).toBe("done");

    const msgs = await admin.query("SELECT id, role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id", [c.conversationId]);
    expect(msgs.rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "Wat doen jullie?"],
      ["assistant", "Hallo daar"],
    ]);
    expect(msgs.rows[1].id).toBe(done.data.messageId);

    const u = (await admin.query("SELECT * FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows;
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ provider: "mistral", model: "mistral-small-latest", input_tokens: 20, output_tokens: 5, estimated: false, status: "ok" });
    expect(Number(u[0].cost_eur)).toBeCloseTo(0.03, 6);
  });

  it("markeert verbruik als geschat wanneer de provider geen usage meestuurt", async () => {
    handler = (_q, res) => happyStream(res, false);
    const app = makeApp();
    const c = await newConversation(app, "Geschat");
    await (await stream(app, c)).text();
    const u = (await admin.query("SELECT estimated, output_tokens FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows[0];
    expect(u.estimated).toBe(true);
    expect(u.output_tokens).toBeGreaterThan(0);
  });

  it("vereist een geldig token", async () => {
    handler = (_q, res) => happyStream(res);
    const app = makeApp();
    const c = await newConversation(app, "Auth");
    const res = await app.request(`/api/v1/conversations/${c.conversationId}/messages/stream`, post({ text: "hoi" }));
    expect(res.status).toBe(401);
    expect((await stream(app, { ...c, token: "rommel" })).status).toBe(401);
  });

  it("een providerfout vóór de eerste tekst geeft een error-event; bericht blijft bewaard, fout wordt geregistreerd", async () => {
    handler = (_q, res) => {
      res.statusCode = 429;
      res.end("{}");
    };
    const app = makeApp();
    const c = await newConversation(app, "Fout429");
    const res = await stream(app, c);
    expect(res.status).toBe(200); // de stream is al geopend
    const events = parseSse(await res.text());
    expect(events).toEqual([{ event: "error", data: { error: "provider_unavailable" } }]);

    const msgs = await admin.query("SELECT role FROM messages WHERE conversation_id = $1", [c.conversationId]);
    expect(msgs.rows).toEqual([{ role: "user" }]);
    const u = (await admin.query("SELECT status, cost_eur FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows;
    expect(u).toEqual([{ status: "error", cost_eur: "0.000000" }]);
  });

  it("valt de verbinding halverwege weg: wat al getoond is wordt bewaard en er komt een error-event", async () => {
    handler = (_q, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(delta("Half"));
      setTimeout(() => res.destroy(), 40);
    };
    const app = makeApp();
    const c = await newConversation(app, "Halverwege");
    const events = parseSse(await (await stream(app, c)).text());
    expect(events[0]).toEqual({ event: "delta", data: { text: "Half" } });
    expect(events.at(-1)).toEqual({ event: "error", data: { error: "provider_unavailable" } });

    const a = (await admin.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [c.conversationId])).rows;
    expect(a).toEqual([{ content: "Half" }]);
    const u = (await admin.query("SELECT status, estimated FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows;
    expect(u).toEqual([{ status: "ok", estimated: true }]);
  });

  it("de client breekt af: de aanvraag naar de provider stopt en het deel dat al getoond is wordt bewaard", async () => {
    let providerSocketClosed = false;
    handler = (_q, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(delta("Begin"));
      res.on("close", () => (providerSocketClosed = true));
      // verbinding blijft open
    };
    const app = makeApp();
    const c = await newConversation(app, "Afbreker");
    const res = await stream(app, c);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("Begin");
    await reader.cancel();

    await waitFor(async () => providerSocketClosed);
    const a = await waitFor(async () => {
      const r = await admin.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'assistant'", [c.conversationId]);
      return r.rows[0];
    });
    expect(a.content).toBe("Begin");
    const u = await waitFor(async () => (await admin.query("SELECT 1 FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows[0]);
    expect(u).toBeTruthy();
  });
});

describe("dagbudget", () => {
  it("weigert nieuwe beurten zodra het dagbudget is bereikt, op beide routes, zonder iets op te slaan", async () => {
    handler = (_q, res) => happyStream(res); // 0,03 euro per beurt
    const app = makeApp();
    const c = await newConversation(app, "Budget");
    await admin.query("UPDATE site_settings SET daily_budget_eur = 0.05 WHERE site_id = $1", [c.site.id]);

    expect((await (await stream(app, c, "een")).text()).includes("event: done")).toBe(true); // totaal 0,03
    expect((await (await stream(app, c, "twee")).text()).includes("event: done")).toBe(true); // totaal 0,06 >= 0,05

    const callsBefore = fakeCalls;
    const blockedStream = await stream(app, c, "drie");
    expect(blockedStream.status).toBe(503);
    expect(await blockedStream.json()).toEqual({ error: "budget_exceeded" });
    const blockedPlain = await plain(app, c, "vier");
    expect(blockedPlain.status).toBe(503);

    expect(fakeCalls).toBe(callsBefore); // provider niet aangeroepen
    const users = await admin.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user' ORDER BY created_at", [c.conversationId]);
    expect(users.rows.map((r) => r.content)).toEqual(["een", "twee"]); // geblokkeerde berichten niet opgeslagen
  });

  it("het budget geldt per site", async () => {
    handler = (_q, res) => happyStream(res);
    const app = makeApp();
    const a = await newConversation(app, "BudgetA");
    const b = await newConversation(app, "BudgetB");
    await admin.query("UPDATE site_settings SET daily_budget_eur = 0.01 WHERE site_id = $1", [a.site.id]);

    await (await stream(app, a)).text();
    expect((await stream(app, a)).status).toBe(503); // A is op
    expect((await (await stream(app, b)).text()).includes("event: done")).toBe(true); // B is onaangetast
  });

  it("verbruik van gisteren telt niet mee", async () => {
    handler = (_q, res) => happyStream(res);
    const app = makeApp();
    const c = await newConversation(app, "Gisteren");
    await admin.query("UPDATE site_settings SET daily_budget_eur = 0.05 WHERE site_id = $1", [c.site.id]);
    await admin.query(
      `INSERT INTO usage_events (site_id, provider, model, cost_eur, status, created_at)
       VALUES ($1, 'mistral', 'm', 99, 'ok', now() - interval '2 days')`,
      [c.site.id],
    );
    expect((await (await stream(app, c)).text()).includes("event: done")).toBe(true);
  });

  it("de niet-streamende route registreert ook verbruik", async () => {
    handler = (_q, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Antwoord" } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    };
    const app = makeApp();
    const c = await newConversation(app, "Plain");
    const res = await plain(app, c);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { reply: string }).reply).toBe("Antwoord");
    const u = (await admin.query("SELECT input_tokens, output_tokens, cost_eur FROM usage_events WHERE conversation_id = $1", [c.conversationId])).rows[0];
    expect(u.input_tokens).toBe(10);
    expect(Number(u.cost_eur)).toBeCloseTo(0.014, 6);
  });
});

describe("usage_events en rechten", () => {
  it("de runtime-rol kan verbruik niet aanpassen of verwijderen (append-only)", async () => {
    handler = (_q, res) => happyStream(res);
    const app = makeApp();
    const c = await newConversation(app, "AppendOnly");
    await (await stream(app, c)).text();
    await expect(db.query("UPDATE usage_events SET cost_eur = 0")).rejects.toThrow(/permission denied/);
    await expect(db.query("DELETE FROM usage_events")).rejects.toThrow(/permission denied/);
  });
});
