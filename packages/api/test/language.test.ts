import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createPool, type Db } from "../src/db/tenant.js";
import { HANDOVER_REPLY_EN } from "../src/handover.js";
import { detectLanguage, languageRule } from "../src/language.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider, type ProviderRequest } from "../src/provider.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;

class CapturingProvider extends StubProvider {
  last?: ProviderRequest;
  override async complete(req: ProviderRequest) {
    this.last = req;
    return super.complete(req);
  }
}

function makeApp(pricing = { inputEurPerMTok: 0, outputEurPerMTok: 0 }) {
  const provider = new CapturingProvider();
  return {
    app: createApp({
      db,
      sessionSecret: SECRET,
      adminTokens: [{ name: "test", token: ADMIN }],
      provider,
      pricing,
      maxOutputTokens: 800,
      limiters: { ipMessage: new RateLimiter(10_000, 60_000), message: new RateLimiter(10_000, 60_000) },
    }),
    provider,
  };
}

type App = ReturnType<typeof createApp>;

const json = (body: unknown) => JSON.stringify(body);

function req(app: App, path: string, init: { method?: string; body?: unknown } = {}) {
  return app.request(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN}` },
    ...(init.body === undefined ? {} : { body: json(init.body) }),
  });
}

async function createSite(app: App, name: string, domain: string): Promise<{ id: string; publicKey: string }> {
  const res = await req(app, "/api/v1/admin/sites", { body: { name, domains: [domain] } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; publicKey: string };
}

async function startConversation(app: App, key: string, origin: string) {
  const res = await app.request("/api/v1/conversations", {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-key": key, origin },
    body: json({ pageUrl: origin }),
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

describe("taal", () => {
  beforeAll(async () => {
    await migrateTestDb();
    admin = new pg.Client({ connectionString: MIGRATOR_URL });
    await admin.connect();
    await admin.query("TRUNCATE sites CASCADE");
    db = await createPool(APP_URL);
  });

  afterAll(async () => {
    await db.end();
    await admin.end();
  });

  it("detectLanguage herkent een Engelse vraag", () => {
    expect(detectLanguage("Can I talk to a human?")).toBe("en");
  });

  it("detectLanguage herkent een Nederlandse vraag", () => {
    expect(detectLanguage("Wat kost zonnepanelen installeren?")).toBe("nl");
  });

  it("detectLanguage kiest de Nederlandse uitwijk voor korte of lege tekst", () => {
    expect(detectLanguage("help")).toBe("nl");
    expect(detectLanguage("")).toBe("nl");
  });

  it("languageRule noemt de uitwijktaal", () => {
    expect(languageRule("en")).toContain("English");
    expect(languageRule("nl")).toContain("Nederlands");
  });

  it("widget-config heeft standaard 'nl' en volgt een PATCH", async () => {
    const { app } = makeApp();
    const domain = "taalconfig.nl";
    const site = await createSite(app, "Taalconfig", domain);
    const configUrl = `/api/v1/widget/config?key=${site.publicKey}`;

    const res1 = await app.request(configUrl, { headers: { origin: `https://${domain}` } });
    expect(res1.status).toBe(200);
    expect(((await res1.json()) as { language: string }).language).toBe("nl");

    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      body: { language: "en" },
    });
    expect(patch.status).toBe(200);

    const res2 = await app.request(configUrl, { headers: { origin: `https://${domain}` } });
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { language: string }).language).toBe("en");
  });

  it("de taalregel zit in de systeemprompt en volgt de instelling", async () => {
    const { app, provider } = makeApp();
    const domain = "taalprompt.nl";
    const site = await createSite(app, "Taalprompt", domain);

    const conv = await startConversation(app, site.publicKey, `https://${domain}`);
    const turn = await say(app, conv.conversationId, conv.token, "Hoe mail je?");
    expect(turn.status).toBe(200);
    expect(provider.last?.systemPrompt).toContain(languageRule("nl"));

    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      body: { language: "en" },
    });
    expect(patch.status).toBe(200);

    const conv2 = await startConversation(app, site.publicKey, `https://${domain}`);
    const turn2 = await say(app, conv2.conversationId, conv2.token, "How much is it?");
    expect(turn2.status).toBe(200);
    expect(provider.last?.systemPrompt).toContain(languageRule("en"));
  });

  it("een Engelse mensvraag krijgt de Engelse overdrachtstekst", async () => {
    const { app } = makeApp();
    const site = await createSite(app, "Taalhandover", "taalhandover.nl");
    const conv = await startConversation(app, site.publicKey, "https://taalhandover.nl");

    const turn = await say(app, conv.conversationId, conv.token, "Can I talk to a human?");
    expect(turn.status).toBe(200);
    const body = (await turn.json()) as { reply: string; handover: boolean };
    expect(body.reply).toBe(HANDOVER_REPLY_EN);
    expect(body.handover).toBe(true);
  });
});
