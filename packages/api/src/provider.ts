export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderRequest {
  systemPrompt: string;
  history: ChatTurn[];
  model: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** true als de provider geen cijfers gaf en het aantal tokens is geschat */
  estimated: boolean;
}

export interface ProviderResponse {
  text: string;
  usage: Usage;
}

export type StreamEvent = { type: "delta"; text: string } | { type: "done"; usage: Usage };

export interface CallOptions {
  /** Afbreken bij bijv. een weggevallen client. */
  signal?: AbortSignal;
}

/** Uniforme interface; de rest van de applicatie kent geen providerspecifieke details. */
export interface AiProvider {
  readonly name: string;
  complete(req: ProviderRequest, opts?: CallOptions): Promise<ProviderResponse>;
  stream(req: ProviderRequest, opts?: CallOptions): AsyncGenerator<StreamEvent>;
}

export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  /** Alleen voor logging; nooit naar de bezoeker sturen. */
  readonly detail?: string;

  constructor(message: string, init: { status?: number; retryable?: boolean; detail?: string } = {}) {
    super(message);
    this.name = "ProviderError";
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
  }
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

/** Grove schatting van het aantal inputtokens, gebruikt voor de budgetreservering vóór de call. */
export function estimateInputTokens(text: string): number {
  return approxTokens(text);
}

/** Grove schatting (±4 tekens per token), alleen als terugval wanneer de provider geen usage meegeeft. */
export function estimateUsage(req: ProviderRequest, reply: string): Usage {
  const input = req.systemPrompt.length + req.history.reduce((n, t) => n + t.content.length, 0);
  return { inputTokens: Math.ceil(input / 4), outputTokens: approxTokens(reply), estimated: true };
}

/** Deterministische stub voor ontwikkeling en tests, zonder externe API. */
export class StubProvider implements AiProvider {
  readonly name = "stub";
  private readonly streamDelayMs: number;

  /** delayMs vertraagt elke delta, zodat je het streamen in de widget kunt zien zonder echte provider. */
  constructor(opts: { delayMs?: number } = {}) {
    this.streamDelayMs = opts.delayMs ?? 0;
  }

  async complete(req: ProviderRequest): Promise<ProviderResponse> {
    const last = req.history[req.history.length - 1]?.content ?? "";
    const text = `(stub) Je schreef: ${last}`;
    return { text, usage: { inputTokens: 0, outputTokens: 0, estimated: false } };
  }

  async *stream(req: ProviderRequest): AsyncGenerator<StreamEvent> {
    const { text, usage } = await this.complete(req);
    for (const word of text.split(/(?<= )/)) {
      if (this.streamDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.streamDelayMs));
      yield { type: "delta", text: word };
    }
    yield { type: "done", usage };
  }
}
