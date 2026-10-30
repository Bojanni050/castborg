import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, type AdminToken, type Pricing } from "./app.js";
import { createPool } from "./db/tenant.js";
import { logEvent } from "./log.js";
import { MistralProvider } from "./mistral.js";
import { StubProvider, type AiProvider } from "./provider.js";

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function required(name: string): string {
  return process.env[name] || fail(`${name} ontbreekt`);
}

function requiredNumber(name: string): number {
  const n = Number(required(name));
  return Number.isFinite(n) && n >= 0 ? n : fail(`${name} moet een getal >= 0 zijn`);
}

/**
 * Eén token is genoeg om te beginnen. Meerdere tokens met een naam (`ADMIN_TOKENS=bojan:tok1,anna:tok2`)
 * geven meteen een bruikbare actor in de historie, zonder een volledig auth-systeem.
 */
function adminTokens(): AdminToken[] {
  const multiple = process.env.ADMIN_TOKENS?.trim();
  if (multiple) {
    const parsed = multiple
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const idx = entry.indexOf(":");
        if (idx <= 0 || idx === entry.length - 1) fail(`ADMIN_TOKENS: verwacht naam:token, kreeg "${entry}"`);
        return { name: entry.slice(0, idx).trim(), token: entry.slice(idx + 1).trim() };
      });
    if (parsed.length === 0) fail("ADMIN_TOKENS bevat geen bruikbare tokens");
    return parsed;
  }
  return [{ name: process.env.ADMIN_TOKEN_NAME?.trim() || "admin", token: required("ADMIN_TOKEN") }];
}

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) fail("SESSION_SECRET moet minimaal 32 tekens zijn");

const maxOutputTokens = process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : 800;
if (!Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0) fail("MAX_OUTPUT_TOKENS moet een positief geheel getal zijn");

/**
 * Tijdelijk: het model uit de omgeving overschrijft de site-instellingen. Bewust, zolang de prijs ook
 * globaal in de omgeving staat (één model, één prijs). Verdwijnt zodra de UI modellen laat kiezen en
 * de prijs per model in de database staat.
 */
const modelOverride = process.env.MISTRAL_MODEL?.trim() || undefined;

/**
 * Waar een lead naartoe gaat. Zonder deze variabele wordt een lead alleen opgeslagen, en dan leest
 * niemand hem. Optioneel geheim: de body wordt dan ondertekend met HMAC-SHA256.
 */
const leadWebhookUrl = process.env.LEAD_WEBHOOK_URL?.trim();
if (leadWebhookUrl && !/^https?:\/\//i.test(leadWebhookUrl)) fail("LEAD_WEBHOOK_URL moet met http:// of https:// beginnen");
const leadWebhook = leadWebhookUrl
  ? { url: leadWebhookUrl, secret: process.env.LEAD_WEBHOOK_SECRET?.trim() || undefined }
  : undefined;

/**
 * Dashboard-login: één operator, één wachtwoord. Optioneel, maar zonder deze variabele kan niemand
 * inloggen (de loginroute antwoordt dan 503 in plaats van te doen alsof).
 *
 * Het wachtwoord staat bewust niet in de database: er is geen users-tabel, dus er is ook niets om te
 * hashen. Zodra meerdere mensen of klanten inloggen, verhuist dit naar een rij per gebruiker.
 */
const dashboardPassword = process.env.DASHBOARD_PASSWORD?.trim() || undefined;
if (dashboardPassword && dashboardPassword.length < 12) fail("DASHBOARD_PASSWORD moet minimaal 12 tekens zijn");
const dashboard = dashboardPassword
  ? {
      password: dashboardPassword,
      actorId: process.env.DASHBOARD_ACTOR?.trim() || "owner",
      cookieSecure: process.env.COOKIE_SECURE === "true",
    }
  : undefined;

/**
 * De gebouwde dashboard-app, als die er is. Zelfde origin als de API, zodat de sessiecookie werkt
 * zonder CORS met credentials. Ontbreekt de map, dan draait de API gewoon zonder dashboard.
 */
const staticDirUrl = new URL("../../dashboard/dist", import.meta.url);
const staticDir = existsSync(fileURLToPath(staticDirUrl)) ? fileURLToPath(staticDirUrl) : undefined;

const providerName = process.env.PROVIDER ?? "mistral";
let provider: AiProvider;
let pricing: Pricing;

if (providerName === "stub") {
  // Alleen voor lokale ontwikkeling. STUB_STREAM_DELAY_MS maakt het streamen zichtbaar in de widget.
  const stubDelay = process.env.STUB_STREAM_DELAY_MS ? Number(process.env.STUB_STREAM_DELAY_MS) : 0;
  if (!Number.isInteger(stubDelay) || stubDelay < 0) fail("STUB_STREAM_DELAY_MS moet 0 of een positief geheel getal zijn");
  provider = new StubProvider({ delayMs: stubDelay });
  pricing = { inputEurPerMTok: 0, outputEurPerMTok: 0 };
} else if (providerName === "mistral") {
  provider = new MistralProvider({
    apiKey: required("MISTRAL_API_KEY"),
    baseUrl: process.env.MISTRAL_BASE_URL,
    maxOutputTokens,
  });
  // Bewust verplicht: zonder prijzen is het dagbudget betekenisloos. Controleer ze in je Mistral-account.
  pricing = {
    inputEurPerMTok: requiredNumber("PRICE_INPUT_EUR_PER_M_TOKENS"),
    outputEurPerMTok: requiredNumber("PRICE_OUTPUT_EUR_PER_M_TOKENS"),
  };
} else {
  fail(`Onbekende PROVIDER: ${providerName}`);
}

const app = createApp({
  db: createPool(required("DATABASE_URL_APP")),
  sessionSecret,
  adminTokens: adminTokens(),
  dashboard,
  staticDir,
  provider,
  pricing,
  maxOutputTokens,
  modelOverride,
  leadWebhook,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`API luistert op http://127.0.0.1:${port} (provider: ${provider.name})`);
  if (modelOverride) {
    logEvent("warn", "model_override_active", {
      model: modelOverride,
      note: "MISTRAL_MODEL overschrijft de site-instellingen; PATCH met een model geeft 409.",
    });
  }
  if (!leadWebhook) {
    logEvent("warn", "lead_webhook_missing", {
      note: "Geen LEAD_WEBHOOK_URL: leads worden opgeslagen, maar niemand krijgt bericht.",
    });
  }
  if (!dashboard) {
    logEvent("warn", "dashboard_login_disabled", {
      note: "Geen DASHBOARD_PASSWORD: het dashboard is bereikbaar maar niemand kan inloggen. Beheer loopt nu via ADMIN_TOKEN.",
    });
  }
  if (!staticDir) {
    logEvent("warn", "dashboard_build_missing", {
      note: "Geen packages/dashboard/dist: alleen de API draait. Bouw het dashboard met corepack pnpm --filter @ai-lead/dashboard build.",
    });
  }
});
