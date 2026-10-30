import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { createSiteInput, sendMessageInput, type WidgetConfigResponse } from "@ai-lead/shared";
import { resolveSiteByPublicKey, withTenant, type Db } from "./db/tenant.js";
import { estimateUsage, type AiProvider, type ChatTurn, type ProviderRequest, type Usage } from "./provider.js";
import { RateLimiter } from "./ratelimit.js";
import { issueSessionToken, verifySessionToken, type SessionClaims } from "./token.js";

export interface Pricing {
  /** Euro per miljoen inputtokens / outputtokens. Komt uit de configuratie; hier staan bewust geen vaste prijzen. */
  inputEurPerMTok: number;
  outputEurPerMTok: number;
}

export interface AppDeps {
  /** Pool met de runtime-rol (ailead_app). Nooit de eigenaar/superuser. */
  db: Db;
  sessionSecret: string;
  /** TIJDELIJK tot dashboard-auth in fase 1: statische token voor site-beheer. */
  adminToken: string;
  provider: AiProvider;
  pricing: Pricing;
  limiters?: {
    config?: RateLimiter;
    conversationStart?: RateLimiter;
    message?: RateLimiter;
  };
}

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HISTORY_LIMIT = 20;

function generatePublicKey(): string {
  let s = "pk_";
  for (let i = 0; i < 24; i++) s += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return s;
}

/** "https://WWW.Voorbeeld.nl/pad" -> "voorbeeld.nl" */
export function normalizeDomain(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0] ?? "";
  host = host.replace(/:\d+$/, "");
  return host.replace(/^www\./, "");
}

function originAllowed(origin: string | undefined, domains: string[]): boolean {
  if (!origin) return true; // niet-browser; de configuratie zelf is publiek. Dit is GEEN beveiliging.
  try {
    return domains.includes(normalizeDomain(new URL(origin).host));
  } catch {
    return false;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function clientIp(c: Context): string {
  // Achter een reverse proxy: zorg dat alleen de proxy X-Forwarded-For zet.
  return c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

interface TurnSettings {
  system_prompt: string;
  model: string;
}

type BeginResult =
  | { kind: "ok"; settings: TurnSettings; history: ChatTurn[] }
  | { kind: "not_found" | "limit" | "budget" };

export function createApp(deps: AppDeps): Hono {
  const { db, sessionSecret, adminToken, provider, pricing } = deps;
  const limits = {
    config: deps.limiters?.config ?? new RateLimiter(120, 60_000),
    conversationStart: deps.limiters?.conversationStart ?? new RateLimiter(20, 60_000),
    message: deps.limiters?.message ?? new RateLimiter(30, 60_000),
  };

  const costEur = (u: Usage) => (u.inputTokens * pricing.inputEurPerMTok + u.outputTokens * pricing.outputEurPerMTok) / 1_000_000;

  /**
   * Transactie 1 van een beurt: valideren, budget en limiet controleren, gebruikersbericht opslaan, context ophalen.
   * De AI-aanroep valt hier bewust buiten, zodat er geen databaseverbinding vastzit tijdens de latency van de provider.
   * Het budget wordt gecontroleerd VOORDAT er iets wordt opgeslagen: bij overschrijding blijft er geen half gesprek achter.
   * Let op: gelijktijdige beurten kunnen het budget met hun eigen kosten overschrijden (begrensd door max_tokens).
   */
  async function beginTurn(claims: SessionClaims, text: string): Promise<BeginResult> {
    return withTenant(db, claims.siteId, async (q) => {
      const conv = await q.query("SELECT 1 FROM conversations WHERE id = $1", [claims.conversationId]);
      if (conv.rowCount === 0) return { kind: "not_found" };

      const settings = (
        await q.query<TurnSettings & { max_messages_per_conversation: number; daily_budget_eur: string }>(
          "SELECT system_prompt, model, max_messages_per_conversation, daily_budget_eur FROM site_settings",
        )
      ).rows[0];
      if (!settings) return { kind: "not_found" };

      const spent = (
        await q.query<{ spent: string }>(
          // dag in UTC; per-site tijdzone kan later
          "SELECT COALESCE(sum(cost_eur), 0) AS spent FROM usage_events WHERE created_at >= (date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",
        )
      ).rows[0]!.spent;
      if (Number(spent) >= Number(settings.daily_budget_eur)) return { kind: "budget" };

      const count = (
        await q.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [
          claims.conversationId,
        ])
      ).rows[0]!.n;
      if (count >= settings.max_messages_per_conversation) return { kind: "limit" };

      await q.query("INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [
        claims.siteId,
        claims.conversationId,
        text,
      ]);
      const history = (
        await q.query<ChatTurn>(
          `SELECT role, content FROM (
             SELECT role, content, created_at, id FROM messages
             WHERE conversation_id = $1 AND role IN ('user', 'assistant')
             ORDER BY created_at DESC, id DESC LIMIT $2
           ) t ORDER BY created_at ASC, id ASC`,
          [claims.conversationId, HISTORY_LIMIT],
        )
      ).rows;
      return { kind: "ok", settings: { system_prompt: settings.system_prompt, model: settings.model }, history };
    });
  }

  /** Transactie 2: antwoord (ook gedeeltelijk) opslaan en het verbruik registreren, ook bij een fout. */
  async function finishTurn(
    claims: SessionClaims,
    req: ProviderRequest,
    r: { reply: string; usage: Usage | null; status: "ok" | "error"; durationMs: number },
  ): Promise<string | null> {
    const usage = r.usage ?? (r.reply ? estimateUsage(req, r.reply) : { inputTokens: 0, outputTokens: 0, estimated: false });
    return withTenant(db, claims.siteId, async (q) => {
      let messageId: string | null = null;
      if (r.reply) {
        const { rows } = await q.query<{ id: string }>(
          "INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3) RETURNING id",
          [claims.siteId, claims.conversationId, r.reply],
        );
        messageId = rows[0]!.id;
        await q.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [claims.conversationId]);
      }
      await q.query(
        `INSERT INTO usage_events
           (site_id, conversation_id, provider, model, input_tokens, output_tokens, cost_eur, estimated, status, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          claims.siteId,
          claims.conversationId,
          provider.name,
          req.model,
          usage.inputTokens,
          usage.outputTokens,
          costEur(usage),
          usage.estimated,
          r.status,
          Math.round(r.durationMs),
        ],
      );
      return messageId;
    });
  }

  /** Gedeelde voorwaarden voor beide berichtroutes: token, rate limit, invoer. */
  async function parseTurnRequest(c: Context): Promise<{ claims: SessionClaims; text: string } | Response> {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claims = verifySessionToken(bearer, sessionSecret);
    if (!claims || claims.conversationId !== c.req.param("id")) return c.json({ error: "unauthorized" }, 401);
    if (!limits.message.check(`conv:${claims.conversationId}`)) return c.json({ error: "rate_limited" }, 429);

    const parsed = sendMessageInput.pick({ text: true }).safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
    return { claims, text: parsed.data.text };
  }

  const beginFailure = (c: Context, kind: "not_found" | "limit" | "budget") =>
    kind === "not_found"
      ? c.json({ error: "not_found" }, 404)
      : kind === "limit"
        ? c.json({ error: "conversation_limit" }, 429)
        : c.json({ error: "budget_exceeded" }, 503);

  const app = new Hono();

  // CORS voor widgetroutes. Er worden geen cookies gebruikt; autorisatie loopt via sleutel of bearer-token.
  app.use("/api/v1/widget/*", corsMiddleware);
  app.use("/api/v1/conversations/*", corsMiddleware);
  app.use("/api/v1/conversations", corsMiddleware);

  app.get("/api/v1/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Beheer (tijdelijk): site aanmaken
  // ---------------------------------------------------------------------------
  app.post("/api/v1/admin/sites", async (c) => {
    const auth = c.req.header("authorization") ?? "";
    if (!adminToken || !safeEqual(auth, `Bearer ${adminToken}`)) return c.json({ error: "unauthorized" }, 401);

    const parsed = createSiteInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const domains = [...new Set(parsed.data.domains.map(normalizeDomain))].filter(Boolean);
    if (domains.length === 0) return c.json({ error: "invalid_input" }, 400);

    const id = randomUUID();
    const publicKey = generatePublicKey();
    await withTenant(db, id, async (q) => {
      await q.query("INSERT INTO sites (id, name, public_key) VALUES ($1, $2, $3)", [id, parsed.data.name, publicKey]);
      await q.query("INSERT INTO site_settings (site_id) VALUES ($1)", [id]);
      for (const d of domains) await q.query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [id, d]);
    });
    return c.json({ id, publicKey, name: parsed.data.name, domains }, 201);
  });

  // ---------------------------------------------------------------------------
  // Publiek: widgetconfiguratie
  // ---------------------------------------------------------------------------
  app.get("/api/v1/widget/config", async (c) => {
    const key = c.req.query("key") ?? "";
    if (!limits.config.check(`${clientIp(c)}:${key}`)) return c.json({ error: "rate_limited" }, 429);

    const site = await loadSiteContext(db, key);
    if (!site) return c.json({ error: "not_found" }, 404);
    if (!originAllowed(c.req.header("origin"), site.domains)) return c.json({ error: "origin_not_allowed" }, 403);

    const body: WidgetConfigResponse = {
      siteKey: key as WidgetConfigResponse["siteKey"],
      greeting: site.settings.greeting,
      openingQuestion: site.settings.opening_question,
      position: site.settings.widget_position,
      primaryColor: site.settings.primary_color,
    };
    return c.json(body);
  });

  // ---------------------------------------------------------------------------
  // Publiek: gesprek starten -> sessietoken
  // ---------------------------------------------------------------------------
  app.post("/api/v1/conversations", async (c) => {
    const key = c.req.header("x-site-key") ?? "";
    if (!limits.conversationStart.check(`${clientIp(c)}:${key}`)) return c.json({ error: "rate_limited" }, 429);

    const site = await loadSiteContext(db, key);
    if (!site) return c.json({ error: "not_found" }, 404);
    if (!originAllowed(c.req.header("origin"), site.domains)) return c.json({ error: "origin_not_allowed" }, 403);

    const body = (await readJson(c)) as { pageUrl?: unknown } | undefined;
    const pageUrl = typeof body?.pageUrl === "string" ? body.pageUrl.slice(0, 2048) : null;

    const conversationId = await withTenant(db, site.id, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        "INSERT INTO conversations (site_id, page_url) VALUES ($1, $2) RETURNING id",
        [site.id, pageUrl],
      );
      return rows[0]!.id;
    });
    const token = issueSessionToken({ siteId: site.id, conversationId }, sessionSecret);
    return c.json({ conversationId, token }, 201);
  });

  // ---------------------------------------------------------------------------
  // Publiek (token): bericht sturen, in één keer
  // ---------------------------------------------------------------------------
  app.post("/api/v1/conversations/:id/messages", async (c) => {
    const pre = await parseTurnRequest(c);
    if (pre instanceof Response) return pre;
    const { claims, text } = pre;

    const turn = await beginTurn(claims, text);
    if (turn.kind !== "ok") return beginFailure(c, turn.kind);

    const req: ProviderRequest = { systemPrompt: turn.settings.system_prompt, model: turn.settings.model, history: turn.history };
    const t0 = performance.now();
    let result;
    try {
      result = await provider.complete(req, { signal: c.req.raw.signal });
    } catch {
      // Het gebruikersbericht is al opgeslagen; de widget kan het opnieuw proberen of een melding tonen.
      await finishTurn(claims, req, { reply: "", usage: null, status: "error", durationMs: performance.now() - t0 });
      return c.json({ error: "provider_unavailable" }, 502);
    }
    const messageId = await finishTurn(claims, req, {
      reply: result.text,
      usage: result.usage,
      status: "ok",
      durationMs: performance.now() - t0,
    });
    return c.json({ messageId, reply: result.text });
  });

  // ---------------------------------------------------------------------------
  // Publiek (token): bericht sturen met streaming (SSE)
  // Events: `delta` {text} ... daarna `done` {messageId} of `error` {error}
  // ---------------------------------------------------------------------------
  app.post("/api/v1/conversations/:id/messages/stream", async (c) => {
    const pre = await parseTurnRequest(c);
    if (pre instanceof Response) return pre;
    const { claims, text } = pre;

    const turn = await beginTurn(claims, text);
    if (turn.kind !== "ok") return beginFailure(c, turn.kind);

    const req: ProviderRequest = { systemPrompt: turn.settings.system_prompt, model: turn.settings.model, history: turn.history };

    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      const t0 = performance.now();
      let reply = "";
      let usage: Usage | null = null;
      let failed = false;

      try {
        for await (const ev of provider.stream(req, { signal: ctrl.signal })) {
          if (ev.type === "delta") {
            reply += ev.text;
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.text }) });
          } else {
            usage = ev.usage;
          }
        }
      } catch {
        failed = true;
      }

      // Ook bij een weggevallen client of fout: wat al getoond is wordt bewaard en het verbruik wordt geregistreerd.
      let messageId: string | null = null;
      try {
        messageId = await finishTurn(claims, req, {
          reply,
          usage,
          status: failed && !reply ? "error" : "ok",
          durationMs: performance.now() - t0,
        });
      } catch {
        failed = true;
      }

      if (ctrl.signal.aborted) return;
      try {
        if (failed) await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "provider_unavailable" }) });
        else await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId }) });
      } catch {
        /* client is weg */
      }
    });
  });

  return app;
}

// -----------------------------------------------------------------------------

interface SiteContext {
  id: string;
  domains: string[];
  settings: {
    greeting: string;
    opening_question: string | null;
    widget_position: "bottom-right" | "bottom-left";
    primary_color: string;
  };
}

async function loadSiteContext(db: Db, publicKey: string): Promise<SiteContext | null> {
  if (!/^pk_[a-z0-9]{24}$/.test(publicKey)) return null;
  const id = await resolveSiteByPublicKey(db, publicKey);
  if (!id) return null;
  return withTenant(db, id, async (q) => {
    const domains = (await q.query<{ domain: string }>("SELECT domain FROM site_domains")).rows.map((r) => r.domain);
    const settings = (
      await q.query<SiteContext["settings"]>(
        "SELECT greeting, opening_question, widget_position, primary_color FROM site_settings",
      )
    ).rows[0];
    return settings ? { id, domains, settings } : null;
  });
}

async function corsMiddleware(c: Context, next: () => Promise<void>) {
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Site-Key");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Max-Age", "600");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
}
