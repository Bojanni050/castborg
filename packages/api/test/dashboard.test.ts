import { beforeAll, describe, expect, it } from "vitest";
import { createPool, type Db } from "../src/db/tenant.js";
import { createApp } from "../src/app.js";
import { StubProvider } from "../src/provider.js";
import { RateLimiter } from "../src/ratelimit.js";
import { issueSessionToken } from "../src/token.js";
import { issueDashboardToken } from "../src/dashboard-auth.js";
import { ADMIN, APP_URL, MIGRATOR_URL, SECRET, migrateTestDb } from "./support.js";

const PASSWORD = "dashboard-test-password";
const ACTOR = "test-actor";

let db: Db;

beforeAll(async () => {
  await migrateTestDb();
  db = createPool(APP_URL);
  const migrator = createPool(MIGRATOR_URL);
  await migrator.query("TRUNCATE sites CASCADE");
  await migrator.end();
});

interface AppOptions {
  dashboard?: { password: string; actorId: string; ttlSeconds?: number; cookieSecure?: boolean } | undefined;
  loginLimit?: number;
}

function makeApp(opts: AppOptions = {}) {
  return createApp({
    db,
    sessionSecret: SECRET,
    adminTokens: [{ name: "test", token: ADMIN }],
    dashboard:
      opts.dashboard === undefined && "dashboard" in opts
        ? undefined
        : (opts.dashboard ?? { password: PASSWORD, actorId: ACTOR }),
    provider: new StubProvider(),
    pricing: { inputEurPerMTok: 0, outputEurPerMTok: 0 },
    maxOutputTokens: 100,
    limiters: {
      config: new RateLimiter(10_000, 60_000),
      conversationStart: new RateLimiter(10_000, 60_000),
      message: new RateLimiter(10_000, 60_000),
      ipMessage: new RateLimiter(10_000, 60_000),
      dashboardLogin: new RateLimiter(opts.loginLimit ?? 10_000, 60_000),
    },
  });
}

type App = ReturnType<typeof makeApp>;

interface ReqOptions {
  method?: string;
  body?: unknown;
  token?: string | null;
  cookie?: string | null;
}

function req(app: App, path: string, opts: ReqOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  return app.request(path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
}

/** De sessiecookie uit een Set-Cookie-header halen, klaar om terug te sturen. */
function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = header.match(/ai_lead_dashboard=([^;]*)/);
  return match ? `ai_lead_dashboard=${match[1]}` : "";
}

async function login(app: App, password = PASSWORD): Promise<string> {
  const res = await req(app, "/api/v1/dashboard/login", { body: { password } });
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

async function createSite(app: App, name: string, domains: string[] = [`${name.toLowerCase()}.nl`]) {
  const res = await req(app, "/api/v1/admin/sites", { token: ADMIN, body: { name, domains } });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

/** Verse lijst: de tests in dit bestand delen één database. */
async function truncateSites() {
  const migrator = createPool(MIGRATOR_URL);
  await migrator.query("TRUNCATE sites CASCADE");
  await migrator.end();
}

describe("inloggen", () => {
  it("weigert alles als er geen wachtwoord is ingesteld", async () => {
    const app = makeApp({ dashboard: undefined });
    const res = await req(app, "/api/v1/dashboard/login", { body: { password: PASSWORD } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "not_configured", message: expect.any(String) });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("geeft geen cookie bij een fout wachtwoord", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/dashboard/login", { body: { password: "fout-wachtwoord" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("zet een HttpOnly-cookie bij een goed wachtwoord", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/dashboard/login", { body: { password: PASSWORD } });
    expect(res.status).toBe(200);

    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("ai_lead_dashboard=");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Lax");
    expect(header).toContain("Path=/");
    expect(header).not.toContain("Secure");

    const body = (await res.json()) as { actor: { type: string; id: string } };
    expect(body.actor).toEqual({ type: "user", id: ACTOR });
  });

  it("zet Secure als de omgeving dat eist", async () => {
    const app = makeApp({ dashboard: { password: PASSWORD, actorId: ACTOR, cookieSecure: true } });
    const res = await req(app, "/api/v1/dashboard/login", { body: { password: PASSWORD } });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("remt herhaald raden af", async () => {
    const app = makeApp({ loginLimit: 2 });
    const eerste = await req(app, "/api/v1/dashboard/login", { body: { password: "fout" } });
    const tweede = await req(app, "/api/v1/dashboard/login", { body: { password: "fout" } });
    const derde = await req(app, "/api/v1/dashboard/login", { body: { password: "fout" } });
    expect([eerste.status, tweede.status, derde.status]).toEqual([401, 401, 429]);
  });

  it("wist de cookie bij uitloggen", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/dashboard/logout", { method: "POST" });
    expect(res.status).toBe(200);
    const header = res.headers.get("set-cookie") ?? "";
    expect(header).toContain("ai_lead_dashboard=");
    expect(header).toContain("Max-Age=0");
  });
});

describe("de sessie", () => {
  it("geeft de actor terug aan de hand van de cookie", async () => {
    const app = makeApp();
    const cookie = await login(app);

    const zonder = await req(app, "/api/v1/dashboard/me");
    expect(zonder.status).toBe(401);

    const met = await req(app, "/api/v1/dashboard/me", { cookie });
    expect(met.status).toBe(200);
    expect((await met.json()).actor).toEqual({ type: "user", id: ACTOR });
  });

  it("laat de beheerroute werken met een cookie, en schrijft 'user' in de historie", async () => {
    const app = makeApp();
    const cookie = await login(app);
    const site = await createSite(app, "Cookie", ["cookie.nl"]);

    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      cookie,
      body: { greeting: "Hallo vanaf het dashboard" },
    });
    expect(patch.status).toBe(200);

    const history = await req(app, `/api/v1/admin/sites/${site.id}/history`, { cookie });
    const rows = (await history.json()) as { history: { actor_type: string; actor_id: string; changed_fields: string[] }[] };
    const laatste = rows.history[0];
    expect(laatste?.actor_type).toBe("user");
    expect(laatste?.actor_id).toBe(ACTOR);
    expect(laatste?.changed_fields).toEqual(["greeting"]);
  });

  it("houdt de bearer-token naast de cookie werken, met een eigen actor", async () => {
    const app = makeApp();
    const site = await createSite(app, "Token", ["token.nl"]);

    const patch = await req(app, `/api/v1/admin/sites/${site.id}`, {
      method: "PATCH",
      token: ADMIN,
      body: { greeting: "Via de token" },
    });
    expect(patch.status).toBe(200);

    const history = await req(app, `/api/v1/admin/sites/${site.id}/history`, { token: ADMIN });
    const rows = (await history.json()) as { history: { actor_type: string; actor_id: string }[] };
    expect(rows.history[0]?.actor_type).toBe("admin_token");
    expect(rows.history[0]?.actor_id).toBe("test");
  });

  it("accepteert geen widget-token als dashboardcookie", async () => {
    const app = makeApp();
    const site = await createSite(app, "Widget", ["widget.nl"]);
    // Een echte bezoekerstrap: hetzelfde geheim, ander payload-vorm.
    const widgetToken = issueSessionToken(
      { siteId: site.id, conversationId: "11111111-1111-1111-1111-111111111111" },
      SECRET,
    );
    const res = await req(app, "/api/v1/dashboard/me", { cookie: `ai_lead_dashboard=${widgetToken}` });
    expect(res.status).toBe(401);
  });

  it("weigert een verlopen cookie", async () => {
    const app = makeApp();
    const verlopen = issueDashboardToken({ sub: ACTOR }, SECRET, -60);
    const res = await req(app, "/api/v1/dashboard/me", { cookie: `ai_lead_dashboard=${verlopen}` });
    expect(res.status).toBe(401);
  });

  it("weigert een cookie met een andere ondertekening", async () => {
    const app = makeApp();
    const vreemd = issueDashboardToken({ sub: ACTOR }, "y".repeat(40));
    const res = await req(app, "/api/v1/dashboard/me", { cookie: `ai_lead_dashboard=${vreemd}` });
    expect(res.status).toBe(401);
  });
});

describe("het siteoverzicht", () => {
  it("toont alle sites met hun tellingen, wat RLS per tenant onmogelijk maakt", async () => {
    await truncateSites();
    const app = makeApp();
    const cookie = await login(app);
    await createSite(app, "Eerste", ["eerste.nl"]);
    await createSite(app, "Tweede", ["tweede.nl"]);

    const res = await req(app, "/api/v1/dashboard/sites", { cookie });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      sites: { name: string; domains: string[]; publicKey: string; leadCount: number; conversationCount: number }[];
    };
    const namen = body.sites.map((s) => s.name).sort();
    expect(namen).toEqual(["Eerste", "Tweede"]);
    for (const site of body.sites) {
      expect(site.publicKey).toMatch(/^pk_[a-z0-9]{24}$/);
      expect(site.domains.length).toBe(1);
      expect(site.leadCount).toBe(0);
      expect(site.conversationCount).toBe(0);
    }
  });

  it("geeft 401 zonder cookie en zonder token", async () => {
    const app = makeApp();
    const res = await req(app, "/api/v1/dashboard/sites");
    expect(res.status).toBe(401);
  });
});
