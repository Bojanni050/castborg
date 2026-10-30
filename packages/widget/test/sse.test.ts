import { describe, expect, it } from "vitest";
import { createSseParser } from "../src/sse";

describe("sse-parser", () => {
  it("leest één event uit één chunk", () => {
    const parse = createSseParser();
    expect(parse('event: delta\ndata: {"text":"Hoi"}\n\n')).toEqual([
      { event: "delta", data: '{"text":"Hoi"}' },
    ]);
  });

  it("leest meerdere events uit één chunk", () => {
    const parse = createSseParser();
    const events = parse('event: delta\ndata: {"text":"a"}\n\nevent: delta\ndata: {"text":"b"}\n\n');
    expect(events.map((e) => JSON.parse(e.data).text)).toEqual(["a", "b"]);
  });

  it("houdt een half event vast tot de volgende chunk", () => {
    const parse = createSseParser();
    expect(parse('event: delta\ndata: {"te')).toEqual([]);
    expect(parse('xt":"Hoi"}\n\n')).toEqual([{ event: "delta", data: '{"text":"Hoi"}' }]);
  });

  it("overleeft een chunkgrens midden in de lege regel", () => {
    const parse = createSseParser();
    expect(parse('event: delta\ndata: x\n')).toEqual([]);
    expect(parse("\n")).toEqual([{ event: "delta", data: "x" }]);
  });

  it("normaliseert CRLF, ook als de chunkgrens midden in een \\r\\n valt", () => {
    const parse = createSseParser();
    // De chunk eindigt op een losse \r; pas bij de volgende chunk wordt het een \r\n.
    expect(parse("event: done\r")).toEqual([]);
    expect(parse('\ndata: {"messageId":null}\r\n\r\n')).toEqual([
      { event: "done", data: '{"messageId":null}' },
    ]);
  });

  it("negeert commentaarregels en lege blokken", () => {
    const parse = createSseParser();
    expect(parse(": keep-alive\n\n")).toEqual([]);
    expect(parse("event: delta\ndata: x\n\n\n\n")).toEqual([{ event: "delta", data: "x" }]);
  });

  it("voegt meerdere dataregels samen met een newline", () => {
    const parse = createSseParser();
    expect(parse("event: note\ndata: regel 1\ndata: regel 2\n\n")).toEqual([
      { event: "note", data: "regel 1\nregel 2" },
    ]);
  });

  it("valt terug op de eventnaam 'message' zonder event-regel", () => {
    const parse = createSseParser();
    expect(parse("data: los\n\n")).toEqual([{ event: "message", data: "los" }]);
  });

  it("levert niets op voor een blok zonder data", () => {
    const parse = createSseParser();
    expect(parse("event: ping\n\n")).toEqual([]);
  });

  it("bewaart de volgorde over veel kleine chunks", () => {
    const parse = createSseParser();
    const stream = 'event: delta\ndata: {"text":"1"}\n\nevent: delta\ndata: {"text":"2"}\n\n';
    const seen: string[] = [];
    for (const char of stream) seen.push(...parse(char).map((e) => e.data));
    expect(seen).toEqual(['{"text":"1"}', '{"text":"2"}']);
  });
});
