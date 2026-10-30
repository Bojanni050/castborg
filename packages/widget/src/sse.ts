/**
 * SSE-parser voor de stream van de API.
 *
 * Bewust zelf geschreven: `EventSource` kan geen POST doen en geen Authorization-header meesturen,
 * dus de stream moet via `fetch` + `ReadableStream` gelezen worden. Deze parser is stateful: een
 * chunk kan een halve regel, een halve event of meerdere events bevatten, en de rest blijft staan
 * tot de volgende chunk.
 */
export interface SseEvent {
  event: string;
  data: string;
}

export type SseParser = (chunk: string) => SseEvent[];

export function createSseParser(): SseParser {
  let buffer = "";

  return function parse(chunk: string): SseEvent[] {
    // Chunks kunnen midden in een \r\n grens vallen; normaliseren op de hele buffer is veilig
    // omdat het onvolledige \r\n pas bij de volgende aanroep compleet is.
    buffer = (buffer + chunk).replace(/\r\n/g, "\n");

    const events: SseEvent[] = [];
    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const event = parseBlock(raw);
      if (event) events.push(event);

      boundary = buffer.indexOf("\n\n");
    }

    return events;
  };
}

function parseBlock(raw: string): SseEvent | null {
  let name = "message";
  const data: string[] = [];

  for (const line of raw.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // lege regel of commentaar

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") name = value;
    else if (field === "data") data.push(value);
    // "id" en "retry" negeren we: de widget hervat geen verbinding.
  }

  if (data.length === 0) return null;
  return { event: name, data: data.join("\n") };
}
