import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createApp } from "../src/app.js";
import { createPool, withTenant, type Db } from "../src/db/tenant.js";
import { RateLimiter } from "../src/ratelimit.js";
import { StubProvider, type ProviderRequest, type ProviderResponse } from "../src/provider.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

let admin: pg.Client;
let db: Db;

/** Onthoudt de systeemprompt van de laatste beurt en kan de provider kunstmatig laten wachten. */
class RecordingProvider extends StubProvider {
  lastPrompt = "";
  delayMs = 0;
  replyTokens = 0;

  override async complete(req: ProviderRequest): Promise<ProviderResponse> {
    this.lastPrompt = req.systemPrompt;
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const res = await super.complete(req);
    if (this.replyTokens === 0) return res;
    return {
      text: res.text,
      usage: { inputTokens: this.replyTokens, outputTokens: this.replyTokens, estimated: false },
    };
  }
}
const provider = new RecordingProvider();

interface AppOptions {
  pricing?: { inputEurPerMTok: number; outputEurPerMTok: number };
  maxOutputTokens?: number;
  limiters?: Parameters<typeof createApp>[0]["limiters"];
}

function makeApp(opts: AppOptions = {}) {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminTokens: [{ name: "test", token: ADMIN }],
    provider,
    pricing: opts.pricing ?? { inputEurPerMTok: 0, outputEurPerMTok: 0 },
    maxOutputTokens: opts.maxOutputTokens ?? 800,
    limiters: { ipMessage: new RateLimiter(10_000, 60_000), message: new RateLimiter(10_000, 60_000), ...opts.limiters },
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

interface Site { id: string; publicKey: string; domains: string[] }

async function createSite(app: App, name: string, domains: string[] = [`${name.toLowerCase()}.nl`]): Promise<Site> {
  const res = await req(app, "/api/v1/admin/sites", { body: { name, domains } });
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

function sendMessage(app: App, conversationId: string, token: string, text = "hoi") {
  return app.request(`/api/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: json({ text }),
  });
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

describe("instellingen wijzigen", () => {
  it("vereist de admin-token", async () => {
    const app = makeApp();
    const site = await createSite(app, "Auth");
    expect((await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { greeting: "hoi" }, token: "" })).status).toBe(401);
    expect((await req(app, `/api/v1/admin/sites/${site.id}`, { token: "" })).status).toBe(401);
  });

  it("weigert een lege body en onbekende velden", async () => {
    const app = makeApp();
    const site = await createSite(app, "Validatie");
    expect((await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: {} })).status).toBe(400);
    expect(
      (await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { system_prompt: "sql-injectie" } })).status,
    ).toBe(400);
    expect((await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { publicKey: "pk_x" } })).status).toBe(400);
    expect(
      (await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { primaryColor: "rood" } })).status,
    ).toBe(400);
  });

  it("geeft 404 voor een onbekende site en voor een niet-uuid", async () => {
    const app = makeApp();
    expect(
      (await req(app, "/api/v1/admin/sites/00000000-0000-0000-0000-000000000000", { method: "PATCH", body: { greeting: "x" } }))
        .status,
    ).toBe(404);
    expect((await req(app, "/api/v1/admin/sites/geen-uuid", { method: "PATCH", body: { greeting: "x" } })).status).toBe(404);
    expect((await req(app, "/api/v1/admin/sites/geen-uuid")).status).toBe(404);
  });

  it("zet de prompt en de volgende beurt gebruikt hem, met de sitenaam ingevuld", async () => {
    const app = makeApp();
    const site = await createSite(app, "Prompts");
    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      body: { systemPrompt: "Je bent de assistent van {{siteName}}. Antwoord kort.", greeting: "Hallo!", dailyBudgetEur: 2.5 },
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()) as { settings: { systemPrompt: string; dailyBudgetEur: number } }).toMatchObject({
      settings: { systemPrompt: "Je bent de assistent van {{siteName}}. Antwoord kort.", dailyBudgetEur: 2.5 },
    });

    const c = await startConversation(app, site.publicKey);
    expect((await sendMessage(app, c.conversationId, c.token)).status).toBe(200);
    expect(provider.lastPrompt).toBe("Je bent de assistent van Prompts. Antwoord kort.");
  });

  it("een nieuwe site heeft meteen een bruikbare prompt", async () => {
    const app = makeApp();
    const site = await createSite(app, "Standaard");
    const state = (await (await req(app, `/api/v1/admin/sites/${site.id}`)).json()) as {
      settings: { systemPrompt: string; timezone: string };
    };
    expect(state.settings.systemPrompt).toContain("{{siteName}}");
    expect(state.settings.timezone).toBe("Europe/Amsterdam");
  });

  it("weigert een onbekende tijdzone", async () => {
    const app = makeApp();
    const site = await createSite(app, "Tz");
    expect(
      (await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { timezone: "Mars/Olympus" } })).status,
    ).toBe(400);
    expect(
      (await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { timezone: "Europe/Amsterdam" } })).status,
    ).toBe(200);
  });

  it("vervangt de domeinen in plaats van ze samen te voegen", async () => {
    const app = makeApp();
    const site = await createSite(app, "Domeinen", ["oud.nl", "ook-oud.nl"]);
    const res = await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { domains: ["https://www.nieuw.nl/"] } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { domains: string[] }).domains).toEqual(["nieuw.nl"]);
  });
});

describe("instellingenhistorie", () => {
  it("schrijft een regel per wijziging, met actor en voor/na", async () => {
    const app = makeApp();
    const site = await createSite(app, "Historie");
    const before = (await admin.query("SELECT count(*)::int AS n FROM site_settings_history WHERE site_id = $1", [site.id])).rows[0].n;
    expect(before).toBe(1); // de aanmaak zelf telt ook

    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      body: { greeting: "Goedemiddag", maxMessagesPerConversation: 12 },
    });
    expect(patch.status).toBe(200);

    const rows = await admin.query(
      "SELECT actor_type, actor_id, changed_fields, before, after FROM site_settings_history WHERE site_id = $1 ORDER BY changed_at, id",
      [site.id],
    );
    expect(rows.rowCount).toBe(2);
    const last = rows.rows[1];
    expect(last.actor_type).toBe("admin_token");
    expect(last.actor_id).toBe("test");
    expect(last.changed_fields.sort()).toEqual(["greeting", "max_messages_per_conversation"]);
    expect(last.before.greeting).toBe("Hoi! Waar kan ik je mee helpen?");
    expect(last.after.greeting).toBe("Goedemiddag");
    // updated_at hoort geen wijziging te zijn: dat verandert bij elke PATCH
    expect(last.changed_fields).not.toContain("updated_at");
  });

  it("een PATCH zonder instellingen (alleen naam of domeinen) schrijft geen regel", async () => {
    const app = makeApp();
    const site = await createSite(app, "GeenRuiz");
    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { name: "Andere naam" } });
    expect(patch.status).toBe(200);
    const n = (await admin.query("SELECT count(*)::int AS n FROM site_settings_history WHERE site_id = $1", [site.id])).rows[0].n;
    expect(n).toBe(1);
  });

  it("een wijziging buiten de API om krijgt actor 'unknown'", async () => {
    const app = makeApp();
    const site = await createSite(app, "Handmatig");
    await admin.query("UPDATE site_settings SET greeting = 'Buiten de API' WHERE site_id = $1", [site.id]);
    const row = (
      await admin.query(
        "SELECT actor_type, actor_id, changed_fields, after FROM site_settings_history WHERE site_id = $1 ORDER BY changed_at DESC, id DESC LIMIT 1",
        [site.id],
      )
    ).rows[0];
    expect(row.actor_type).toBe("unknown");
    expect(row.actor_id).toBe("unknown");
    expect(row.changed_fields).toEqual(["greeting"]);
    expect(row.after.greeting).toBe("Buiten de API");
  });

  it("de runtime-rol kan de historie niet wijzigen of verwijderen", async () => {
    const app = makeApp();
    const site = await createSite(app, "Onveranderlijk");
    await withTenant(db, site.id, (q) => q.query("SELECT 1"));
    await expect(withTenant(db, site.id, (q) => q.query("DELETE FROM site_settings_history"))).rejects.toThrow();
    await expect(withTenant(db, site.id, (q) => q.query("UPDATE site_settings_history SET actor_id = 'x'"))).rejects.toThrow();
    await expect(
      withTenant(db, site.id, (q) =>
        q.query(
          `INSERT INTO site_settings_history (site_id, actor_type, actor_id, changed_fields, before, after)
           VALUES ($1, 'admin_token', 'vervalst', '{}', '{}', '{}')`,
          [site.id],
        ),
      ),
    ).rejects.toThrow();
  });

  it("terugdraaien schrijft een nieuwe regel in plaats van de oude te herschrijven", async () => {
    const app = makeApp();
    const site = await createSite(app, "Terug");
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { systemPrompt: "Prompt A" } });
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { systemPrompt: "Prompt B" } });

    const history = (await (await req(app, `/api/v1/admin/sites/${site.id}/history`)).json()) as {
      history: { id: string; after: { system_prompt: string } }[];
    };
    const target = history.history.find((h) => h.after.system_prompt === "Prompt A");
    expect(target).toBeDefined();

    const restore = await req(app, `/api/v1/admin/sites/${site.id}/history/${target!.id}/restore`, { method: "POST" });
    expect(restore.status).toBe(200);
    expect(((await restore.json()) as { settings: { systemPrompt: string } }).settings.systemPrompt).toBe("Prompt A");

    const after = (await (await req(app, `/api/v1/admin/sites/${site.id}/history`)).json()) as {
      history: { actor_id: string; before: { system_prompt: string }; after: { system_prompt: string } }[];
    };
    expect(after.history).toHaveLength(4); // aanmaak + A + B + terugdraai
    expect(after.history[0]).toMatchObject({
      actor_id: "test",
      before: { system_prompt: "Prompt B" },
      after: { system_prompt: "Prompt A" },
    });
  });

  it("geeft de historie nieuwste eerst en respecteert de limiet", async () => {
    const app = makeApp();
    const site = await createSite(app, "Volgorde");
    for (const greeting of ["een", "twee", "drie"]) {
      await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { greeting } });
    }
    const res = await req(app, `/api/v1/admin/sites/${site.id}/history?limit=2`);
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as { history: { after: { greeting: string } }[] };
    expect(history).toHaveLength(2);
    expect(history[0]!.after.greeting).toBe("drie");
    expect(history[1]!.after.greeting).toBe("twee");
    expect((await req(app, `/api/v1/admin/sites/${site.id}/history?limit=0`)).status).toBe(400);
  });
});

describe("dagbudget als harde grens", () => {
  const pricing = { inputEurPerMTok: 1000, outputEurPerMTok: 2000 };

  it("twee gelijktijdige beurten met budget voor één: één antwoord, één 503", async () => {
    const app = makeApp({ pricing, maxOutputTokens: 4 });
    const site = await createSite(app, "Race");
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { systemPrompt: "a", dailyBudgetEur: 0.015 } });
    const c = await startConversation(app, site.publicKey);

    // De provider blijft 150 ms hangen, zodat de reservering van de eerste beurt nog leeft
    // wanneer de tweede zijn budgetcheck doet.
    provider.delayMs = 150;
    try {
      const [a, b] = await Promise.all([
        sendMessage(app, c.conversationId, c.token, "eerste"),
        sendMessage(app, c.conversationId, c.token, "tweede"),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 503]);
    } finally {
      provider.delayMs = 0;
    }

    // De geweigerde beurt heeft niets opgeslagen: alleen het bericht van de geslaagde beurt.
    const { rows } = await admin.query("SELECT content FROM messages WHERE conversation_id = $1 AND role = 'user'", [
      c.conversationId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it("een verse reservering telt mee, een verlopen reservering niet", async () => {
    const app = makeApp();
    const site = await createSite(app, "Verlopen");
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { dailyBudgetEur: 0.01 } });
    const c = await startConversation(app, site.publicKey);

    await admin.query(
      "INSERT INTO usage_reservations (site_id, conversation_id, reserved_eur, created_at) VALUES ($1, $2, 1.00, now() - interval '11 minutes')",
      [site.id, c.conversationId],
    );
    expect((await sendMessage(app, c.conversationId, c.token)).status).toBe(200);

    await admin.query(
      "INSERT INTO usage_reservations (site_id, conversation_id, reserved_eur) VALUES ($1, $2, 1.00)",
      [site.id, c.conversationId],
    );
    expect((await sendMessage(app, c.conversationId, c.token)).status).toBe(503);
  });

  it("ruimt de reservering op na de beurt en laat de kosten in usage_events staan", async () => {
    const app = makeApp({ pricing, maxOutputTokens: 4 });
    const site = await createSite(app, "Afrekenen");
    await req(app, `/api/v1/admin/sites/${site.id}`, { method: "PATCH", body: { systemPrompt: "a", dailyBudgetEur: 1 } });
    const c = await startConversation(app, site.publicKey);

    provider.replyTokens = 10; // 0.03 aan kosten bij deze prijzen
    try {
      expect((await sendMessage(app, c.conversationId, c.token)).status).toBe(200);
    } finally {
      provider.replyTokens = 0;
    }

    const reservations = (await admin.query("SELECT count(*)::int AS n FROM usage_reservations WHERE conversation_id = $1", [
      c.conversationId,
    ])).rows[0].n;
    expect(reservations).toBe(0);

    const usage = (await admin.query("SELECT cost_eur, request_id FROM usage_events WHERE conversation_id = $1", [c.conversationId]))
      .rows[0];
    expect(Number(usage.cost_eur)).toBeCloseTo(0.03, 6);
    expect(usage.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
