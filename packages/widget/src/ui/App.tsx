import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, sendMessageStream, startConversation, type Session, type WidgetConfig } from "../api";
import { clearState, isSessionFresh, loadState, newId, saveState, type ChatMessage } from "../session";

export interface AppProps {
  config: WidgetConfig;
  apiBase: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function App({ config, apiBase, open, onOpenChange }: AppProps) {
  const stored = useRef(loadState(config.siteKey));

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const restored = stored.current.messages;
    if (restored.length > 0) return restored;
    // De begroeting is een UI-element: de API bewaart hem niet als bericht.
    return [{ id: newId(), role: "assistant", text: config.greeting }];
  });

  const [session, setSession] = useState<Session | null>(() => {
    const s = stored.current.session;
    return s && isSessionFresh(s.token) ? s : null;
  });

  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveState(config.siteKey, { session, messages });
  }, [config.siteKey, session, messages]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, open]);

  useEffect(() => {
    // Een lopende stream mag doorlopen als het paneel dichtgaat; bij unmount niet.
    return () => abortRef.current?.abort();
  }, []);

  async function ensureSession(force = false): Promise<Session> {
    if (!force && session && isSessionFresh(session.token)) return session;
    const fresh = await startConversation(apiBase, config.siteKey, location.href);
    setSession(fresh);
    return fresh;
  }

  async function deliver(text: string, assistantId: string, controller: AbortController): Promise<void> {
    const run = async (activeSession: Session) =>
      sendMessageStream({
        apiBase,
        conversationId: activeSession.conversationId,
        token: activeSession.token,
        text,
        signal: controller.signal,
        onDelta: (chunk) => {
          setMessages((prev) =>
            prev.map((m) => (m.id === assistantId ? { ...m, text: m.text + chunk } : m)),
          );
        },
      });

    let activeSession = await ensureSession();
    try {
      await run(activeSession);
    } catch (err) {
      // Token verlopen of gesprek onbekend: het bericht is dan nog niet opgeslagen, dus één keer
      // opnieuw met een vers gesprek is veilig.
      if (err instanceof ApiError && err.status === 401) {
        clearState(config.siteKey);
        activeSession = await ensureSession(true);
        await run(activeSession);
        return;
      }
      throw err;
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending) return;

    const controller = new AbortController();
    abortRef.current = controller;

    const assistantId = newId();
    setNotice(null);
    setInput("");
    setMessages((prev) => [...prev, { id: newId(), role: "user", text }, { id: assistantId, role: "assistant", text: "" }]);
    setSending(true);

    try {
      await deliver(text, assistantId, controller);
    } catch (err) {
      // Het lege antwoord weghalen; het gebruikersbericht blijft staan.
      setMessages((prev) => prev.filter((m) => !(m.id === assistantId && m.text === "")));
      const message = describeError(err);
      if (message) setNotice(message);
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onOpenChange(false);
    }
  }

  function onInputKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  }

  const lastIsStreaming = sending && messages[messages.length - 1]?.text === "";

  return (
    <div class={`al-root ${open ? "al-open" : "al-closed"}`}>
      {open ? (
        <section class="al-panel" role="dialog" aria-label="Chatassistent" onKeyDown={onKeyDown}>
          <header class="al-head">
            <div class="al-head-text">
              <span class="al-title">Assistent</span>
              {/* Verplichte melding: de bezoeker moet weten dat hij met een AI praat. */}
              <span class="al-subtitle">AI-assistent · antwoorden kunnen onjuist zijn</span>
            </div>
            <button class="al-close" type="button" aria-label="Sluiten" onClick={() => onOpenChange(false)}>
              ×
            </button>
          </header>

          <div class="al-log" role="log" aria-live="polite" aria-atomic="false" ref={logRef}>
            {messages.map((message, index) => {
              const busy = lastIsStreaming && index === messages.length - 1;
              return (
                <div key={message.id} class={`al-msg al-msg-${message.role}`}>
                  {busy ? <Dots /> : message.text}
                </div>
              );
            })}
          </div>

          {notice ? (
            <p class="al-notice" role="status">
              {notice}
            </p>
          ) : null}

          <form
            class="al-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <textarea
              class="al-input"
              ref={inputRef}
              rows={1}
              maxLength={2000}
              placeholder="Typ je bericht…"
              aria-label="Je bericht"
              value={input}
              disabled={sending}
              onInput={(event) => {
                const el = event.currentTarget;
                setInput(el.value);
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
              onKeyDown={onInputKeyDown}
            />
            <button class="al-send" type="submit" aria-label="Verstuur" disabled={sending || input.trim() === ""}>
              <SendIcon />
            </button>
          </form>
        </section>
      ) : (
        <button
          class="al-launcher"
          type="button"
          aria-label="Chat openen"
          aria-expanded="false"
          onClick={() => onOpenChange(true)}
        >
          <ChatIcon />
        </button>
      )}
    </div>
  );
}

function describeError(err: unknown): string | null {
  if (err instanceof DOMException && err.name === "AbortError") return null;
  if (!(err instanceof ApiError)) return "Er ging iets mis. Probeer het opnieuw.";

  switch (err.code) {
    case "budget_exceeded":
      return "De assistent is vandaag niet meer beschikbaar.";
    case "rate_limited":
      return "Het gaat te snel. Wacht even en probeer opnieuw.";
    case "origin_not_allowed":
      return "Deze site is niet gemachtigd voor de assistent.";
    case "not_found":
      return "De assistent is niet meer bereikbaar.";
    default:
      return "Er ging iets mis bij het ophalen van een antwoord.";
  }
}

function Dots() {
  return (
    <span class="al-dots" aria-label="De assistent typt">
      <span />
      <span />
      <span />
    </span>
  );
}

function ChatIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="m22 2-7 20-4-9-9-4 20-7Z"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}
