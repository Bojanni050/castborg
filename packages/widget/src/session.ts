import type { Session } from "./api";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface StoredState {
  session: Session | null;
  messages: ChatMessage[];
}

/** Bewust sessionStorage: een gesprek hoort bij dit tabblad, niet bij de bezoeker voor altijd. */
const PREFIX = "ai-lead:";
const MAX_STORED_MESSAGES = 40;

function keyFor(siteKey: string): string {
  return `${PREFIX}${siteKey}`;
}

export function loadState(siteKey: string): StoredState {
  const empty: StoredState = { session: null, messages: [] };
  try {
    const raw = sessionStorage.getItem(keyFor(siteKey));
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      session: isSession(parsed.session) ? parsed.session : null,
      messages: Array.isArray(parsed.messages) ? parsed.messages.filter(isMessage) : [],
    };
  } catch {
    // Kapotte of geblokkeerde opslag (privémodus) mag de widget nooit stukmaken.
    return empty;
  }
}

export function saveState(siteKey: string, state: StoredState): void {
  try {
    sessionStorage.setItem(
      keyFor(siteKey),
      JSON.stringify({
        session: state.session,
        messages: state.messages.slice(-MAX_STORED_MESSAGES),
      }),
    );
  } catch {
    /* opslag vol of geblokkeerd; het gesprek werkt gewoon door in het geheugen */
  }
}

export function clearState(siteKey: string): void {
  try {
    sessionStorage.removeItem(keyFor(siteKey));
  } catch {
    /* niets aan de hand */
  }
}

function isSession(value: unknown): value is Session {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<Session>;
  return typeof s.conversationId === "string" && typeof s.token === "string";
}

function isMessage(value: unknown): value is ChatMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<ChatMessage>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant") &&
    typeof m.text === "string"
  );
}

/**
 * Het sessietoken is een HMAC-token met een `exp`; de widget leest die alleen om te weten wanneer
 * hij een nieuw gesprek moet starten. De server verifieert altijd zelf, dus dit is een hint.
 */
export function isSessionFresh(token: string, now = Date.now()): boolean {
  const exp = readExpiry(token);
  if (exp === null) return false;
  // Kleine marge zodat een token niet precies onderweg verloopt.
  return exp * 1000 > now + 30_000;
}

function readExpiry(token: string): number | null {
  const payload = token.split(".")[0];
  if (!payload) return null;
  try {
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof parsed.exp === "number" ? parsed.exp : null;
  } catch {
    return null;
  }
}

let counter = 0;

export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}
