/**
 * Alles wat het dashboard van de API nodig heeft, op één plek.
 *
 * De sessie zit in een HttpOnly-cookie; die gaat automatisch mee (`credentials: "include"`). Er is
 * dus geen token in JavaScript en dus ook niets dat een XSS kan stelen.
 */

export interface Actor {
  type: "user" | "admin_token";
  id: string;
}

export interface SiteSettings {
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
}

export interface SiteState {
  id: string;
  name: string;
  publicKey: string;
  domains: string[];
  settings: SiteSettings;
}

export interface SiteSummary {
  id: string;
  name: string;
  publicKey: string;
  domains: string[];
  createdAt: string;
  leadCount: number;
  conversationCount: number;
}

/** De historie-route geeft de kolommen zoals ze in de tabel staan; dat is hier bewust zichtbaar. */
export interface HistoryRow {
  id: string;
  changed_at: string;
  actor_type: string;
  actor_id: string;
  changed_fields: string[];
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

export interface LeadRow {
  id: string;
  conversationId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  message: string | null;
  status: string;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  leadCount: number;
  /** Eerste bezoekersbericht, afgekapt. Zonder dit is een lijst met tijdstippen niet te beoordelen. */
  preview: string | null;
}

export interface DeletionRow {
  id: string;
  ranAt: string;
  source: "manual" | "retention";
  subject: "conversation" | "lead";
  conversations: number;
  messages: number;
  leads: number;
  actorType: string;
  actorId: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`);
  }
}

async function readError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return new ApiError(res.status, typeof body.error === "string" ? body.error : "unknown");
  } catch {
    return new ApiError(res.status, "unknown");
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "include",
    headers: init.body === undefined ? undefined : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

export const api = {
  me: () => request<{ actor: Actor; modelOverride: string | null }>("/api/v1/dashboard/me"),
  login: (password: string) =>
    request<{ actor: Actor; modelOverride: string | null }>("/api/v1/dashboard/login", {
      method: "POST",
      body: { password },
    }),
  logout: () => request<{ ok: true }>("/api/v1/dashboard/logout", { method: "POST" }),
  sites: () => request<{ sites: SiteSummary[] }>("/api/v1/dashboard/sites"),
  site: (id: string) => request<SiteState>(`/api/v1/admin/sites/${id}`),
  updateSite: (id: string, input: Record<string, unknown>) =>
    request<SiteState>(`/api/v1/admin/sites/${id}`, { method: "PATCH", body: input }),
  createSite: (input: Record<string, unknown>) =>
    request<SiteState>("/api/v1/admin/sites", { method: "POST", body: input }),
  history: (id: string, limit = 50) => request<{ history: HistoryRow[] }>(`/api/v1/admin/sites/${id}/history?limit=${limit}`),
  restore: (id: string, historyId: string) =>
    request<SiteState>(`/api/v1/admin/sites/${id}/history/${historyId}/restore`, { method: "POST" }),
  leads: (id: string, limit = 50) => request<{ leads: LeadRow[] }>(`/api/v1/admin/sites/${id}/leads?limit=${limit}`),
  conversations: (id: string, limit = 50) =>
    request<{ conversations: ConversationRow[] }>(`/api/v1/admin/sites/${id}/conversations?limit=${limit}`),
  deleteConversation: (id: string, conversationId: string) =>
    request<{ deleted: { conversations: number; messages: number; leads: number; leadsDetached: number } }>(
      `/api/v1/admin/sites/${id}/conversations/${conversationId}`,
      { method: "DELETE" },
    ),
  deleteLead: (id: string, leadId: string) =>
    request<{ deleted: { conversations: number; messages: number; leads: number } }>(`/api/v1/admin/sites/${id}/leads/${leadId}`, {
      method: "DELETE",
    }),
  runRetention: (id: string) =>
    request<{ deleted: { conversations: number; messages: number; leads: number; conversationRetentionDays: number; leadRetentionDays: number } }>(
      `/api/v1/admin/sites/${id}/retention/run`,
      { method: "POST" },
    ),
  deletions: (id: string, limit = 50) =>
    request<{ deletions: DeletionRow[] }>(`/api/v1/admin/sites/${id}/deletions?limit=${limit}`),
};

/** Nederlandse tekst voor de fouten die de API echt teruggeeft. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case "unauthorized":
        return "Niet ingelogd of de sessie is verlopen.";
      case "invalid_input":
        return "De invoer klopt niet. Controleer de velden.";
      case "model_locked":
        return "Het model komt nu uit MISTRAL_MODEL in de omgeving en kan hier niet gewijzigd worden.";
      case "rate_limited":
        return "Te veel pogingen. Probeer het over een kwartier opnieuw.";
      case "not_found":
        return "Niet gevonden.";
      case "not_configured":
        return "Er is geen DASHBOARD_PASSWORD ingesteld in de omgeving.";
      default:
        return `Er ging iets mis (${err.status} ${err.code}).`;
    }
  }
  return "De server is niet bereikbaar.";
}
