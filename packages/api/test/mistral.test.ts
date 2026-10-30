import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MistralProvider } from "../src/mistral.js";
import { ProviderError, type ProviderRequest, type StreamEvent } from "../src/provider.js";

/** Nep-Mistral-server: gedrag per test instelbaar. */
let server: Server;
let baseUrl: string;
let handler: (req: IncomingMessage, body: string, res: ServerResponse) => void;
let lastRequest: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body: body ? JSON.parse(body) : {} };
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  lastRequest = null;
});

const req: ProviderRequest = {
  systemPrompt: "Je bent behulpzaam.",
  model: "mistral-small-latest",
  history: [{ role: "user", content: "Hallo" }],
};

const provider = (over: Partial<ConstructorParameters<typeof MistralProvider>[0]> = {}) =>
  new MistralProvider({ apiKey: "sleutel-123", baseUrl, ...over });

async function collect(gen: AsyncGenerator<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const delta = (content: unknown) => sse({ choices: [{ delta: { content } }] });

describe("MistralProvider.complete", () => {
  it("stuurt een correcte aanvraag en leest tekst en usage", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "Dag!" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }));
    };
    const out = await provider().complete(req);
    expect(out).toEqual({ text: "Dag!", usage: { inputTokens: 12, outputTokens: 3, estimated: false } });

    expect(lastRequest!.headers.authorization).toBe("Bearer sleutel-123");
    expect(lastRequest!.body).toMatchObject({
      model: "mistral-small-latest",
      stream: false,
      max_tokens: 800,
      messages: [
        { role: "system", content: "Je bent behulpzaam." },
        { role: "user", content: "Hallo" },
      ],
    });
  });

  it("ondersteunt content als lijst van tekstdelen en schat usage als die ontbreekt", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: [{ type: "text", text: "Goe" }, { type: "text", text: "den dag" }] } }] }));
    };
    const out = await provider().complete(req);
    expect(out.text).toBe("Goeden dag");
    expect(out.usage.estimated).toBe(true);
    expect(out.usage.outputTokens).toBeGreaterThan(0);
  });

  it("laat de systeemprompt weg als die leeg is", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    };
    await provider().complete({ ...req, systemPrompt: "" });
    expect((lastRequest!.body.messages as { role: string }[]).map((m) => m.role)).toEqual(["user"]);
  });

  it("mapt 429 en 5xx op herstelbare fouten en 401 op niet-herstelbaar, zonder de sleutel te lekken", async () => {
    for (const [status, retryable] of [[429, true], [503, true], [401, false]] as const) {
      handler = (_r, _b, res) => {
        res.statusCode = status;
        res.end(JSON.stringify({ message: "nee" }));
      };
      const err = await provider().complete(req).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
      expect(err.message).not.toContain("sleutel-123");
    }
  });

  it("geeft een fout bij een leeg antwoord", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
    };
    await expect(provider().complete(req)).rejects.toThrow(/empty/);
  });

  it("breekt af na de timeout", async () => {
    handler = () => {
      /* reageert nooit */
    };
    const err = await provider({ timeoutMs: 150 }).complete(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("mistral_timeout");
  });

  it("breekt af als de aanroeper afbreekt", async () => {
    handler = () => {};
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 50);
    const err = await provider().complete(req, { signal: ctrl.signal }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });
});

describe("MistralProvider.stream", () => {
  it("levert deltas en sluit af met usage uit het laatste event", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(delta("Hal"));
      res.write(delta("lo "));
      res.write(delta("wereld"));
      res.write(sse({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      res.end("data: [DONE]\n\n");
    };
    const events = await collect(provider().stream(req));
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Hallo wereld");
    expect(events.at(-1)).toEqual({ type: "done", usage: { inputTokens: 20, outputTokens: 5, estimated: false } });
    expect(lastRequest!.body.stream).toBe(true);
  });

  it("verwerkt events die midden in een regel over meerdere netwerkpakketten zijn gesplitst, ook met CRLF", async () => {
    const full = delta("Eén") + delta(" twee") + "data: [DONE]\n\n";
    const crlf = full.replace(/\n/g, "\r\n");
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      // Splits in stukjes van 7 bytes, met een tikje vertraging zodat het echt aparte pakketten zijn
      const bytes = Buffer.from(crlf);
      let i = 0;
      const timer = setInterval(() => {
        if (i >= bytes.length) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(bytes.subarray(i, i + 7));
        i += 7;
      }, 1);
    };
    const events = await collect(provider().stream(req));
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Eén twee");
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { estimated: true } });
  });

  it("negeert onleesbare chunks, lege deltas en ondersteunt tekstdelen als lijst", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(": keep-alive\n\n");
      res.write("data: {kapot\n\n");
      res.write(delta(""));
      res.write(delta([{ type: "text", text: "Hoi" }]));
      res.end("data: [DONE]\n\n");
    };
    const events = await collect(provider().stream(req));
    expect(events.filter((e) => e.type === "delta")).toEqual([{ type: "delta", text: "Hoi" }]);
  });

  it("gooit een ProviderError bij een HTTP-fout vóór de stream begint", async () => {
    handler = (_r, _b, res) => {
      res.statusCode = 429;
      res.end("{}");
    };
    const err = await collect(provider().stream(req)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("gooit een fout als de stream geen enkele tekst bevat", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.end("data: [DONE]\n\n");
    };
    await expect(collect(provider().stream(req))).rejects.toThrow(/empty/);
  });

  it("stopt als de aanroeper afbreekt midden in de stream", async () => {
    handler = (_r, _b, res) => {
      res.setHeader("content-type", "text/event-stream");
      res.write(delta("begin"));
      // houdt de verbinding open
    };
    const ctrl = new AbortController();
    const seen: string[] = [];
    const err = await (async () => {
      try {
        for await (const e of provider().stream(req, { signal: ctrl.signal })) {
          if (e.type === "delta") {
            seen.push(e.text);
            ctrl.abort();
          }
        }
      } catch (e) {
        return e;
      }
    })();
    expect(seen).toEqual(["begin"]);
    expect(err).toBeInstanceOf(ProviderError);
  });
});
