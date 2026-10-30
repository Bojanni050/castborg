import { serve } from "@hono/node-server";
import { createApp, type Pricing } from "./app.js";
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

const sessionSecret = required("SESSION_SECRET");
if (sessionSecret.length < 32) fail("SESSION_SECRET moet minimaal 32 tekens zijn");

const providerName = process.env.PROVIDER ?? "mistral";
let provider: AiProvider;
let pricing: Pricing;

if (providerName === "stub") {
  // Alleen voor lokale ontwikkeling.
  provider = new StubProvider();
  pricing = { inputEurPerMTok: 0, outputEurPerMTok: 0 };
} else if (providerName === "mistral") {
  provider = new MistralProvider({
    apiKey: required("MISTRAL_API_KEY"),
    baseUrl: process.env.MISTRAL_BASE_URL,
    maxOutputTokens: process.env.MAX_OUTPUT_TOKENS ? Number(process.env.MAX_OUTPUT_TOKENS) : undefined,
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
  adminToken: required("ADMIN_TOKEN"),
  provider,
  pricing,
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`API luistert op http://127.0.0.1:${port} (provider: ${provider.name})`);
});
