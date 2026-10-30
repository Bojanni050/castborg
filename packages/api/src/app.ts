import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  createSiteInput,
  sendMessageInput,
  siteSettingsHistoryQuery,
  updateSiteSettingsInput,
  type WidgetConfigResponse,
} from "@ai-lead/shared";
import { resolveSiteByPublicKey, withTenant, type Actor, type Db } from "./db/tenant.js";
import { logProviderError } from "./log.js";
import { estimateInputTokens, estimateUsage, type AiProvider, type ChatTurn, type ProviderRequest, type Usage } from "./provider.js";
import { RateLimiter } from "./ratelimit.js";
import { issueSessionToken, verifySessionToken, type SessionClaims } from "./token.js";

export interface Pricing {
  /** Euro per miljoen inputtokens / outputtokens. Komt uit de configuratie; hier staan bewust geen vaste prijzen. */
  inputEurPerMTok: number;
  outputEurPerMTok: number;
}

export interface AdminToken {
  /** Naam van de token; dit is de actor in de historie. Later wordt dit een user_id. */
  name: string;
  token: string;
}

export interface AppDeps {
  /** Pool met de runtime-rol (ailead_app). Nooit de eigenaar/superuser. */
  db: Db;
  sessionSecret: string;
  /** TIJDELIJK tot dashboard-auth in fase 1: statische tokens voor site-beheer. */
  adminTokens: AdminToken[];
  provider: AiProvider;
  pricing: Pricing;
  /** Bovengrens per antwoord; dezelfde waarde als de provider gebruikt, anders rekent het budget scheef. */
  maxOutputTokens: number;
  limiters?: {
    config?: RateLimiter;
    conversationStart?: RateLimiter;
    message?: RateLimiter;
    ipMessage?: RateLimiter;
  };
}

const KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HISTORY_LIMIT = 20;
/** Een reservering van een gecrashte beurt mag het budget niet voor altijd bezet houden. */
const RESERVATION_TTL_MINUTES = 10;

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
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  // Zonder proxy is de socket het enige betrouwbare adres. Zonder deze terugval belandt elke
  // client in dezelfde bucket en sluit één bezoeker de rest buiten.
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

type TurnStatus = "ok" | "error" | "aborted";

interface TurnSettings {
  system_prompt: string;
  model: string;
  site_name: string;
  max_messages_per_conversation: number;
  daily_budget_eur: string;
  timezone: string;
}

type BeginResult =
  | { kind: "ok"; systemPrompt: string; model: string; history: ChatTurn[]; reservationId: string }
  | { kind: "not_found" | "limit" | "budget" };

interface FinishArgs {
  claims: SessionClaims;
  req: ProviderRequest;
  requestId: string;
  reservationId: string;
  reply: string;
  usage: Usage | null;
  status: TurnStatus;
  durationMs: number;
}

/** Kolomnamen voor de beheervelden. Nooit uit de request halen: alleen deze map bepaalt de SQL. */
const SETTINGS_COLUMNS = {
  systemPrompt: "system_prompt",
  greeting: "greeting",
  openingQuestion: "opening_question",
  widgetPosition: "widget_position",
  primaryColor: "primary_color",
  model: "model",
  dailyBudgetEur: "daily_budget_eur",
  maxMessagesPerConversation: "max_messages_per_conversation",
  timezone: "timezone",
} as const;

export function createApp(deps: AppDeps): Hono {
  const { db, sessionSecret, adminTokens, provider, pricing, maxOutputTokens } = deps;
  const limits = {
    config: deps.limiters?.config ?? new RateLimiter(120, 60_000),
    conversationStart: deps.limiters?.conversationStart ?? new RateLimiter(20, 60_000),
    message: deps.limiters?.message ?? new RateLimiter(30, 60_000),
    ipMessage: deps.limiters?.ipMessage ?? new RateLimiter(120, 60_000),
  };

  const costEur = (u: Usage) => (u.inputTokens * pricing.inputEurPerMTok + u.outputTokens * pricing.outputEurPerMTok) / 1_000_000;

  /**
   * Transactie 1 van een beurt: valideren, budget en limiet controleren, gebruikersbericht opslaan, context ophalen.
   * De AI-aanroep valt hier bewust buiten, zodat er geen databaseverbinding vastzit tijdens de latency van de provider.
   *
   * Het budget is een harde grens: vóór de call wordt het maximale bedrag van deze beurt gereserveerd
   * (inputschatting + maxOutputTokens). Gelijktijdige beurten zien elkaars reservering, dus samen kunnen
   * ze het dagbudget niet overschrijden. Transactie 2 ruimt de reservering weer op.
   */
  async function beginTurn(claims: SessionClaims, text: string): Promise<BeginResult> {
    return withTenant(db, claims.siteId, async (q) => {
      const conv = await q.query("SELECT 1 FROM conversations WHERE id = $1", [claims.conversationId]);
      if (conv.rowCount === 0) return { kind: "not_found" };

      const settings = (
        await q.query<TurnSettings>(
          `SELECT st.system_prompt, st.model, st.max_messages_per_conversation, st.daily_budget_eur,
                  st.timezone, si.name AS site_name
             FROM site_settings st
             JOIN sites si ON si.id = st.site_id`,
        )
      ).rows[0];
      if (!settings) return { kind: "not_found" };

      const count = (
        await q.query<{ n: number }>("SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1", [
          claims.conversationId,
        ])
      ).rows[0]!.n;
      if (count >= settings.max_messages_per_conversation) return { kind: "limit" };

      const existing = (
        await q.query<ChatTurn>(
          `SELECT role, content FROM (
             SELECT role, content, created_at, id FROM messages
             WHERE conversation_id = $1 AND role IN ('user', 'assistant')
             ORDER BY created_at DESC, id DESC LIMIT $2
           ) t ORDER BY created_at ASC, id ASC`,
          [claims.conversationId, HISTORY_LIMIT - 1],
        )
      ).rows;

      const systemPrompt = settings.system_prompt.replaceAll("{{siteName}}", settings.site_name);
      const inputText = [systemPrompt, ...existing.map((t) => t.content), text].join("\n");
      const reservedEur =
        (estimateInputTokens(inputText) * pricing.inputEurPerMTok + maxOutputTokens * pricing.outputEurPerMTok) / 1_000_000;

      // Serialiseer per site zodat twee gelijktijdige beurten elkaars reservering zien.
      // xact-scoped: de lock valt weg bij COMMIT, dus niet tijdens de provider-latency.
      await q.query("SELECT pg_advisory_xact_lock(hashtextextended('budget:' || $1::text, 0))", [claims.siteId]);

      const committed = (
        await q.query<{ committed: string }>(
          `WITH d AS (SELECT (date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS day_start)
           SELECT COALESCE((SELECT sum(cost_eur) FROM usage_events WHERE created_at >= (SELECT day_start FROM d)), 0)
                + COALESCE((SELECT sum(reserved_eur) FROM usage_reservations
                             WHERE created_at >= now() - make_interval(mins => $2)), 0) AS committed`,
          [settings.timezone, RESERVATION_TTL_MINUTES],
        )
      ).rows[0]!.committed;

      if (Number(committed) + reservedEur >= Number(settings.daily_budget_eur)) return { kind: "budget" };

      await q.query("INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [
        claims.siteId,
        claims.conversationId,
        text,
      ]);

      const reservationId = (
        await q.query<{ id: string }>(
          "INSERT INTO usage_reservations (site_id, conversation_id, reserved_eur) VALUES ($1, $2, $3) RETURNING id",
          [claims.siteId, claims.conversationId, reservedEur],
        )
      ).rows[0]!.id;

      return {
        kind: "ok",
        systemPrompt,
        model: settings.model,
        history: [...existing, { role: "user" as const, content: text }],
        reservationId,
      };
    });
  }

  /** Transactie 2: antwoord (ook gedeeltelijk) opslaan, verbruik registreren en de reservering vrijgeven. */
  async function finishTurn(a: FinishArgs): Promise<string | null> {
    const usage = a.usage ?? (a.reply ? estimateUsage(a.req, a.reply) : { inputTokens: 0, outputTokens: 0, estimated: false });
    return withTenant(db, a.claims.siteId, async (q) => {
      let messageId: string | null = null;
      if (a.reply) {
        const { rows } = await q.query<{ id: string }>(
          "INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1, $2, 'assistant', $3) RETURNING id",
          [a.claims.siteId, a.claims.conversationId, a.reply],
        );
        messageId = rows[0]!.id;
        await q.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [a.claims.conversationId]);
      }
      await q.query(
        `INSERT INTO usage_events
           (site_id, conversation_id, provider, model, input_tokens, output_tokens, cost_eur, estimated, status, duration_ms, request_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          a.claims.siteId,
          a.claims.conversationId,
          provider.name,
          a.req.model,
          usage.inputTokens,
          usage.outputTokens,
          costEur(usage),
          usage.estimated,
          a.status,
          Math.round(a.durationMs),
          a.requestId,
        ],
      );
      await q.query("DELETE FROM usage_reservations WHERE id = $1", [a.reservationId]);
      return messageId;
    });
  }

  /** Gedeelde voorwaarden voor beide berichtroutes: token, rate limit, invoer. */
  async function parseTurnRequest(c: Context): Promise<{ claims: SessionClaims; text: string } | Response> {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claims = verifySessionToken(bearer, sessionSecret);
    if (!claims || claims.conversationId !== c.req.param("id")) return c.json({ error: "unauthorized" }, 401);

    // Per IP én per gesprek: de gesprekslimiet alleen laat 20 gesprekken x 30 berichten per minuut toe.
    if (!limits.ipMessage.check(`ip:${clientIp(c)}`)) return c.json({ error: "rate_limited" }, 429);
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

  /** Beheerder authenticeren. Meerdere tokens met een naam geven meteen een bruikbare actor. */
  function authenticateAdmin(c: Context): Actor | null {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!bearer) return null;
    let found: Actor | null = null;
    // Alle tokens vergelijken (geen vroege exit) zodat de duur niets verraadt.
    for (const t of adminTokens) {
      if (safeEqual(bearer, t.token)) found = { type: "admin_token", id: t.name };
    }
    return found;
  }

  const app = new Hono();

  // CORS voor widgetroutes. Er worden geen cookies gebruikt; autorisatie loopt via sleutel of bearer-token.
  app.use("/api/v1/widget/*", corsMiddleware);
  app.use("/api/v1/conversations/*", corsMiddleware);
  app.use("/api/v1/conversations", corsMiddleware);

  app.get("/api/v1/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Beheer (tijdelijk): sites aanmaken en instellen
  // ---------------------------------------------------------------------------
  app.post("/api/v1/admin/sites", async (c) => {
    const actor = authenticateAdmin(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const parsed = createSiteInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const input = parsed.data;
    const domains = [...new Set(input.domains.map(normalizeDomain))].filter(Boolean);
    if (domains.length === 0) return c.json({ error: "invalid_input" }, 400);
    if (input.timezone && !(await isKnownTimezone(db, input.timezone))) return c.json({ error: "invalid_timezone" }, 400);

    const id = randomUUID();
    const publicKey = generatePublicKey();
    await withTenant(
      db,
      id,
      async (q) => {
        await q.query("INSERT INTO sites (id, name, public_key) VALUES ($1, $2, $3)", [id, input.name, publicKey]);
        const columns = ["site_id"];
        const values: unknown[] = [id];
        for (const [key, column] of Object.entries(SETTINGS_COLUMNS)) {
          const value = (input as Record<string, unknown>)[key];
          if (value === undefined) continue;
          values.push(value);
          columns.push(column);
        }
        const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
        await q.query(`INSERT INTO site_settings (${columns.join(", ")}) VALUES (${placeholders})`, values);
        for (const d of domains) await q.query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [id, d]);
      },
      actor,
    );
    return c.json({ id, publicKey, name: input.name, domains }, 201);
  });

  app.get("/api/v1/admin/sites/:id", async (c) => {
    if (!authenticateAdmin(c)) return c.json({ error: "unauthorized" }, 401);

    const state = await readSiteState(db, c.req.param("id"));
    if (!state) return c.json({ error: "not_found" }, 404);
    return c.json(state);
  });

  app.patch("/api/v1/admin/sites/:id", async (c) => {
    const actor = authenticateAdmin(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const parsed = updateSiteSettingsInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    return respondToUpdate(c, await applySiteUpdate(db, c.req.param("id"), parsed.data, actor));
  });

  app.get("/api/v1/admin/sites/:id/history", async (c) => {
    if (!authenticateAdmin(c)) return c.json({ error: "unauthorized" }, 401);

    const parsed = siteSettingsHistoryQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const rows = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      return (
        await q.query(
          `SELECT id, changed_at, actor_type, actor_id, changed_fields, before, after
             FROM site_settings_history ORDER BY changed_at DESC, id DESC LIMIT $1`,
          [parsed.data.limit],
        )
      ).rows;
    });
    if (!rows) return c.json({ error: "not_found" }, 404);
    return c.json({ history: rows });
  });

  app.post("/api/v1/admin/sites/:id/history/:historyId/restore", async (c) => {
    const actor = authenticateAdmin(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const historyId = c.req.param("historyId");
    if (!isUuid(siteId) || !isUuid(historyId)) return c.json({ error: "not_found" }, 404);

    const snapshot = await withTenant(db, siteId, async (q) => {
      const row = (
        await q.query<{ after: Record<string, unknown> }>("SELECT after FROM site_settings_history WHERE id = $1", [
          historyId,
        ])
      ).rows[0];
      return row?.after ?? null;
    });
    if (!snapshot) return c.json({ error: "not_found" }, 404);

    // Terugdraaien is een gewone PATCH: er komt een nieuwe historieregel bij in plaats van dat de
    // oude wordt herschreven. Zo blijft de geschiedenis zelf ook geschiedenis.
    const parsed = updateSiteSettingsInput.safeParse(snapshotToInput(snapshot));
    if (!parsed.success) return c.json({ error: "invalid_history" }, 500);

    return respondToUpdate(c, await applySiteUpdate(db, siteId, parsed.data, actor));
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
    const requestId = randomUUID();
    c.header("x-request-id", requestId);

    const turn = await beginTurn(claims, text);
    if (turn.kind !== "ok") return beginFailure(c, turn.kind);

    const req: ProviderRequest = { systemPrompt: turn.systemPrompt, model: turn.model, history: turn.history };
    const t0 = performance.now();
    const logCtx = {
      siteId: claims.siteId,
      conversationId: claims.conversationId,
      provider: provider.name,
      model: turn.model,
      requestId,
    };

    let result;
    try {
      result = await provider.complete(req, { signal: c.req.raw.signal });
    } catch (err) {
      // Het gebruikersbericht is al opgeslagen; de widget kan het opnieuw proberen of een melding tonen.
      logProviderError(err, { ...logCtx, durationMs: Math.round(performance.now() - t0) });
      await finishTurn({
        claims,
        req,
        requestId,
        reservationId: turn.reservationId,
        reply: "",
        usage: null,
        status: "error",
        durationMs: performance.now() - t0,
      });
      return c.json({ error: "provider_unavailable", requestId }, 502);
    }
    const messageId = await finishTurn({
      claims,
      req,
      requestId,
      reservationId: turn.reservationId,
      reply: result.text,
      usage: result.usage,
      status: "ok",
      durationMs: performance.now() - t0,
    });
    return c.json({ messageId, reply: result.text, requestId });
  });

  // ---------------------------------------------------------------------------
  // Publiek (token): bericht sturen met streaming (SSE)
  // Events: `delta` {text} ... daarna `done` {messageId} of `error` {error}
  // ---------------------------------------------------------------------------
  app.post("/api/v1/conversations/:id/messages/stream", async (c) => {
    const pre = await parseTurnRequest(c);
    if (pre instanceof Response) return pre;
    const { claims, text } = pre;
    const requestId = randomUUID();

    const turn = await beginTurn(claims, text);
    if (turn.kind !== "ok") return beginFailure(c, turn.kind);

    const req: ProviderRequest = { systemPrompt: turn.systemPrompt, model: turn.model, history: turn.history };
    const logCtx = {
      siteId: claims.siteId,
      conversationId: claims.conversationId,
      provider: provider.name,
      model: turn.model,
      requestId,
    };

    return streamSSE(c, async (stream) => {
      const ctrl = new AbortController();
      stream.onAbort(() => ctrl.abort());
      const t0 = performance.now();
      let reply = "";
      let usage: Usage | null = null;
      let status: TurnStatus = "ok";

      try {
        for await (const ev of provider.stream(req, { signal: ctrl.signal })) {
          if (ev.type === "delta") {
            reply += ev.text;
            await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: ev.text }) });
          } else {
            usage = ev.usage;
          }
        }
      } catch (err) {
        status = "error";
        logProviderError(err, { ...logCtx, durationMs: Math.round(performance.now() - t0) });
      }

      // Weggevallen client: geen providerfout maar een afgebroken beurt. Wat al getoond is wordt
      // bewaard en het verbruik wordt geregistreerd.
      if (ctrl.signal.aborted) status = "aborted";

      let messageId: string | null = null;
      try {
        messageId = await finishTurn({
          claims,
          req,
          requestId,
          reservationId: turn.reservationId,
          reply,
          usage,
          status,
          durationMs: performance.now() - t0,
        });
      } catch (err) {
        status = "error";
        logProviderError(err, { ...logCtx, event: "finish_turn_failed" });
      }

      if (ctrl.signal.aborted) return;
      try {
        if (status === "error") {
          await stream.writeSSE({ event: "error", data: JSON.stringify({ error: "provider_unavailable", requestId }) });
        } else {
          await stream.writeSSE({ event: "done", data: JSON.stringify({ messageId, requestId }) });
        }
      } catch {
        /* client is weg */
      }
    });
  });

  return app;
}

// -----------------------------------------------------------------------------

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Zet een historie-snapshot (kolomnamen) om naar de vorm van de API (camelCase). */
function snapshotToInput(after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(SETTINGS_COLUMNS)) {
    if (column in after) out[key] = after[column];
  }
  return out;
}

async function isKnownTimezone(db: Db, timezone: string): Promise<boolean> {
  const { rowCount } = await db.query("SELECT 1 FROM pg_timezone_names WHERE name = $1", [timezone]);
  return (rowCount ?? 0) > 0;
}

type UpdateOutcome = "not_found" | "invalid_domain" | "invalid_timezone" | SiteState;

function respondToUpdate(c: Context, result: UpdateOutcome) {
  if (result === "not_found") return c.json({ error: "not_found" }, 404);
  if (result === "invalid_domain") return c.json({ error: "invalid_input" }, 400);
  if (result === "invalid_timezone") return c.json({ error: "invalid_timezone" }, 400);
  return c.json(result);
}

/**
 * Past een beheerwijziging toe en geeft de nieuwe toestand terug.
 *
 * De historie wordt niet hier geschreven maar door de trigger op site_settings, zodat ook een
 * handmatige UPDATE buiten de API om een spoor achterlaat. De actor komt uit de transactie-instelling
 * die withTenant zet.
 */
async function applySiteUpdate(db: Db, siteId: string, input: Record<string, unknown>, actor: Actor): Promise<UpdateOutcome> {
  if (!isUuid(siteId)) return "not_found";
  return withTenant(
    db,
    siteId,
    async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return "not_found";

      // Eerst alles wat een fout kan geven, daarna pas schrijven.
      if (typeof input.timezone === "string") {
        const known = await q.query("SELECT 1 FROM pg_timezone_names WHERE name = $1", [input.timezone]);
        if (known.rowCount === 0) return "invalid_timezone";
      }
      const domains =
        input.domains === undefined ? null : [...new Set((input.domains as string[]).map(normalizeDomain))].filter(Boolean);
      if (domains && domains.length === 0) return "invalid_domain";

      if (typeof input.name === "string") {
        await q.query("UPDATE sites SET name = $1 WHERE id = $2", [input.name, siteId]);
      }

      if (domains) {
        await q.query("DELETE FROM site_domains WHERE site_id = $1", [siteId]);
        for (const d of domains) await q.query("INSERT INTO site_domains (site_id, domain) VALUES ($1, $2)", [siteId, d]);
      }

      const sets: string[] = ["updated_at = now()"];
      const values: unknown[] = [];
      for (const [key, column] of Object.entries(SETTINGS_COLUMNS)) {
        const value = input[key];
        if (value === undefined) continue;
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length > 1) {
        values.push(siteId);
        await q.query(`UPDATE site_settings SET ${sets.join(", ")} WHERE site_id = $${values.length}`, values);
      }

      return readSiteStateWith(q, siteId);
    },
    actor,
  );
}

interface SiteState {
  id: string;
  name: string;
  publicKey: string;
  domains: string[];
  settings: {
    systemPrompt: string;
    greeting: string;
    openingQuestion: string | null;
    widgetPosition: string;
    primaryColor: string;
    model: string;
    provider: string;
    dailyBudgetEur: number;
    maxMessagesPerConversation: number;
    timezone: string;
    updatedAt: string;
  };
}

async function readSiteStateWith(q: PoolClient, siteId: string): Promise<SiteState> {
  const site = (
    await q.query<{ name: string; public_key: string }>("SELECT name, public_key FROM sites WHERE id = $1", [siteId])
  ).rows[0]!;
  const s = (
    await q.query<{
      system_prompt: string;
      greeting: string;
      opening_question: string | null;
      widget_position: string;
      primary_color: string;
      model: string;
      provider: string;
      daily_budget_eur: string;
      max_messages_per_conversation: number;
      timezone: string;
      updated_at: Date;
    }>(
      `SELECT system_prompt, greeting, opening_question, widget_position, primary_color, model, provider,
              daily_budget_eur, max_messages_per_conversation, timezone, updated_at
         FROM site_settings WHERE site_id = $1`,
      [siteId],
    )
  ).rows[0]!;
  const domains = (await q.query<{ domain: string }>("SELECT domain FROM site_domains ORDER BY domain")).rows.map((r) => r.domain);

  return {
    id: siteId,
    name: site.name,
    publicKey: site.public_key,
    domains,
    settings: {
      systemPrompt: s.system_prompt,
      greeting: s.greeting,
      openingQuestion: s.opening_question,
      widgetPosition: s.widget_position,
      primaryColor: s.primary_color,
      model: s.model,
      provider: s.provider,
      dailyBudgetEur: Number(s.daily_budget_eur),
      maxMessagesPerConversation: s.max_messages_per_conversation,
      timezone: s.timezone,
      updatedAt: s.updated_at.toISOString(),
    },
  };
}

async function readSiteState(db: Db, siteId: string): Promise<SiteState | null> {
  if (!isUuid(siteId)) return null;
  return withTenant(db, siteId, async (q) => {
    if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
    return readSiteStateWith(q, siteId);
  });
}

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
