import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ApiError, fetchConfig, type WidgetConfig } from "./api";
import { buildStyles } from "./styles";
import { App } from "./ui/App";

const HOST_ID = "ai-lead-widget";
const KEY_PATTERN = /^pk_[a-z0-9]{24}$/;

interface Options {
  siteKey: string;
  apiBase: string;
}

interface Controller {
  open: () => void;
  close: () => void;
}

let controller: Controller | null = null;

declare global {
  interface Window {
    AiLeadWidget?: Controller;
  }
}

function warn(message: string, detail?: unknown): void {
  if (detail === undefined) console.warn(`[ai-lead] ${message}`);
  else console.warn(`[ai-lead] ${message}`, detail);
}

function readOptions(): Options | null {
  // Bij een module-script is document.currentScript null; val dan terug op het eerste script met
  // een site-key. Dat is ook wat een sitebeheerder verwacht als hij het snippet plakt.
  const script =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>("script[data-site-key]");

  if (!script) {
    warn("geen <script data-site-key> gevonden");
    return null;
  }

  const siteKey = (script.dataset.siteKey ?? "").trim();
  if (!KEY_PATTERN.test(siteKey)) {
    warn("data-site-key ontbreekt of is geen geldige publieke sleutel (pk_...)");
    return null;
  }

  // Standaard dezelfde origin als waar widget.js vandaan komt: dan hoeft een site niets te weten
  // van de API-locatie. Met data-api-base kan hij afwijken (CDN, lokaal ontwikkelen).
  const explicit = (script.dataset.apiBase ?? "").trim();
  const fallback = script.src ? new URL(script.src).origin : location.origin;
  const apiBase = (explicit || fallback).replace(/\/+$/, "");

  return { siteKey, apiBase };
}

function describeConfigError(err: unknown, options: Options): string {
  if (err instanceof ApiError) {
    if (err.status === 404) return `onbekende site-key ${options.siteKey}`;
    if (err.code === "origin_not_allowed") {
      return `origin ${location.origin} staat niet bij de domeinen van deze site`;
    }
    if (err.status === 429) return "te veel configuratieverzoeken; de widget is niet gestart";
    return `configuratie ophalen mislukte (${err.status} ${err.code})`;
  }
  return `configuratie ophalen mislukte; is ${options.apiBase} bereikbaar?`;
}

function Root(props: { config: WidgetConfig; apiBase: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    controller = { open: () => setOpen(true), close: () => setOpen(false) };
    return () => {
      controller = null;
    };
  }, []);

  return <App config={props.config} apiBase={props.apiBase} open={open} onOpenChange={setOpen} />;
}

function mount(options: Options, config: WidgetConfig): void {
  if (document.getElementById(HOST_ID)) {
    warn("widget is al geladen op deze pagina");
    return;
  }

  const host = document.createElement("div");
  host.id = HOST_ID;

  // Shadow DOM: de stijlen van de site kunnen de widget niet raken, en andersom.
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = buildStyles(config.primaryColor, config.position);
  const container = document.createElement("div");

  shadow.append(style, container);
  document.body.appendChild(host);

  render(<Root config={config} apiBase={options.apiBase} />, container);
}

async function bootstrap(): Promise<void> {
  if (document.getElementById(HOST_ID)) {
    warn("widget is al geladen op deze pagina");
    return;
  }

  const options = readOptions();
  if (!options) return;

  try {
    const config = await fetchConfig(options.apiBase, options.siteKey);
    mount(options, config);
    window.AiLeadWidget = {
      open: () => controller?.open(),
      close: () => controller?.close(),
    };
  } catch (err) {
    // Geen knop tonen als de widget niet kan werken: een dode knop is erger dan geen knop.
    warn(describeConfigError(err, options), err);
  }
}

if (document.body) {
  void bootstrap();
} else {
  document.addEventListener("DOMContentLoaded", () => void bootstrap(), { once: true });
}
