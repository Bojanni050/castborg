import { useEffect, useState } from "preact/hooks";
import { api, describeError, type SiteSummary } from "./api.js";

interface Props {
  onOpen: (id: string) => void;
  onSessionLost: () => void;
}

export function Sites({ onOpen, onSessionLost }: Props) {
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [domains, setDomains] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    reload();
  }, []);

  function reload() {
    api
      .sites()
      .then((r) => setSites(r.sites))
      .catch((err) => {
        if (handleAuth(err)) return;
        setError(describeError(err));
        setSites([]);
      });
  }

  function handleAuth(err: unknown): boolean {
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) {
      onSessionLost();
      return true;
    }
    return false;
  }

  async function create(event: Event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const site = await api.createSite({
        name: name.trim(),
        domains: domains
          .split(",")
          .map((d) => d.trim())
          .filter(Boolean),
      });
      setName("");
      setDomains("");
      setCreating(false);
      onOpen(site.id);
    } catch (err) {
      if (!handleAuth(err)) setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div class="page-head">
        <div>
          <h1>Sites</h1>
          <p>Elke site heeft een eigen assistent, budget en publieke sleutel.</p>
        </div>
        <div class="spacer" />
        <button class="primary" onClick={() => setCreating((v) => !v)}>
          {creating ? "Annuleren" : "Nieuwe site"}
        </button>
      </div>

      {error && (
        <div class="notice error" role="alert">
          {error}
        </div>
      )}

      {creating && (
        <form class="section" onSubmit={create}>
          <h2>Nieuwe site</h2>
          <div class="row">
            <div class="field">
              <label for="new-name">Naam</label>
              <input id="new-name" type="text" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            </div>
            <div class="field">
              <label for="new-domains">Domeinen</label>
              <input
                id="new-domains"
                type="text"
                placeholder="voorbeeld.nl, www.voorbeeld.nl"
                value={domains}
                onInput={(e) => setDomains((e.target as HTMLInputElement).value)}
              />
            </div>
          </div>
          <p class="hint">De assistent begint met een algemene prompt. Die pas je daarna aan op het bedrijf.</p>
          <div class="actions">
            <button class="primary" type="submit" disabled={busy || name.trim().length === 0}>
              {busy ? "Bezig…" : "Aanmaken"}
            </button>
          </div>
        </form>
      )}

      {sites === null ? (
        <p class="empty">Laden…</p>
      ) : sites.length === 0 ? (
        <p class="empty">Nog geen sites. Maak de eerste aan.</p>
      ) : (
        <div class="sites">
          {sites.map((site) => (
            <button class="site-row" key={site.id} onClick={() => onOpen(site.id)}>
              <div>
                <div class="site-name">{site.name}</div>
                <div class="site-meta">
                  {site.domains.length > 0 ? site.domains.join(", ") : "geen domein"} · {site.publicKey}
                </div>
              </div>
              <div class="counts">
                <span class={site.leadCount > 0 ? "pill lead" : "pill"}>
                  {site.leadCount} {site.leadCount === 1 ? "lead" : "leads"}
                </span>
                <span class="pill">
                  {site.conversationCount} {site.conversationCount === 1 ? "gesprek" : "gesprekken"}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
