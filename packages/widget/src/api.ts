import type { WidgetConfigResponse } from "@ai-lead/shared";
import { createSseParser } from "./sse";

/** De vorm komt uit @ai-lead/shared, zodat widget en API niet uit elkaar kunnen lopen. */
export type WidgetConfig = WidgetConfigResponse;

export interface Session {
  conversationId: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let code = "unknown";
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") code = body.error;
  } catch {
    /* geen JSON; status is dan de enige informatie */
  }
  return new ApiError(res.status, code);
}

export async function fetchConfig(apiBase: string, siteKey: string, signal?: AbortSignal): Promise<WidgetConfig> {
  const res = await fetch(`${apiBase}/api/v1/widget/config?key=${encodeURIComponent(siteKey)}`, {
    method: "GET",
    credentials: "omit",
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as WidgetConfig;
}

export async function startConversation(
  apiBase: string,
  siteKey: string,
  pageUrl: string,
  signal?: AbortSignal,
): Promise<Session> {
  const res = await fetch(`${apiBase}/api/v1/conversations`, {
    method: "POST",
    credentials: "omit",
    headers: { "content-type": "application/json", "x-site-key": siteKey },
    body: JSON.stringify({ pageUrl }),
    signal,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as Session;
}

export interface StreamArgs {
  apiBase: string;
  conversationId: string;
  token: string;
  text: string;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

/**
 * Stuurt één bericht en leest het antwoord streamend binnen.
 *
 * De API schrijft `delta`-events, dan één `done` of één `error`. Een fout vóór de stream komt als
 * HTTP-status terug; een fout tijdens de stream als `error`-event. Beide worden een ApiError, zodat
 * de UI één pad hoeft te kennen.
 */
export async function sendMessageStream(args: StreamArgs): Promise<{ requestId?: string }> {
  const res = await fetch(`${args.apiBase}/api/v1/conversations/${args.conversationId}/messages/stream`, {
    method: "POST",
    credentials: "omit",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${args.token}`,
    },
    body: JSON.stringify({ text: args.text }),
    signal: args.signal,
  });

  if (!res.ok) throw await toApiError(res);
  if (!res.body) throw new ApiError(0, "no_stream");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parse = createSseParser();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      for (const ev of parse(decoder.decode(value, { stream: true }))) {
        if (ev.event === "delta") {
          args.onDelta(readText(ev.data));
        } else if (ev.event === "done") {
          return readRequestId(ev.data);
        } else if (ev.event === "error") {
          throw new ApiError(502, readErrorCode(ev.data));
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {
      /* stream was al klaar */
    });
  }

  // Stream eindigde zonder done-event: het antwoord is niet bevestigd opgeslagen.
  throw new ApiError(0, "incomplete_stream");
}

function readText(data: string): string {
  try {
    const parsed = JSON.parse(data) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch {
    return "";
  }
}

function readRequestId(data: string): { requestId?: string } {
  try {
    const parsed = JSON.parse(data) as { requestId?: unknown };
    return typeof parsed.requestId === "string" ? { requestId: parsed.requestId } : {};
  } catch {
    return {};
  }
}

function readErrorCode(data: string): string {
  try {
    const parsed = JSON.parse(data) as { error?: unknown };
    return typeof parsed.error === "string" ? parsed.error : "provider_unavailable";
  } catch {
    return "provider_unavailable";
  }
}
