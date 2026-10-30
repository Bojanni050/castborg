import { useEffect, useRef, useState } from "preact/hooks";
import {
  ApiError,
  sendMessageStream,
  startConversation,
  submitLead,
  type Session,
  type WidgetConfig,
} from "../api";
import {
  emptyLeadDraft,
  shouldOfferLead,
  validateLead,
  type LeadDraft,
  type LeadFieldError,
} from "../lead";
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

  // Contactgegevens: één keer per gesprek. De server overschrijft bij een tweede inzending dezelfde rij.
  const [leadCaptured, setLeadCaptured] = useState<boolean>(() => stored.current.leadCaptured);
  const [leadOffered, setLeadOffered] = useState<boolean>(() => stored.current.leadOffered);
  const [leadOpen, setLeadOpen] = useState(false);
  const [lead, setLead] = useState<LeadDraft>(emptyLeadDraft);
  const [leadError, setLeadError] = useState<LeadFieldError | null>(null);
  const [leadSending, setLeadSending] = useState(false);
  /** De assistent is gestopt: dagbudget op of gesprekslimiet bereikt. Dan is doorgeven het enige dat nog werkt. */
  const [blocked, setBlocked] = useState(false);

  const logRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveState(config.siteKey, { session, messages, leadCaptured, leadOffered });
  }, [config.siteKey, session, messages, leadCaptured, leadOffered]);

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
      if (err instanceof ApiError && (err.code === "budget_exceeded" || err.code === "conversation_limit")) {
        setBlocked(true);
      }
      const message = describeError(err);
      if (message) setNotice(message);
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  async function sendLead(event: Event) {
    event.preventDefault();
    if (leadSending) return;

    const validated = validateLead(lead);
    if (!validated.ok) {
      setLeadError(validated.error);
      return;
    }
    setLeadError(null);
    setNotice(null);
    setLeadSending(true);

    try {
      const run = (active: Session) =>
        submitLead({
          apiBase,
          conversationId: active.conversationId,
          token: active.token,
          lead: validated.payload,
        });

      let activeSession = await ensureSession();
      try {
        await run(activeSession);
      } catch (err) {
        // Zelfde reden als bij een bericht: bij een 401 is er niets opgeslagen, dus één nieuwe poging is veilig.
        if (err instanceof ApiError && err.status === 401) {
          clearState(config.siteKey);
          activeSession = await ensureSession(true);
          await run(activeSession);
        } else {
          throw err;
        }
      }

      setLeadCaptured(true);
      setLeadOpen(false);
      setLead(emptyLeadDraft);
      setMessages((prev) => [
        ...prev,
        {
          id: newId(),
          role: "assistant",
          text: "Bedankt! Ik heb je gegevens doorgegeven; er wordt contact met je opgenomen.",
        },
      ]);
    } catch (err) {
      const message = describeError(err);
      setNotice(message ?? "Je gegevens konden niet worden verstuurd. Probeer het opnieuw.");
    } finally {
      setLeadSending(false);
    }
  }

  const userTurns = messages.filter((m) => m.role === "user").length;
  const leadDue = shouldOfferLead({ userTurns, leadCaptured, blocked, alreadyOffered: leadOffered });
  const showLead = !leadCaptured && (leadOpen || leadDue);
  /** "contact" betekent: geen van beide ingevuld, dus beide velden markeren. */
  const invalid = (field: LeadFieldError) =>
    leadError === field || (leadError === "contact" && (field === "email" || field === "phone"));

  useEffect(() => {
    // Openen én als aangeboden markeren: anders sluit de aanbieding zichzelf meteen weer, want
    // `alreadyOffered` zet `leadDue` op false. Sluiten doet de bezoeker met "Later".
    if (leadDue && !leadOpen) {
      setLeadOpen(true);
      setLeadOffered(true);
    }
  }, [leadDue, leadOpen]);

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

          {showLead ? (
            <form class="al-lead" onSubmit={sendLead} noValidate>
              <span class="al-lead-title">Contactgegevens</span>
              <span class="al-lead-hint">
                Laat je e-mailadres of telefoonnummer achter, dan neemt een medewerker contact op.
              </span>
              <input
                class="al-lead-input"
                type="text"
                placeholder="Naam"
                aria-label="Naam"
                maxLength={200}
                value={lead.name}
                onInput={(event) => setLead({ ...lead, name: event.currentTarget.value })}
              />
              <div class="al-lead-row">
                <input
                  class={`al-lead-input${invalid("email") ? " al-invalid" : ""}`}
                  type="email"
                  placeholder="E-mailadres"
                  aria-label="E-mailadres"
                  autoComplete="email"
                  maxLength={320}
                  value={lead.email}
                  onInput={(event) => setLead({ ...lead, email: event.currentTarget.value })}
                />
                <input
                  class={`al-lead-input${invalid("phone") ? " al-invalid" : ""}`}
                  type="tel"
                  placeholder="Telefoonnummer"
                  aria-label="Telefoonnummer"
                  autoComplete="tel"
                  maxLength={40}
                  value={lead.phone}
                  onInput={(event) => setLead({ ...lead, phone: event.currentTarget.value })}
                />
              </div>
              <textarea
                class="al-lead-input"
                rows={2}
                placeholder="Waar gaat het over? (optioneel)"
                aria-label="Waar gaat het over"
                maxLength={4000}
                value={lead.message}
                onInput={(event) => setLead({ ...lead, message: event.currentTarget.value })}
              />
              {leadError ? (
                <p class="al-lead-error" role="alert">
                  {leadErrorText(leadError)}
                </p>
              ) : null}
              <div class="al-lead-actions">
                <button class="al-lead-submit" type="submit" disabled={leadSending}>
                  {leadSending ? "Versturen…" : "Versturen"}
                </button>
                {blocked ? null : (
                  <button class="al-lead-skip" type="button" onClick={() => setLeadOpen(false)}>
                    Later
                  </button>
                )}
              </div>
            </form>
          ) : null}

          {!leadCaptured && !showLead ? (
            <p class="al-lead-invite">
              <button class="al-lead-link" type="button" onClick={() => setLeadOpen(true)}>
                Laat je contactgegevens achter
              </button>
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
              placeholder={blocked ? "Dit gesprek is afgelopen." : "Typ je bericht…"}
              aria-label="Je bericht"
              value={input}
              disabled={sending || blocked}
              onInput={(event) => {
                const el = event.currentTarget;
                setInput(el.value);
                el.style.height = "auto";
                el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
              }}
              onKeyDown={onInputKeyDown}
            />
            <button
              class="al-send"
              type="submit"
              aria-label="Verstuur"
              disabled={sending || blocked || input.trim() === ""}
            >
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

function leadErrorText(error: LeadFieldError): string {
  switch (error) {
    case "contact":
      return "Vul een e-mailadres of telefoonnummer in.";
    case "email":
      return "Dit e-mailadres lijkt niet te kloppen.";
    case "phone":
      return "Dit telefoonnummer lijkt niet te kloppen.";
  }
}

function describeError(err: unknown): string | null {
  if (err instanceof DOMException && err.name === "AbortError") return null;
  if (!(err instanceof ApiError)) return "Er ging iets mis. Probeer het opnieuw.";

  switch (err.code) {
    case "budget_exceeded":
      return "De assistent is vandaag niet meer beschikbaar.";
    case "conversation_limit":
      return "Dit gesprek is afgelopen. Laat je gegevens achter, dan nemen we contact op.";
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
