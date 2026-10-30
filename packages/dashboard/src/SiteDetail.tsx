import { useEffect, useState } from "preact/hooks";
import {
  api,
  describeError,
  type ConversationRow,
  type DeletionRow,
  type HistoryRow,
  type LeadRow,
  type SiteState,
} from "./api.js";

interface Props {
  id: string;
  modelOverride: string | null;
  onBack: () => void;
  onSessionLost: () => void;
}

interface Draft {
  name: string;
  domains: string;
  systemPrompt: string;
  greeting: string;
  openingQuestion: string;
  widgetPosition: string;
  primaryColor: string;
  model: string;
  dailyBudgetEur: string;
  maxMessagesPerConversation: string;
  timezone: string;
  conversationRetentionDays: string;
  leadRetentionDays: string;
}

function toDraft(site: SiteState): Draft {
  return {
    name: site.name,
    domains: site.domains.join(", "),
    systemPrompt: site.settings.systemPrompt,
    greeting: site.settings.greeting,
    openingQuestion: site.settings.openingQuestion ?? "",
    widgetPosition: site.settings.widgetPosition,
    primaryColor: site.settings.primaryColor,
    model: site.settings.model,
    dailyBudgetEur: String(site.settings.dailyBudgetEur),
    maxMessagesPerConversation: String(site.settings.maxMessagesPerConversation),
    timezone: site.settings.timezone,
    conversationRetentionDays: String(site.settings.conversationRetentionDays),
    leadRetentionDays: String(site.settings.leadRetentionDays),
  };
}

/**
 * Alleen wat echt veranderd is gaat mee. Dat is geen micro-optimalisatie: de historie schrijft één rij
 * per wijziging, dus een veld dat je niet hebt aangeraakt hoort daar niet in te staan.
 */
function buildPatch(draft: Draft, site: SiteState): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (draft.name.trim() !== site.name) patch.name = draft.name.trim();

  const domains = draft.domains
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  if (domains.join("|") !== site.domains.join("|")) patch.domains = domains;

  const s = site.settings;
  if (draft.systemPrompt !== s.systemPrompt) patch.systemPrompt = draft.systemPrompt;
  if (draft.greeting !== s.greeting) patch.greeting = draft.greeting;
  const openingQuestion = draft.openingQuestion.trim() === "" ? null : draft.openingQuestion;
  if (openingQuestion !== s.openingQuestion) patch.openingQuestion = openingQuestion;
  if (draft.widgetPosition !== s.widgetPosition) patch.widgetPosition = draft.widgetPosition;
  if (draft.primaryColor !== s.primaryColor) patch.primaryColor = draft.primaryColor;
  if (draft.model !== s.model) patch.model = draft.model;

  const budget = Number(draft.dailyBudgetEur.replace(",", "."));
  if (Number.isFinite(budget) && budget !== s.dailyBudgetEur) patch.dailyBudgetEur = budget;
  const maxMessages = Number(draft.maxMessagesPerConversation);
  if (Number.isInteger(maxMessages) && maxMessages !== s.maxMessagesPerConversation) {
    patch.maxMessagesPerConversation = maxMessages;
  }
  if (draft.timezone !== s.timezone) patch.timezone = draft.timezone;

  const convDays = Number(draft.conversationRetentionDays);
  if (Number.isInteger(convDays) && convDays !== s.conversationRetentionDays) patch.conversationRetentionDays = convDays;
  const leadDays = Number(draft.leadRetentionDays);
  if (Number.isInteger(leadDays) && leadDays !== s.leadRetentionDays) patch.leadRetentionDays = leadDays;

  return patch;
}

const FIELD_NAMES: Record<string, string> = {
  system_prompt: "prompt",
  greeting: "begroeting",
  opening_question: "openingsvraag",
  widget_position: "positie",
  primary_color: "kleur",
  model: "model",
  daily_budget_eur: "dagbudget",
  max_messages_per_conversation: "berichtlimiet",
  timezone: "tijdzone",
  conversation_retention_days: "bewaartermijn gesprekken",
  lead_retention_days: "bewaartermijn leads",
  name: "naam",
};

export function SiteDetail({ id, modelOverride, onBack, onSessionLost }: Props) {
  const [site, setSite] = useState<SiteState | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [leads, setLeads] = useState<LeadRow[]>([]);
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [deletions, setDeletions] = useState<DeletionRow[]>([]);
  /** Id van de rij die op bevestiging wacht. Verwijderen is niet terug te draaien, dus geen eenklikactie. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    load();
  }, [id]);

  function handleAuth(err: unknown): boolean {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) {
      onSessionLost();
      return true;
    }
    return false;
  }

  async function load() {
    try {
      const [state, hist, leadList, convList, deletionList] = await Promise.all([
        api.site(id),
        api.history(id),
        api.leads(id),
        api.conversations(id),
        api.deletions(id),
      ]);
      setSite(state);
      setDraft(toDraft(state));
      setHistory(hist.history);
      setLeads(leadList.leads);
      setConversations(convList.conversations);
      setDeletions(deletionList.deletions);
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    }
  }

  /** Na een verwijdering alleen de lijsten verversen: het formulier niet, want dat zou onopgeslagen werk wissen. */
  async function refreshLists() {
    const [leadList, convList, deletionList] = await Promise.all([api.leads(id), api.conversations(id), api.deletions(id)]);
    setLeads(leadList.leads);
    setConversations(convList.conversations);
    setDeletions(deletionList.deletions);
  }

  async function removeConversation(row: ConversationRow) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await api.deleteConversation(id, row.id);
      const detached = res.deleted.leadsDetached > 0 ? ` ${res.deleted.leadsDetached} lead(s) blijven staan zonder gesprek.` : "";
      setOk(`Gesprek verwijderd: ${res.deleted.messages} berichten.${detached}`);
      setPending(null);
      await refreshLists();
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeLead(lead: LeadRow) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      await api.deleteLead(id, lead.id);
      setOk("Lead verwijderd.");
      setPending(null);
      await refreshLists();
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function purge() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const res = await api.runRetention(id);
      setOk(
        `Opgeruimd: ${res.deleted.conversations} gesprekken, ${res.deleted.messages} berichten, ${res.deleted.leads} leads.`,
      );
      await refreshLists();
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  function set<K extends keyof Draft>(key: K, value: string) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  async function save(event: Event) {
    event.preventDefault();
    if (!site || !draft || busy) return;
    const patch = buildPatch(draft, site);
    if (Object.keys(patch).length === 0) {
      setOk("Niets gewijzigd.");
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const updated = await api.updateSite(id, patch);
      setSite(updated);
      setDraft(toDraft(updated));
      setHistory((await api.history(id)).history);
      setOk("Opgeslagen.");
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function restore(row: HistoryRow) {
    if (!site || busy) return;
    setBusy(true);
    setError(null);
    setOk(null);
    try {
      const updated = await api.restore(id, row.id);
      setSite(updated);
      setDraft(toDraft(updated));
      setHistory((await api.history(id)).history);
      setOk("Stand teruggezet. De oude waarde staat weer in het formulier en is als nieuwe wijziging opgeslagen.");
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!site) return;
    try {
      await navigator.clipboard.writeText(site.publicKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Kopiëren lukte niet; selecteer de sleutel en kopieer hem zelf.");
    }
  }

  if (!site || !draft) {
    return (
      <>
        <button class="ghost" onClick={onBack}>
          ← Terug
        </button>
        {error ? (
          <div class="notice error" role="alert">
            {error}
          </div>
        ) : (
          <p class="empty">Laden…</p>
        )}
      </>
    );
  }

  const dirty = Object.keys(buildPatch(draft, site)).length > 0;

  return (
    <>
      <div class="detail-head">
        <button class="ghost" onClick={onBack}>
          ← Terug
        </button>
        <div>
          <h1>{site.name}</h1>
          <div class="site-meta">
            {site.settings.provider} · {site.settings.model} · {site.settings.timezone}
          </div>
        </div>
      </div>

      <div class="keybox">
        <span>Publieke sleutel</span>
        <code>{site.publicKey}</code>
        <div class="spacer" />
        <button class="ghost" onClick={copyKey}>
          {copied ? "Gekopieerd" : "Kopiëren"}
        </button>
      </div>

      {error && (
        <div class="notice error" role="alert">
          {error}
        </div>
      )}
      {ok && (
        <div class="notice ok" role="status">
          {ok}
        </div>
      )}

      <form onSubmit={save}>
        <div class="section">
          <h2>Assistent</h2>
          <div class="field">
            <label for="prompt">Prompt</label>
            <textarea
              id="prompt"
              class="prompt"
              spellcheck={false}
              value={draft.systemPrompt}
              onInput={(e) => set("systemPrompt", (e.target as HTMLTextAreaElement).value)}
            />
            <p class="hint">
              {"{{siteName}}"} wordt vervangen door de sitenaam. Schrijf hier wat het bedrijf doet: zonder die
              informatie kan de assistent alleen zeggen dat hij het niet weet.
            </p>
          </div>
          <div class="row">
            <div class="field">
              <label for="greeting">Begroeting</label>
              <input
                id="greeting"
                type="text"
                value={draft.greeting}
                onInput={(e) => set("greeting", (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="opening">Openingsvraag (optioneel)</label>
              <input
                id="opening"
                type="text"
                value={draft.openingQuestion}
                onInput={(e) => set("openingQuestion", (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
        </div>

        <div class="section">
          <h2>Grenzen</h2>
          <div class="row">
            <div class="field">
              <label for="budget">Dagbudget (€)</label>
              <input
                id="budget"
                type="number"
                min="0"
                step="0.5"
                value={draft.dailyBudgetEur}
                onInput={(e) => set("dailyBudgetEur", (e.target as HTMLInputElement).value)}
              />
              <p class="hint">Een beurt reserveert zijn worst case vooraf. Staat dit onder één beurt, dan blokkeert alles.</p>
            </div>
            <div class="field">
              <label for="maxmsg">Max. berichten per gesprek</label>
              <input
                id="maxmsg"
                type="number"
                min="2"
                max="200"
                value={draft.maxMessagesPerConversation}
                onInput={(e) => set("maxMessagesPerConversation", (e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="model">Model</label>
              <input
                id="model"
                type="text"
                value={modelOverride ?? draft.model}
                disabled={modelOverride !== null}
                onInput={(e) => set("model", (e.target as HTMLInputElement).value)}
              />
              {modelOverride !== null && (
                <p class="hint">Komt nu uit MISTRAL_MODEL in de omgeving; haal die variabele weg om het per site te zetten.</p>
              )}
            </div>
            <div class="field">
              <label for="tz">Tijdzone</label>
              <input
                id="tz"
                type="text"
                value={draft.timezone}
                onInput={(e) => set("timezone", (e.target as HTMLInputElement).value)}
              />
              <p class="hint">Bepaalt wanneer de dag van het budget begint.</p>
            </div>
          </div>
          <div class="row">
            <div class="field">
              <label for="retconv">Bewaartermijn gesprekken (dagen)</label>
              <input
                id="retconv"
                type="number"
                min="0"
                max="3650"
                value={draft.conversationRetentionDays}
                onInput={(e) => set("conversationRetentionDays", (e.target as HTMLInputElement).value)}
              />
              <p class={Number(draft.conversationRetentionDays) === 0 ? "hint warn" : "hint"}>
                {Number(draft.conversationRetentionDays) === 0
                  ? "0: nooit automatisch opruimen. Alles blijft tot je het zelf weghaalt."
                  : "Gesprekken zonder activiteit worden na deze termijn verwijderd, met alle berichten."}
              </p>
            </div>
            <div class="field">
              <label for="retlead">Bewaartermijn leads (dagen)</label>
              <input
                id="retlead"
                type="number"
                min="0"
                max="3650"
                value={draft.leadRetentionDays}
                onInput={(e) => set("leadRetentionDays", (e.target as HTMLInputElement).value)}
              />
              <p class={Number(draft.leadRetentionDays) === 0 ? "hint warn" : "hint"}>
                {Number(draft.leadRetentionDays) === 0
                  ? "0: nooit automatisch opruimen."
                  : "Contactgegevens verdwijnen na deze termijn, ook als het gesprek blijft."}
              </p>
            </div>
          </div>
        </div>

        <div class="section">
          <h2>Widget</h2>
          <div class="row">
            <div class="field">
              <label for="domains">Domeinen</label>
              <input
                id="domains"
                type="text"
                value={draft.domains}
                onInput={(e) => set("domains", (e.target as HTMLInputElement).value)}
              />
              <p class="hint">Komma's. De widget laadt alleen op deze domeinen; anderen krijgen 403.</p>
            </div>
            <div class="field">
              <label for="color">Kleur</label>
              <input
                id="color"
                type="color"
                value={draft.primaryColor}
                onInput={(e) => set("primaryColor", (e.target as HTMLInputElement).value)}
              />
            </div>
            <div class="field">
              <label for="position">Positie</label>
              <select
                id="position"
                value={draft.widgetPosition}
                onChange={(e) => set("widgetPosition", (e.target as HTMLSelectElement).value)}
              >
                <option value="bottom-right">Rechtsonder</option>
                <option value="bottom-left">Linksonder</option>
              </select>
            </div>
          </div>
        </div>

        <div class="section">
          <h2>Naam</h2>
          <div class="field">
            <label for="name">Sitenaam</label>
            <input id="name" type="text" value={draft.name} onInput={(e) => set("name", (e.target as HTMLInputElement).value)} />
          </div>
        </div>

        <div class="actions">
          <button class="primary" type="submit" disabled={busy || !dirty}>
            {busy ? "Bezig…" : "Opslaan"}
          </button>
          <button type="button" class="ghost" disabled={busy || !dirty} onClick={() => setDraft(toDraft(site))}>
            Wijzigingen weggooien
          </button>
        </div>
      </form>

      <div class="section" style="margin-top:16px">
        <h2>Gesprekken</h2>
        <p class="hint">
          Het gesprek verdwijnt met alle berichten. Een lead blijft staan, maar raakt zijn gesprek kwijt; de
          kostenadministratie blijft kloppen.
        </p>
        {conversations.length === 0 ? (
          <p class="empty">Nog geen gesprekken.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Laatst actief</th>
                <th>Eerste bericht</th>
                <th>Berichten</th>
                <th>Lead</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {conversations.map((row) => (
                <tr key={row.id}>
                  <td class="site-meta">{when(row.updatedAt)}</td>
                  <td class="lead-msg">{row.preview ?? "—"}</td>
                  <td>{row.messageCount}</td>
                  <td>{row.leadCount > 0 ? <span class="pill">{row.leadCount}</span> : "—"}</td>
                  <td class="nowrap">
                    {pending === row.id ? (
                      <>
                        <button class="danger" type="button" disabled={busy} onClick={() => removeConversation(row)}>
                          Zeker weten
                        </button>
                        <button class="ghost" type="button" disabled={busy} onClick={() => setPending(null)}>
                          Nee
                        </button>
                      </>
                    ) : (
                      <button class="ghost" type="button" disabled={busy} onClick={() => setPending(row.id)}>
                        Verwijderen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="section">
        <h2>Leads</h2>
        {leads.length === 0 ? (
          <p class="empty">Nog geen leads.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Wanneer</th>
                <th>Naam</th>
                <th>Contact</th>
                <th>Bericht</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr key={lead.id}>
                  <td class="site-meta">{when(lead.createdAt)}</td>
                  <td>{lead.name ?? "—"}</td>
                  <td>
                    {lead.email && <div>{lead.email}</div>}
                    {lead.phone && <div class="site-meta">{lead.phone}</div>}
                    {!lead.email && !lead.phone && "—"}
                  </td>
                  <td class="lead-msg">{lead.message ?? "—"}</td>
                  <td>
                    <span class="pill">{lead.status}</span>
                  </td>
                  <td class="nowrap">
                    {pending === lead.id ? (
                      <>
                        <button class="danger" type="button" disabled={busy} onClick={() => removeLead(lead)}>
                          Zeker weten
                        </button>
                        <button class="ghost" type="button" disabled={busy} onClick={() => setPending(null)}>
                          Nee
                        </button>
                      </>
                    ) : (
                      <button class="ghost" type="button" disabled={busy} onClick={() => setPending(lead.id)}>
                        Verwijderen
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div class="section">
        <h2>Historie</h2>
        {history.length === 0 ? (
          <p class="empty">Nog geen wijzigingen.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Wanneer</th>
                <th>Wie</th>
                <th>Wat</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id}>
                  <td class="site-meta">{when(row.changed_at)}</td>
                  <td class="site-meta">
                    {row.actor_type} · {row.actor_id}
                  </td>
                  <td class="hist-what">
                    {describeRow(row)}
                    <span class="hist-diff">{summarize(row)}</span>
                  </td>
                  <td>
                    <button class="ghost" type="button" disabled={busy} onClick={() => restore(row)}>
                      Terugzetten
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div class="section">
        <h2>Verwijderd</h2>
        <p class="hint">
          Wat er is weggegooid, met aantallen en zonder inhoud. Automatisch opruimen draait via
          <code> pnpm retention</code> (cron op de server); met de knop hieronder doe je hetzelfde nu.
        </p>
        <div class="actions" style="margin: 8px 0 12px">
          <button class="ghost" type="button" disabled={busy} onClick={purge}>
            Nu opruimen volgens de termijnen
          </button>
        </div>
        {deletions.length === 0 ? (
          <p class="empty">Nog niets verwijderd.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Wanneer</th>
                <th>Hoe</th>
                <th>Wat</th>
                <th>Aantal</th>
                <th>Wie</th>
              </tr>
            </thead>
            <tbody>
              {deletions.map((row) => (
                <tr key={row.id}>
                  <td class="site-meta">{when(row.ranAt)}</td>
                  <td>{row.source === "retention" ? "automatisch" : "handmatig"}</td>
                  <td>{row.subject === "conversation" ? "gesprekken" : "leads"}</td>
                  <td>
                    {row.subject === "conversation"
                      ? `${row.conversations} gesprekken, ${row.messages} berichten`
                      : `${row.leads} leads`}
                  </td>
                  <td class="site-meta">
                    {row.actorType} · {row.actorId}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
}

/** Een rij die bij het aanmaken ontstaat heeft geen 'before'; die noemen we geen wijziging. */
function isCreation(row: HistoryRow): boolean {
  return Object.keys(row.before).length === 0;
}

function describeRow(row: HistoryRow): string {
  if (isCreation(row)) return "aangemaakt";
  const fields = row.changed_fields.filter((f) => f in FIELD_NAMES);
  if (fields.length === 0) return "gewijzigd";
  return fields.map((f) => FIELD_NAMES[f] ?? f).join(", ");
}

/**
 * Eén regel per gewijzigd veld: "prompt: oud → nieuw", afgekapt zodat de tabel leesbaar blijft.
 * Velden die het dashboard niet kent (zoals site_id) blijven weg: die zijn waar, maar geen instelling.
 */
function summarize(row: HistoryRow): string {
  if (isCreation(row)) return "";
  const fields = row.changed_fields.filter((f) => f in FIELD_NAMES).slice(0, 3);
  if (fields.length === 0) return "";
  return fields
    .map((field) => `${FIELD_NAMES[field]}: ${clip(row.before[field])} → ${clip(row.after[field])}`)
    .join(" · ");
}

function clip(value: unknown): string {
  if (value === null || value === undefined) return "leeg";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}
