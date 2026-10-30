import {
  ProviderError,
  estimateUsage,
  type AiProvider,
  type CallOptions,
  type ProviderRequest,
  type ProviderResponse,
  type StreamEvent,
  type Usage,
} from "./provider.js";

export interface MistralOptions {
  apiKey: string;
  /** Standaard de EU-productieserver. */
  baseUrl?: string;
  /** Totale tijd per aanroep, ook voor streams. */
  timeoutMs?: number;
  maxOutputTokens?: number;
  temperature?: number;
  fetchImpl?: typeof fetch;
}

interface MistralUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface MistralChunk {
  choices?: { delta?: { content?: unknown }; message?: { content?: unknown } }[];
  usage?: MistralUsage | null;
}

/** Content is een string, of (bij nieuwere modellen) een lijst delen met {type:"text", text}. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function toUsage(u: MistralUsage | null | undefined): Usage | null {
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") return null;
  return { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, estimated: false };
}

export class MistralProvider implements AiProvider {
  readonly name = "mistral";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly temperature: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: MistralOptions) {
    if (!opts.apiKey) throw new Error("MistralProvider: apiKey ontbreekt");
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.mistral.ai").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxOutputTokens = opts.maxOutputTokens ?? 800;
    this.temperature = opts.temperature ?? 0.3;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private body(req: ProviderRequest, stream: boolean): string {
    const messages = [
      ...(req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : []),
      ...req.history.map((t) => ({ role: t.role, content: t.content })),
    ];
    return JSON.stringify({
      model: req.model,
      messages,
      max_tokens: this.maxOutputTokens,
      temperature: this.temperature,
      stream,
    });
  }

  private async post(req: ProviderRequest, stream: boolean, opts?: CallOptions): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = opts?.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: stream ? "text/event-stream" : "application/json",
        },
        body: this.body(req, stream),
        signal,
      });
    } catch (err) {
      const timedOut = timeout.aborted;
      throw new ProviderError(timedOut ? "mistral_timeout" : "mistral_network", {
        retryable: !opts?.signal?.aborted,
        detail: (err as Error).message,
      });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(`mistral_http_${res.status}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        detail,
      });
    }
    return res;
  }

  async complete(req: ProviderRequest, opts?: CallOptions): Promise<ProviderResponse> {
    const res = await this.post(req, false, opts);
    let json: MistralChunk;
    try {
      json = (await res.json()) as MistralChunk;
    } catch {
      throw new ProviderError("mistral_bad_response");
    }
    const text = contentToText(json.choices?.[0]?.message?.content);
    if (!text) throw new ProviderError("mistral_empty_response");
    return { text, usage: toUsage(json.usage) ?? estimateUsage(req, text) };
  }

  async *stream(req: ProviderRequest, opts?: CallOptions): AsyncGenerator<StreamEvent> {
    const res = await this.post(req, true, opts);
    if (!res.body) throw new ProviderError("mistral_no_body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let usage: Usage | null = null;
    let finished = false;

    // Verwerkt één SSE-event (de regels tussen twee lege regels).
    const parse = (raw: string): { delta?: string; done?: boolean } => {
      const data = raw
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) return {};
      if (data === "[DONE]") return { done: true };
      let chunk: MistralChunk;
      try {
        chunk = JSON.parse(data) as MistralChunk;
      } catch {
        return {}; // onleesbaar of onvolledig chunk negeren
      }
      usage = toUsage(chunk.usage) ?? usage;
      const delta = contentToText(chunk.choices?.[0]?.delta?.content);
      return delta ? { delta } : {};
    };

    try {
      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const m = /\r?\n\r?\n/.exec(buffer);
          if (!m) break;
          const raw = buffer.slice(0, m.index);
          buffer = buffer.slice(m.index + m[0].length);
          const ev = parse(raw);
          if (ev.delta) {
            full += ev.delta;
            yield { type: "delta", text: ev.delta };
          }
          if (ev.done) {
            finished = true;
            break outer;
          }
        }
      }
      if (!finished && buffer.trim()) {
        const ev = parse(buffer);
        if (ev.delta) {
          full += ev.delta;
          yield { type: "delta", text: ev.delta };
        }
      }
    } catch (err) {
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(opts?.signal?.aborted ? "mistral_aborted" : "mistral_stream_error", {
        retryable: false,
        detail: (err as Error).message,
      });
    } finally {
      reader.cancel().catch(() => {});
    }

    if (!full) throw new ProviderError("mistral_empty_response");
    yield { type: "done", usage: usage ?? estimateUsage(req, full) };
  }
}
