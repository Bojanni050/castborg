import { useEffect, useState } from "preact/hooks";
import { api, describeError, type Actor } from "./api.js";
import { Sites } from "./Sites.js";
import { SiteDetail } from "./SiteDetail.js";

type View = { kind: "sites" } | { kind: "site"; id: string };

interface Session {
  actor: Actor;
  modelOverride: string | null;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [booting, setBooting] = useState(true);
  const [view, setView] = useState<View>({ kind: "sites" });

  useEffect(() => {
    api
      .me()
      .then((r) => setSession({ actor: r.actor, modelOverride: r.modelOverride }))
      .catch(() => setSession(null))
      .finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div class="login-wrap">
        <p class="who">Laden…</p>
      </div>
    );
  }

  if (!session) return <Login onLogin={setSession} />;

  async function logout() {
    try {
      await api.logout();
    } catch {
      // De cookie wissen lukt lokaal ook als de server niet antwoordt; de gebruiker wil eruit.
    }
    setSession(null);
  }

  return (
    <>
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">C</span>
          <span>Castborg</span>
        </div>
        <div class="spacer" />
        <span class="who">{session.actor.id}</span>
        <button class="ghost" onClick={logout}>
          Uitloggen
        </button>
      </header>
      <main>
        {view.kind === "sites" ? (
          <Sites onOpen={(id) => setView({ kind: "site", id })} onSessionLost={() => setSession(null)} />
        ) : (
          <SiteDetail
            id={view.id}
            modelOverride={session.modelOverride}
            onBack={() => setView({ kind: "sites" })}
            onSessionLost={() => setSession(null)}
          />
        )}
      </main>
    </>
  );
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: Event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(password);
      onLogin({ actor: r.actor, modelOverride: r.modelOverride });
    } catch (err) {
      setError(describeError(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="login-wrap">
      <form class="card login" onSubmit={submit}>
        <h1>Inloggen</h1>
        <p>Beheer van je assistenten, gesprekken en leads.</p>
        {error && (
          <div class="notice error" role="alert">
            {error}
          </div>
        )}
        <div class="field">
          <label for="password">Wachtwoord</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            autoFocus
            onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="actions">
          <button class="primary" type="submit" disabled={busy || password.length === 0}>
            {busy ? "Bezig…" : "Inloggen"}
          </button>
        </div>
      </form>
    </div>
  );
}
