import { createHmac } from "node:crypto";
import { logEvent } from "./log.js";

/**
 * Een lead die niemand leest, is geen lead. Deze module stuurt hem door naar een URL die de
 * sitehouder zelf kiest (n8n, Zapier, Slack-incoming-webhook, eigen endpoint). Bewust géén
 * e-mailverzending: dat vraagt een providerkeuze, en dit werkt met alles wat HTTP kan ontvangen.
 */
export interface LeadWebhookConfig {
  url: string;
  /** Optioneel: HMAC-SHA256 over de body, in de header x-ai-lead-signature (formaat sha256=<hex>). */
  secret?: string;
  timeoutMs?: number;
}

export type LeadWebhookEvent = "lead.created" | "lead.updated";

export interface LeadWebhookPayload {
  event: LeadWebhookEvent;
  leadId: string;
  siteId: string;
  siteName: string;
  siteKey: string;
  conversationId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  receivedAt: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Stuurt de melding en slikt elke fout in: de bezoeker mag nooit merken dat een webhook stuk is.
 * De aanroeper wacht wel (kort) zodat het gedrag deterministisch is en een storing in het log staat
 * voordat het antwoord de deur uit gaat.
 */
export async function notifyLead(config: LeadWebhookConfig, payload: LeadWebhookPayload): Promise<void> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "ai-lead-webhook/1",
    "x-ai-lead-event": payload.event,
  };
  if (config.secret) {
    headers["x-ai-lead-signature"] = `sha256=${createHmac("sha256", config.secret).update(body).digest("hex")}`;
  }

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (res.ok) {
      logEvent("info", "lead_webhook_sent", { leadId: payload.leadId, event: payload.event, status: res.status });
    } else {
      logEvent("warn", "lead_webhook_failed", { leadId: payload.leadId, event: payload.event, status: res.status });
    }
  } catch (err) {
    // Timeout, DNS, geweigerde verbinding: nooit doorgooien, alleen vastleggen.
    logEvent("warn", "lead_webhook_failed", {
      leadId: payload.leadId,
      event: payload.event,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
