// Kwaliteitsronde: stuurt een vaste set gesprekken door de echte assistent en
// schrijft de antwoorden naar een markdown-rapport, zodat promptwijzigingen
// vergelijkbaar worden in plaats van gevoel.
//
// Gebruik:
//   node scripts/kwaliteit.mjs --key pk_... [--api http://127.0.0.1:8787]
//   node scripts/kwaliteit.mjs --key pk_... --stream
//
// De vragen staan in kwaliteit-vragen.json. Elke case krijgt een eigen gesprek,
// want anders beïnvloeden ze elkaar.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const apiBase = String(arg("api", "http://127.0.0.1:8787")).replace(/\/+$/, "");
const siteKey = arg("key");
const useStream = arg("stream", false) === true;

if (typeof siteKey !== "string" || !/^pk_[a-z0-9]{24}$/.test(siteKey)) {
  console.error("Geef een publieke sleutel mee: --key pk_...");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(path.join(here, "kwaliteit-vragen.json"), "utf8"));

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function startConversation() {
  const res = await fetch(`${apiBase}/api/v1/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-site-key": siteKey },
    body: JSON.stringify({ pageUrl: "http://127.0.0.1:5173/" }),
  });
  if (!res.ok) throw new Error(`gesprek starten mislukte: ${res.status} ${await res.text()}`);
  return json(res);
}

async function ask({ conversationId, token }, text) {
  if (!useStream) {
    const res = await fetch(`${apiBase}/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ text }),
    });
    const body = await json(res);
    return { status: res.status, reply: body.reply ?? "", error: body.error, requestId: body.requestId };
  }

  const res = await fetch(`${apiBase}/api/v1/conversations/${conversationId}/messages/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
  });
  if (!res.body) return { status: res.status, reply: "", error: "geen stream" };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";
  let requestId;
  let error;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const lines = block.split("\n").filter(Boolean);
      const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      const parsed = JSON.parse(data);
      if (event === "delta") reply += parsed.text ?? "";
      else if (event === "done") requestId = parsed.requestId;
      else if (event === "error") error = parsed.error;
    }
  }

  return { status: res.status, reply, error, requestId };
}

const lines = [
  `# Kwaliteitsronde ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  "",
  `- site: \`${siteKey}\``,
  `- api: ${apiBase}`,
  `- modus: ${useStream ? "streaming" : "volledig antwoord"}`,
  `- cases: ${spec.cases.length}`,
  "",
];

for (const testCase of spec.cases) {
  lines.push(`## ${testCase.id}`, "", `_Waarom:_ ${testCase.why}`, "");
  let conversation;
  try {
    conversation = await startConversation();
  } catch (error) {
    lines.push(`**Gesprek starten mislukte:** ${error.message}`, "");
    continue;
  }

  for (const message of testCase.messages) {
    const started = Date.now();
    const result = await ask(conversation, message);
    const elapsed = Date.now() - started;
    lines.push(`**Bezoeker:** ${message}`, "");
    if (result.status !== 200 || result.error) {
      lines.push(`**Fout:** ${result.status} ${result.error ?? ""}`, "");
      continue;
    }
    lines.push(`**Assistent** (${elapsed} ms):`, "", result.reply.trim() || "_(leeg)_", "");
  }
}

const reportPath = path.join(
  process.env.TEMP ?? "/tmp",
  `castborg-kwaliteit-${new Date().toISOString().replace(/[:.]/g, "-")}.md`,
);
const report = lines.join("\n");
fs.writeFileSync(reportPath, report, "utf8");

console.log(report);
console.log(`\nRapport opgeslagen: ${reportPath}`);
