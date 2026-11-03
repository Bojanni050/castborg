import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  conversationsQuery,
  createSiteInput,
  addSourceInput,
  dashboardLoginInput,
  deletionsQuery,
  handoversQuery,
  leadsQuery,
  sendMessageInput,
  siteSettingsHistoryQuery,
  submitLeadInput,
  updateSiteSettingsInput,
  type WidgetConfigResponse,
} from "@ai-lead/shared";
import { resolveSiteByPublicKey, withTenant, type Actor, type Db } from "./db/tenant.js";
import {
  clearCookie,
  issueDashboardToken,
  readCookie,
  serializeCookie,
  verifyDashboardToken,
  verifyPassword,
  DASHBOARD_COOKIE,
  type DashboardAuthConfig,
} from "./dashboard-auth.js";
import { HANDOVER_REPLY, HANDOVER_RULE, isHandoverRequest } from "./handover.js";
import { notifyLead, type LeadWebhookConfig } from "./lead-webhook.js";
import { logEvent, logProviderError } from "./log.js";
import { estimateInputTokens, estimateUsage, type AiProvider, type ChatTurn, type ProviderRequest, type Usage } from "./provider.js";
import { RateLimiter } from "./ratelimit.js";
import {
  buildSourcePromptBlock,
  fetchAndChunk,
  MAX_CHUNKS_PER_TURN,
  MAX_SOURCES_PER_SITE,
  MAX_SOURCE_CHARS_PER_TURN,
  neutralizeMarkers,
  parseSourceUrl,
  type SourceRow,
} from "./knowledge.js";
import { deleteConversation, deleteLead, runRetention } from "./retention.js";
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
  /** Statische tokens voor scripts en tests. Het dashboard gebruikt de cookie hieronder. */
  adminTokens: AdminToken[];
  /**
   * Inloggen op het dashboard. Zonder deze config bestaat het dashboard wel, maar kan niemand in:
   * de loginroute antwoordt dan met 503 in plaats van te doen alsof.
   */
  dashboard?: DashboardAuthConfig;
  /** Map met de gebouwde dashboard-app. Leeg in tests; in productie zet de server hier een pad neer. */
  staticDir?: string;
  /** Map met de gebouwde widget (widget.js). Zonder deze map bestaat de route niet. */
  widgetDir?: string;
  provider: AiProvider;
  pricing: Pricing;
  /** Bovengrens per antwoord; dezelfde waarde als de provider gebruikt, anders rekent het budget scheef. */
  maxOutputTokens: number;
  /**
   * TIJDELIJK: als dit gezet is, komt het model uit de omgeving (MISTRAL_MODEL) en niet uit de
   * site-instellingen. Bestaat omdat de prijs in de omgeving ook globaal is: één model, één prijs.
   * Zodra de UI modellen laat kiezen hoort de prijs per model in de database en verdwijnt dit veld.
   */
  modelOverride?: string;
  /**
   * Waar een binnengekomen lead naartoe gaat. Zonder webhook wordt een lead alleen opgeslagen;
   * dat is precies de situatie waarin niemand hem leest, dus in productie hoort dit gezet te zijn.
   */
  leadWebhook?: LeadWebhookConfig;
  limiters?: {
    config?: RateLimiter;
    conversationStart?: RateLimiter;
    message?: RateLimiter;
    ipMessage?: RateLimiter;
    dashboardLogin?: RateLimiter;
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

/**
 * Lege formuliervelden betekenen "niet ingevuld", niet "lege string". Zonder dit zou een formulier
 * dat alle velden meestuurt stuklopen op de e-mailvalidatie. E-mail gaat naar kleine letters.
 */
function normalizeLeadBody(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== "string") {
      out[key] = raw;
      continue;
    }
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    out[key] = key === "email" ? trimmed.toLowerCase() : trimmed;
  }
  return out;
}

type TurnStatus = "ok" | "error" | "aborted";

interface LeadRow {
  id: string;
  conversation_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  status: string;
  created_at: Date;
}

interface ConversationRow {
  id: string;
  created_at: Date;
  updated_at: Date;
  message_count: number;
  lead_count: number;
  preview: string | null;
}

interface DeletionRow {
  id: string;
  ran_at: Date;
  source: string;
  subject: string;
  conversations: number;
  messages: number;
  leads: number;
  actor_type: string;
  actor_id: string;
}

interface HandoverRow {
  id: string;
  conversation_id: string;
  trigger_message: string;
  status: string;
  created_at: Date;
  handled_at: Date | null;
}

interface TurnSettings {
  system_prompt: string;
  model: string;
  site_name: string;
  max_messages_per_conversation: number;
  daily_budget_eur: string;
  timezone: string;
}

type BeginResult =
  | { kind: "ok"; systemPrompt: string; model: string; history: ChatTurn[]; reservationId: string | null }
  | { kind: "not_found" | "limit" | "budget" };

interface FinishArgs {
  claims: SessionClaims;
  req: ProviderRequest | null;
  requestId: string;
  /** Null bij een deterministische beurt (overdracht): er is niets gereserveerd. */
  reservationId: string | null;
  reply: string;
  usage: Usage | null;
  status: TurnStatus;
  durationMs: number;
  /** Alleen bij een beurt zonder provider; anders de naam van de gebruikte provider. */
  providerName?: string;
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
  conversationRetentionDays: "conversation_retention_days",
  leadRetentionDays: "lead_retention_days",
} as const;

export function createApp(deps: AppDeps): Hono {
  const {
    db,
    sessionSecret,
    adminTokens,
    dashboard,
    staticDir,
    widgetDir,
    provider,
    pricing,
    maxOutputTokens,
    modelOverride,
    leadWebhook,
  } = deps;
  const limits = {
    config: deps.limiters?.config ?? new RateLimiter(120, 60_000),
    conversationStart: deps.limiters?.conversationStart ?? new RateLimiter(20, 60_000),
    message: deps.limiters?.message ?? new RateLimiter(30, 60_000),
    ipMessage: deps.limiters?.ipMessage ?? new RateLimiter(120, 60_000),
    // Raden van een wachtwoord is alleen interessant als het vaak mag; 10 per kwartier per adres.
    dashboardLogin: deps.limiters?.dashboardLogin ?? new RateLimiter(10, 15 * 60_000),
  };

  const costEur = (u: Usage) => (u.inputTokens * pricing.inputEurPerMTok + u.outputTokens * pricing.outputEurPerMTok) / 1_000_000;

  /**
   * Bronchunks bij de bezoekersvraag zoeken en de systeemprompt ermee uitbreiden.
   *
   * De zoekvraag is bewust alleen het laatste bezoekersbericht, niet de hele geschiedenis:
   * eenvoudiger te begrijpen en goedkoop; als de bezoeker in twee zinnen doorpraat, kan hij
   * eventueel de term herhalen. Recaller (embeddings, samenvatting van de geschiedenis) bewust
   * een stap later, zolang keyword-overlap de kwaliteit haalt.
   *
   * Geen treffers of geen bronnen: dan is de prompt exact zoals vóór de kennisbank.
   */
  /** Vervangt {{siteName}} en plakt de gevonden bronchunks aan de systeemprompt. */
  async function assembleSystemPrompt(q: PoolClient, basePrompt: string, siteName: string, userText: string): Promise<string> {
    const rows = (
      await q.query<{ content: string; url: string }>(
        // Array-lexemes van de vraag met ' | ' (OR) samenvoegen: een vraag met vijf woorden
        // overlapt zelden met álles in één chunk, dus AND-semantiek (websearch_to_tsquery)
        // zou bijna leeg terugkomen. Relevantie doen we met ts_rank.
        `WITH q AS (
           SELECT to_tsquery('simple',
                  (SELECT string_agg(lex, ' | ')
                     FROM unnest(tsvector_to_array(to_tsvector('simple', $1))) AS lex)) AS tsq
         )
         SELECT pc.content, sp.url
           FROM page_chunks pc
             JOIN site_pages sp ON sp.id = pc.page_id
             CROSS JOIN q
          WHERE sp.status = 'ok'
            AND q.tsq IS NOT NULL
            AND pc.ts @@ q.tsq
          ORDER BY ts_rank(pc.ts, q.tsq) DESC, pc.chunk_index ASC
          LIMIT $2`,
        [userText, MAX_CHUNKS_PER_TURN],
      )
    ).rows;
    let prompt = basePrompt.replaceAll("{{siteName}}", siteName) + HANDOVER_RULE;
    if (rows.length === 0) return prompt;

    // Rangschikking is op relevantie; tot het tekencap de beste houden. En nog eens neutraliseren:
    // de database bevat al gewiste chunks, dit is de tweede lijn van de grens, niet de eerste.
    const sources: { url: string; content: string }[] = [];
    let total = 0;
    for (const row of rows) {
      const content = neutralizeMarkers(row.content);
      if (total + content.length > MAX_SOURCE_CHARS_PER_TURN) break;
      sources.push({ url: row.url, content });
      total += content.length;
    }
    if (sources.length === 0) return prompt;
    return prompt + buildSourcePromptBlock(sources);
  }

  /**
   * Transactie 1 van een beurt: valideren, budget en limiet controleren, gebruikersbericht opslaan, context ophalen.
   * De AI-aanroep valt hier bewust buiten, zodat er geen databaseverbinding vastzit tijdens de latency van de provider.
   *
   * Het budget is een harde grens: vóór de call wordt het maximale bedrag van deze beurt gereserveerd
   * (inputschatting + maxOutputTokens). Gelijktijdige beurten zien elkaars reservering, dus samen kunnen
   * ze het dagbudget niet overschrijden. Transactie 2 ruimt de reservering weer op.
   *
   * `reserve: false` (deterministische beurten zonder provider, zoals de overdracht) slaat de
   * budgetsectie over. Dat is bewust: een bezoeker die om een mens vraagt mag niet het slachtoffer
   * zijn van een dagbudget dat een ander gesprek op eigen begroeting al op heeft.
   */
  async function beginTurn(claims: SessionClaims, text: string, opts: { reserve?: boolean } = {}): Promise<BeginResult> {
    const reserve = opts.reserve ?? true;
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

      const systemPrompt = (await assembleSystemPrompt(q, settings.system_prompt, settings.site_name, text));

      if (!reserve) {
        await q.query("INSERT INTO messages (site_id, conversation_id, role, content) VALUES ($1, $2, 'user', $3)", [
          claims.siteId,
          claims.conversationId,
          text,
        ]);
        return {
          kind: "ok",
          systemPrompt,
          model: modelOverride ?? settings.model,
          history: [...existing, { role: "user" as const, content: text }],
          reservationId: null,
        };
      }

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
        model: modelOverride ?? settings.model,
        history: [...existing, { role: "user" as const, content: text }],
        reservationId,
      };
    });
  }

  /** Transactie 2: antwoord (ook gedeeltelijk) opslaan, verbruik registreren en de reservering vrijgeven. */
  async function finishTurn(a: FinishArgs): Promise<string | null> {
    // Zonder provider-response (deterministische beurt) is er niets te schatten: nul kosten, exact.
    const usage = a.usage ?? (a.req && a.reply ? estimateUsage(a.req, a.reply) : { inputTokens: 0, outputTokens: 0, estimated: false });
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
          a.providerName ?? provider.name,
          a.req?.model ?? "",
          usage.inputTokens,
          usage.outputTokens,
          costEur(usage),
          usage.estimated,
          a.status,
          Math.round(a.durationMs),
          a.requestId,
        ],
      );
      if (a.reservationId) await q.query("DELETE FROM usage_reservations WHERE id = $1", [a.reservationId]);
      return messageId;
    });
  }

  /**
   * Deterministische overdrachtsbeurt: geen provider, geen reservering, vaste tekst.
   * beginTurn (zonder budgetreservering), één handover-rij (ON CONFLICT DO NOTHING: nóg een
   * vraag om een mens in hetzelfde gesprek maakt geen nieuwe rij) en finishTurn met exact nul kosten.
   */
  async function handoverTurn(
    claims: SessionClaims,
    text: string,
    requestId: string,
  ): Promise<{ kind: "ok"; messageId: string | null; created: boolean; handoverId: string | null } | { kind: "not_found" | "limit" | "budget" }> {
    const turn = await beginTurn(claims, text, { reserve: false });
    // budget kan door het type mee, maar is bij reserve:false runtime onmogelijk.
    if (turn.kind !== "ok") return turn;

    const handover = await withTenant(db, claims.siteId, async (q) => {
      const row = (
        await q.query<{ id: string }>(
          `INSERT INTO handovers (site_id, conversation_id, trigger_message)
                VALUES ($1, $2, $3)
           ON CONFLICT (conversation_id) DO NOTHING
           RETURNING id`,
          [claims.siteId, claims.conversationId, text],
        )
      ).rows[0];
      return row ? { id: row.id, created: true } : { id: null, created: false };
    });

    const messageId = await finishTurn({
      claims,
      req: null,
      requestId,
      reservationId: null,
      reply: HANDOVER_REPLY,
      usage: { inputTokens: 0, outputTokens: 0, estimated: false },
      status: "ok",
      durationMs: 0,
      providerName: "deterministic",
    });
    return { kind: "ok", messageId, created: handover.created, handoverId: handover.id };
  }

  /**
   * Meldt een nieuw overdrachtsverzoek via de webhook, alleen als de handover-rij net is aangemaakt.
   * Herhaalt het verzoek de bezoeker in hetzelfde gesprek, dan is de sitehouder al gewaarschuwd en
   * volgt geen tweede melding. Fouten slikt notifyLead in.
   */
  async function notifyHandoverRequested(
    leadWebhook: LeadWebhookConfig | undefined,
    claims: SessionClaims,
    handover: { created: boolean; handoverId: string | null },
    triggerMessage: string,
  ): Promise<void> {
    if (!leadWebhook || !handover.created) return;
    await notifyLead(leadWebhook, {
      event: "handover.requested",
      handoverId: handover.handoverId,
      siteId: claims.siteId,
      conversationId: claims.conversationId,
      triggerMessage,
      receivedAt: new Date().toISOString(),
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

  /**
   * Wie beheert er? Twee wegen, één actor:
   * - Bearer-token uit ADMIN_TOKENS: voor scripts, tests en noodgevallen.
   * - Dashboardcookie: voor een mens in de browser.
   * De actor komt uit de gebruikte weg, want dat is precies wat de historie moet laten zien.
   */
  function authenticateOperator(c: Context): Actor | null {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (bearer) {
      let found: Actor | null = null;
      // Alle tokens vergelijken (geen vroege exit) zodat de duur niets verraadt.
      for (const t of adminTokens) {
        if (safeEqual(bearer, t.token)) found = { type: "admin_token", id: t.name };
      }
      return found;
    }
    if (!dashboard) return null;
    const token = readCookie(c.req.header("cookie"), DASHBOARD_COOKIE);
    if (!token) return null;
    const claims = verifyDashboardToken(token, sessionSecret);
    if (!claims) return null;
    return { type: "user", id: claims.sub };
  }

  /** Model tijdelijk uit de omgeving: één bron, geen instelling die niets doet. */
  const modelLocked = (c: Context) =>
    c.json(
      {
        error: "model_locked",
        model: modelOverride,
        message: "Het model komt nu uit MISTRAL_MODEL in .env; haal die variabele weg om het per site te zetten.",
      },
      409,
    );

  const app = new Hono();

  // CORS voor widgetroutes. Er worden geen cookies gebruikt; autorisatie loopt via sleutel of bearer-token.
  app.use("/api/v1/widget/*", corsMiddleware);
  app.use("/api/v1/conversations/*", corsMiddleware);
  app.use("/api/v1/conversations", corsMiddleware);

  app.get("/api/v1/health", (c) => c.json({ ok: true }));

  // ---------------------------------------------------------------------------
  // Dashboard: wie ben je, en wat zie je
  // ---------------------------------------------------------------------------
  app.post("/api/v1/dashboard/login", async (c) => {
    if (!dashboard) {
      return c.json({ error: "not_configured", message: "Er is geen DASHBOARD_PASSWORD ingesteld." }, 503);
    }
    if (!limits.dashboardLogin.check(`login:${clientIp(c)}`)) {
      return c.json({ error: "rate_limited" }, 429);
    }
    const parsed = dashboardLoginInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
    if (!verifyPassword(parsed.data.password, dashboard.password)) {
      // Geen verschil tussen "onbekende gebruiker" en "fout wachtwoord": er is maar één gebruiker.
      logEvent("warn", "dashboard_login_failed", { ip: clientIp(c) });
      return c.json({ error: "unauthorized" }, 401);
    }

    const ttl = dashboard.ttlSeconds ?? 8 * 60 * 60;
    const token = issueDashboardToken({ sub: dashboard.actorId }, sessionSecret, ttl);
    c.header("set-cookie", serializeCookie(token, dashboard));
    logEvent("info", "dashboard_login_ok", { actor: dashboard.actorId });
    return c.json({ actor: { type: "user", id: dashboard.actorId }, expiresInSeconds: ttl, modelOverride: modelOverride ?? null });
  });

  app.post("/api/v1/dashboard/logout", (c) => {
    if (dashboard) c.header("set-cookie", clearCookie(dashboard));
    return c.json({ ok: true });
  });

  app.get("/api/v1/dashboard/me", (c) => {
    const actor = authenticateOperator(c);
    // modelOverride gaat mee zodat het dashboard een veld kan uitzetten in plaats van te laten falen.
    return actor ? c.json({ actor, modelOverride: modelOverride ?? null }) : c.json({ error: "unauthorized" }, 401);
  });

  /**
   * Alle sites in één lijst. Dit kan niet via `withTenant`: de runtime-rol ziet per beleid alleen de
   * eigen site, en dat is de bedoeling. Daarom een smalle SECURITY DEFINER-functie die precies deze
   * velden teruggeeft — geen blanket-bypass, geen extra rechten op de tabellen.
   */
  app.get("/api/v1/dashboard/sites", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);
    const { rows } = await db.query<{
      id: string;
      name: string;
      public_key: string;
      created_at: Date;
      domains: string[];
      lead_count: string;
      conversation_count: string;
    }>("SELECT * FROM dashboard_list_sites()");
    return c.json({
      sites: rows.map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: r.public_key,
        domains: r.domains ?? [],
        createdAt: r.created_at.toISOString(),
        leadCount: Number(r.lead_count),
        conversationCount: Number(r.conversation_count),
      })),
    });
  });

  // ---------------------------------------------------------------------------
  // Beheer (tijdelijk): sites aanmaken en instellen
  // ---------------------------------------------------------------------------
  app.post("/api/v1/admin/sites", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const parsed = createSiteInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const input = parsed.data;
    if (input.model !== undefined && modelOverride) return modelLocked(c);
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
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const state = await readSiteState(db, c.req.param("id"));
    if (!state) return c.json({ error: "not_found" }, 404);
    return c.json(state);
  });

  app.patch("/api/v1/admin/sites/:id", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const parsed = updateSiteSettingsInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
    if (parsed.data.model !== undefined && modelOverride) return modelLocked(c);

    return respondToUpdate(c, await applySiteUpdate(db, c.req.param("id"), parsed.data, actor));
  });

  // ---------------------------------------------------------------------------
  // Beheer: leads van deze site. Een lead die niemand leest is geen lead.
  // ---------------------------------------------------------------------------
  app.get("/api/v1/admin/sites/:id/leads", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const parsed = leadsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const leads = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      const rows = (
        await q.query<LeadRow>(
          `SELECT id, conversation_id, name, email, phone, message, status, created_at
             FROM leads ORDER BY created_at DESC, id DESC LIMIT $1`,
          [parsed.data.limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        name: row.name,
        email: row.email,
        phone: row.phone,
        message: row.message,
        status: row.status,
        createdAt: row.created_at.toISOString(),
      }));
    });
    if (!leads) return c.json({ error: "not_found" }, 404);
    return c.json({ leads });
  });

  /**
   * Gesprekken van een site, alleen om te kunnen opruimen. Met een stukje van het eerste
   * bezoekersbericht: een lijst met tijdstippen alleen is niet te beoordelen, en dan delete je
   * of niets of alles.
   */
  app.get("/api/v1/admin/sites/:id/conversations", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const parsed = conversationsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const conversations = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      const rows = (
        await q.query<ConversationRow>(
          `SELECT c.id, c.created_at, c.updated_at,
                  (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count,
                  (SELECT count(*)::int FROM leads l WHERE l.conversation_id = c.id) AS lead_count,
                  (SELECT left(m.content, 120) FROM messages m
                    WHERE m.conversation_id = c.id AND m.role = 'user'
                    ORDER BY m.created_at LIMIT 1) AS preview
             FROM conversations c
            ORDER BY c.updated_at DESC, c.id DESC
            LIMIT $1`,
          [parsed.data.limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        messageCount: row.message_count,
        leadCount: row.lead_count,
        preview: row.preview,
      }));
    });
    if (!conversations) return c.json({ error: "not_found" }, 404);
    return c.json({ conversations });
  });

  /**
   * Verwijdert één gesprek. Berichten gaan mee, een lead blijft en raakt zijn gesprek kwijt, de
   * kostenadministratie blijft staan met een lege conversation_id.
   */
  app.delete("/api/v1/admin/sites/:id/conversations/:conversationId", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const conversationId = c.req.param("conversationId");
    if (!isUuid(siteId) || !isUuid(conversationId)) return c.json({ error: "not_found" }, 404);

    const deleted = await deleteConversation(db, siteId, conversationId, actor);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted });
  });

  app.delete("/api/v1/admin/sites/:id/leads/:leadId", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const leadId = c.req.param("leadId");
    if (!isUuid(siteId) || !isUuid(leadId)) return c.json({ error: "not_found" }, 404);

    const deleted = await deleteLead(db, siteId, leadId, actor);
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted: { conversations: 0, messages: 0, leads: 1 } });
  });

  /** Nu opruimen volgens de termijnen van deze site. De cron gebruikt hetzelfde pad. */
  app.post("/api/v1/admin/sites/:id/retention/run", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);
    if (!(await readSiteState(db, siteId))) return c.json({ error: "not_found" }, 404);

    return c.json({ deleted: await runRetention(db, siteId, actor) });
  });

  /** Wat er is weggegooid: aantallen, geen inhoud. */
  app.get("/api/v1/admin/sites/:id/deletions", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const parsed = deletionsQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const deletions = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      const rows = (
        await q.query<DeletionRow>(
          `SELECT id, ran_at, source, subject, conversations, messages, leads, actor_type, actor_id
             FROM deletion_log ORDER BY ran_at DESC, id DESC LIMIT $1`,
          [parsed.data.limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        ranAt: row.ran_at.toISOString(),
        source: row.source,
        subject: row.subject,
        conversations: row.conversations,
        messages: row.messages,
        leads: row.leads,
        actorType: row.actor_type,
        actorId: row.actor_id,
      }));
    });
    if (!deletions) return c.json({ error: "not_found" }, 404);
    return c.json({ deletions });
  });

  app.get("/api/v1/admin/sites/:id/history", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

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
    const actor = authenticateOperator(c);
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
    const restored = snapshotToInput(snapshot);
    // Staat het model tijdelijk vast via MISTRAL_MODEL, dan raakt een terugdraaiing het model niet aan;
    // anders zou je een oude prompt niet kunnen terugzetten zonder het model te overschrijven.
    if (modelOverride) delete restored.model;
    if (Object.keys(restored).length === 0) return modelLocked(c);

    const parsed = updateSiteSettingsInput.safeParse(restored);
    if (!parsed.success) return c.json({ error: "invalid_history" }, 500);

    return respondToUpdate(c, await applySiteUpdate(db, siteId, parsed.data, actor));
  });

  // ---------------------------------------------------------------------------
  // Beheer: kennisbronnen van een site. De assistent mag alleen doen wat er echt staat.
  //
  // Het ophalen van de pagina gebeurt vóór de transactie: een netwerkgesprek mag nooit een
  // databaseverbinding vasthouden (zelfde redenering als de AI-aanroep). Het wegschrijven
  // van bron en chunks is één transactie: een halve bron bestaat niet.
  // ---------------------------------------------------------------------------

  interface SourceRowDb {
    id: string;
    url: string;
    title: string | null;
    status: "pending" | "ok" | "failed";
    error_code: string | null;
    content_length: number;
    chunk_count: number;
    fetched_at: Date;
  }

  const mapSourceRow = (r: SourceRowDb): SourceRow => ({
    id: r.id,
    url: r.url,
    title: r.title,
    status: r.status,
    errorCode: r.error_code,
    contentLength: r.content_length,
    chunkCount: r.chunk_count,
    fetchedAt: r.fetched_at.toISOString(),
  });

  const SOURCE_LIST_SQL = `
    SELECT sp.id, sp.url, sp.title, sp.status, sp.error_code, sp.content_length, sp.fetched_at,
           (SELECT count(*)::int FROM page_chunks pc WHERE pc.page_id = sp.id) AS chunk_count
      FROM site_pages sp
     ORDER BY sp.url`;

  const sourceExists = async (q: PoolClient, siteId: string, url: string) =>
    (await q.query("SELECT 1 FROM site_pages WHERE site_id = $1 AND url = $2", [siteId, url])).rowCount === 1;

  /** Ophalen gebeurt synchroon op de POST; deze route is alleen lezen. */
  app.get("/api/v1/admin/sites/:id/sources", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const sources = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      return (await q.query<SourceRowDb>(SOURCE_LIST_SQL)).rows.map(mapSourceRow);
    });
    if (!sources) return c.json({ error: "not_found" }, 404);
    return c.json({ sources, maxSources: MAX_SOURCES_PER_SITE });
  });

  app.post("/api/v1/admin/sites/:id/sources", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const parsed = addSourceInput.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);
    const parsedUrl = parseSourceUrl(parsed.data.url);
    if (!parsedUrl) return c.json({ error: "invalid_url", message: "Alleen publieke http(s)-pagina's; geen localhost of privénetwerk." }, 400);
    const url = parsedUrl.toString();

    // Bestaat de site, is er ruimte en staat er niet al een bron op die URL? Dit éérst:
    // twee keer een pagina ophalen is zonde, en de grens hoort per site en niet per netwerkpoging.
    const precheck = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return "not_found";
      if (await sourceExists(q, siteId, url)) return "duplicate";
      const sources = await q.query<SourceRowDb>(SOURCE_LIST_SQL);
      if (sources.rows.length >= MAX_SOURCES_PER_SITE) return "limit";
      return "ok";
    });
    if (precheck === "not_found") return c.json({ error: "not_found" }, 404);
    if (precheck === "duplicate") return c.json({ error: "duplicate", message: "Deze URL is al een bron." }, 409);
    if (precheck === "limit") return c.json({ error: "limit", message: `Maximaal ${MAX_SOURCES_PER_SITE} bronnen per site.` }, 409);

    const result = await fetchAndChunk(url);
    const id = randomUUID();
    const outcome = (result.kind === "ok"
      ? {
          status: "ok" as const,
          errorCode: null,
          title: result.title,
          rawText: result.text,
          contentLength: result.text.length,
          chunks: result.chunks,
        }
      : { status: "failed" as const, errorCode: result.code, title: null, rawText: "", contentLength: 0, chunks: [] });

    const source = await withTenant(
      db,
      siteId,
      async (q) => {
        await q.query(
          `INSERT INTO site_pages (id, site_id, url, title, status, error_code, content_length, raw_text)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [id, siteId, url, outcome.title, outcome.status, outcome.errorCode, outcome.contentLength, outcome.rawText],
        );
        for (const [i, raw] of (outcome.chunks as string[]).entries()) {
          // Vóór het opslaan de markers onschadelijk maken; de prompt-assemblage controleert het later nog eens.
          await q.query("INSERT INTO page_chunks (site_id, page_id, chunk_index, content) VALUES ($1, $2, $3, $4)", [
            siteId,
            id,
            i,
            neutralizeMarkers(raw),
          ]);
        }
        const row = (
          await q.query<SourceRowDb>(
            `SELECT sp.id, sp.url, sp.title, sp.status, sp.error_code, sp.content_length, sp.fetched_at,
                    (SELECT count(*)::int FROM page_chunks pc WHERE pc.page_id = sp.id) AS chunk_count
               FROM site_pages sp WHERE sp.id = $1`,
            [id],
          )
        ).rows[0]!;
        return mapSourceRow(row);
      },
      actor,
    );
    return c.json({ source }, 201);
  });

  /** Opnieuw ophalen en, bij succes, de oude chunks vervangen. Bij mislukking de oude kennis laten staan. */
  app.post("/api/v1/admin/sites/:id/sources/:sourceId/reindex", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const sourceId = c.req.param("sourceId");
    if (!isUuid(siteId) || !isUuid(sourceId)) return c.json({ error: "not_found" }, 404);

    const existing = await withTenant(db, siteId, async (q) => {
      const row = (await q.query<{ url: string }>("SELECT url FROM site_pages WHERE id = $1", [sourceId])).rows[0];
      return row?.url ?? null;
    });
    if (!existing) return c.json({ error: "not_found" }, 404);

    const result = await fetchAndChunk(existing);
    const source = await withTenant(
      db,
      siteId,
      async (q) => {
        if (result.kind === "ok") {
          await q.query(
            `UPDATE site_pages SET title = $2, status = 'ok', error_code = NULL, content_length = $3,
                    raw_text = $4, fetched_at = now(), updated_at = now()
              WHERE id = $1`,
            [sourceId, result.title, result.text.length, result.text],
          );
          await q.query("DELETE FROM page_chunks WHERE page_id = $1", [sourceId]);
          for (const [i, raw] of (result.chunks as string[]).entries()) {
            await q.query("INSERT INTO page_chunks (site_id, page_id, chunk_index, content) VALUES ($1, $2, $3, $4)", [
              siteId,
              sourceId,
              i,
              neutralizeMarkers(raw),
            ]);
          }
        } else {
          // De oude kennis blijft bestaan tot een volgende geslaagde hertoetsing: een tijdelijke
          // netwerkstoring mag een site niet stilletjes van zijn bronkennis beroven.
          await q.query(
            `UPDATE site_pages SET status = 'failed', error_code = $2, content_length = 0,
                    fetched_at = now(), updated_at = now()
              WHERE id = $1`,
            [sourceId, result.code],
          );
        }
        const row = (
          await q.query<SourceRowDb>(
            `SELECT sp.id, sp.url, sp.title, sp.status, sp.error_code, sp.content_length, sp.fetched_at,
                    (SELECT count(*)::int FROM page_chunks pc WHERE pc.page_id = sp.id) AS chunk_count
               FROM site_pages sp WHERE sp.id = $1`,
            [sourceId],
          )
        ).rows[0]!;
        return mapSourceRow(row);
      },
      actor,
    );
    return c.json({ source });
  });

  app.delete("/api/v1/admin/sites/:id/sources/:sourceId", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const sourceId = c.req.param("sourceId");
    if (!isUuid(siteId) || !isUuid(sourceId)) return c.json({ error: "not_found" }, 404);

    const deleted = await withTenant(
      db,
      siteId,
      async (q) => {
        const page = (await q.query<{ id: string }>("SELECT id FROM site_pages WHERE id = $1", [sourceId])).rows[0];
        if (!page) return null;
        const chunks = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM page_chunks WHERE page_id = $1", [sourceId])).rows[0]!.n;
        await q.query("DELETE FROM site_pages WHERE id = $1", [sourceId]); // chunks gaan mee (ON DELETE CASCADE)
        return { pages: 1, chunks };
      },
      actor,
    );
    if (!deleted) return c.json({ error: "not_found" }, 404);
    return c.json({ deleted });
  });

  // ---------------------------------------------------------------------------
  // Beheer: overdrachtsverzoeken. De lijst, het afronden en het gesprek van de bezoeker.
  // ---------------------------------------------------------------------------
  app.get("/api/v1/admin/sites/:id/handovers", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const parsed = handoversQuery.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "invalid_input" }, 400);

    const siteId = c.req.param("id");
    if (!isUuid(siteId)) return c.json({ error: "not_found" }, 404);

    const handovers = await withTenant(db, siteId, async (q) => {
      if ((await q.query("SELECT 1 FROM sites WHERE id = $1", [siteId])).rowCount === 0) return null;
      const rows = (
        await q.query<HandoverRow>(
          `SELECT id, conversation_id, trigger_message, status, created_at, handled_at
             FROM handovers ORDER BY created_at DESC, id DESC LIMIT $1`,
          [parsed.data.limit],
        )
      ).rows;
      return rows.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        triggerMessage: row.trigger_message,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        handledAt: row.handled_at?.toISOString() ?? null,
      }));
    });
    if (!handovers) return c.json({ error: "not_found" }, 404);
    return c.json({ handovers });
  });

  app.post("/api/v1/admin/sites/:id/handovers/:handoverId/complete", async (c) => {
    const actor = authenticateOperator(c);
    if (!actor) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const handoverId = c.req.param("handoverId");
    if (!isUuid(siteId) || !isUuid(handoverId)) return c.json({ error: "not_found" }, 404);

    // Alleen een open overdracht wordt afgerond; 'completen' is geen opnieuw-completen en de actie
    // verdwijnt daarmee uit de lijst van dingen die nog te doen zijn.
    const handover = await withTenant(
      db,
      siteId,
      async (q) => {
        const row = (
          await q.query<{ id: string }>(
            `UPDATE handovers SET status = 'done', handled_at = now(), updated_at = now()
               WHERE id = $1 AND status = 'open'
             RETURNING id`,
            [handoverId],
          )
        ).rows[0];
        return row ? { id: row.id, status: "done" as const } : null;
      },
      actor,
    );
    if (!handover) return c.json({ error: "not_found" }, 404);
    return c.json({ handover });
  });

  /** Het gesprek van een bezoeker, alleen om te lezen na een overdracht, chronologisch. */
  app.get("/api/v1/admin/sites/:id/conversations/:conversationId/messages", async (c) => {
    if (!authenticateOperator(c)) return c.json({ error: "unauthorized" }, 401);

    const siteId = c.req.param("id");
    const conversationId = c.req.param("conversationId");
    if (!isUuid(siteId) || !isUuid(conversationId)) return c.json({ error: "not_found" }, 404);

    const transcript = await withTenant(db, siteId, async (q) => {
      const conv = (await q.query<{ id: string }>("SELECT id FROM conversations WHERE id = $1", [conversationId])).rows[0];
      if (!conv) return null;
      const rows = (
        await q.query<{ role: string; content: string; created_at: Date }>(
          "SELECT role, content, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
          [conversationId],
        )
      ).rows;
      return rows.map((m) => ({ role: m.role, content: m.content, createdAt: m.created_at.toISOString() }));
    });
    if (!transcript) return c.json({ error: "not_found" }, 404);
    return c.json({ messages: transcript });
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

    // De bezoeker vraagt om een mens: vaste tekst, geen provider, geen kosten, n prepaid handover-rij...
    if (isHandoverRequest(text)) {
      const handover = await handoverTurn(claims, text, requestId);
      if (handover.kind !== "ok") return beginFailure(c, handover.kind);
      await notifyHandoverRequested(leadWebhook, claims, handover, text);
      return c.json({ messageId: handover.messageId, reply: HANDOVER_REPLY, requestId, handover: true });
    }

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

    // Overdrachtsbeurt: één delta met de vaste tekst en een done met de handover-vlag; geen provider.
    if (isHandoverRequest(text)) {
      const handover = await handoverTurn(claims, text, requestId);
      if (handover.kind !== "ok") return beginFailure(c, handover.kind);
      await notifyHandoverRequested(leadWebhook, claims, handover, text);
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "delta", data: JSON.stringify({ text: HANDOVER_REPLY }) });
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ messageId: handover.messageId, requestId, handover: true }),
        });
      });
    }

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

  // ---------------------------------------------------------------------------
  // Publiek (token): lead achterlaten. Nog eens sturen is een update, geen tweede lead.
  // ---------------------------------------------------------------------------
  app.post("/api/v1/conversations/:id/lead", async (c) => {
    const bearer = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const claims = verifySessionToken(bearer, sessionSecret);
    if (!claims || claims.conversationId !== c.req.param("id")) return c.json({ error: "unauthorized" }, 401);

    if (!limits.ipMessage.check(`lead:${clientIp(c)}`)) return c.json({ error: "rate_limited" }, 429);

    const parsed = submitLeadInput.safeParse(normalizeLeadBody(await readJson(c)));
    if (!parsed.success) return c.json({ error: "invalid_input", hint: "minstens e-mail of telefoon" }, 400);
    const { website, ...input } = parsed.data;

    // Honeypot: gevuld betekent bots. Antwoorden alsof het gelukt is, niets opslaan, geen melding.
    // Een bot die een fout terugkrijgt, past zijn invoer aan en probeert opnieuw.
    if (website) {
      logEvent("warn", "lead_honeypot", { siteId: claims.siteId, conversationId: claims.conversationId });
      return c.json({ leadId: randomUUID(), created: true }, 201);
    }

    const result = await withTenant(db, claims.siteId, async (q) => {
      // Geen tijdsdrempel op de leeftijd van het gesprek: de widget maakt dat gesprek pas aan op het
      // moment van versturen, dus een bezoeker die meteen zijn gegevens invult zou anders verdwijnen.
      const conv = (
        await q.query<{ site_name: string; public_key: string }>(
          `SELECT s.name AS site_name, s.public_key
             FROM conversations c
             JOIN sites s ON s.id = c.site_id
            WHERE c.id = $1`,
          [claims.conversationId],
        )
      ).rows[0];
      if (!conv) return null;

      const existing = (
        await q.query<{ id: string }>("SELECT id FROM leads WHERE conversation_id = $1", [claims.conversationId])
      ).rowCount;

      const row = (
        await q.query<{ id: string }>(
          `INSERT INTO leads (site_id, conversation_id, name, email, phone, message)
                VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (conversation_id) DO UPDATE
                SET name = EXCLUDED.name,
                    email = EXCLUDED.email,
                    phone = EXCLUDED.phone,
                    message = EXCLUDED.message
           RETURNING id`,
          [
            claims.siteId,
            claims.conversationId,
            input.name ?? null,
            input.email ?? null,
            input.phone ?? null,
            input.message ?? null,
          ],
        )
      ).rows[0]!;

      await q.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [claims.conversationId]);
      return {
        kind: "stored" as const,
        leadId: row.id,
        created: existing === 0,
        siteName: conv.site_name,
        siteKey: conv.public_key,
      };
    });
    if (!result) return c.json({ error: "not_found" }, 404);

    // Na de commit, en met een korte timeout: de bezoeker wacht erop, dus dit mag niet blijven hangen.
    // notifyLead slikt fouten in en logt ze; een kapotte webhook mag nooit een lead laten mislukken.
    if (leadWebhook) {
      await notifyLead(leadWebhook, {
        event: result.created ? "lead.created" : "lead.updated",
        leadId: result.leadId,
        siteId: claims.siteId,
        siteName: result.siteName,
        siteKey: result.siteKey,
        conversationId: claims.conversationId,
        name: input.name ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        message: input.message ?? null,
        receivedAt: new Date().toISOString(),
      });
    }

    return c.json({ leadId: result.leadId, created: result.created }, result.created ? 201 : 200);
  });

  // De widget vanaf dezelfde origin als de API. Een klantsite hoeft dan maar één adres te kennen
  // (`<script src="https://api.example.com/widget.js" data-site-key="pk_...">`) en de widget praat
  // standaard met de origin waar hij vandaan komt. Kort gecached: bij een nieuwe versie pakt de
  // browser hem binnen vijf minuten, en `?v=...` aan de URL dwingt het meteen af.
  //
  // Bewust niet via serveStatic: dat zet geen eigen headers en de bundel is één bestand van ~30 kB.
  if (widgetDir) {
    const widgetFile = join(widgetDir, "widget.js");
    app.get("/widget.js", async (c) => {
      try {
        const body = await readFile(widgetFile, "utf8");
        c.header("content-type", "text/javascript; charset=utf-8");
        c.header("cache-control", "public, max-age=300");
        return c.body(body);
      } catch {
        return c.notFound();
      }
    });
  }

  // Het dashboard uit dezelfde origin serveren als de API. Dat is geen detail: de sessiecookie is
  // SameSite=Lax, dus een losse dashboard-origin zou CORS met credentials vereisen en de cookie
  // alsnog op de verkeerde origin zetten. Zonder staticDir (tests) bestaat deze mount niet.
  if (staticDir) {
    app.use("/*", serveStatic({ root: staticDir }));
  }

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
    conversationRetentionDays: number;
    leadRetentionDays: number;
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
      conversation_retention_days: number;
      lead_retention_days: number;
      updated_at: Date;
    }>(
      `SELECT system_prompt, greeting, opening_question, widget_position, primary_color, model, provider,
              daily_budget_eur, max_messages_per_conversation, timezone, conversation_retention_days,
              lead_retention_days, updated_at
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
      conversationRetentionDays: s.conversation_retention_days,
      leadRetentionDays: s.lead_retention_days,
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
