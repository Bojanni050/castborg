import { serve } from "@hono/node-server";
import { createApp, type AdminToken, type Pricing } from "./app.js";
import { createPool } from "./db/tenant.js";
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
  provider,
  pricing,
  maxOutputTokens,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`API luistert op http://127.0.0.1:${port} (provider: ${provider.name})`);
});
