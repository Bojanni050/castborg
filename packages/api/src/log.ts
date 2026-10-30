import { ProviderError } from "./provider.js";

type Level = "info" | "warn" | "error";

/**
 * Eén regel JSON per event op stderr, zodat een logshipper het later kan lezen zonder parser
 * voor vrije tekst. Nooit bezoekertekst, prompts of tokens loggen: alleen identificaties.
 */
export function logEvent(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export interface ProviderLogContext {
  siteId: string;
  conversationId: string;
  provider: string;
  model: string;
  requestId?: string;
  durationMs?: number;
  /** Afwijkende eventnaam, bijvoorbeeld wanneer het opslaan zelf mislukt. */
  event?: string;
}

/** Maakt van een providerfout een bruikbare logregel: status, retryable en detail gingen eerder verloren. */
export function logProviderError(err: unknown, ctx: ProviderLogContext): void {
  const { event = "provider_error", ...fields } = ctx;
  const known = err instanceof ProviderError;
  logEvent("error", event, {
    ...fields,
    error: err instanceof Error ? err.message : String(err),
    status: known ? (err as ProviderError).status : undefined,
    retryable: known ? (err as ProviderError).retryable : undefined,
    detail: known ? (err as ProviderError).detail : undefined,
  });
}
