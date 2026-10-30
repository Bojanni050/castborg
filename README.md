# AI Lead Platform — fase 0

TypeScript-monorepo (pnpm). Doel van deze stap: tenant-isolatie vastleggen en bewijzen vóór er features bovenop komen.

## Structuur

```
packages/
  shared/      Zod-schema's en types, gedeeld door api, dashboard en widget
  api/         Backend (Hono komt in fase 1), migraties, tenant-helper, isolatietests
  dashboard/   React + Vite (nog leeg)
  widget/      Preact + Shadow DOM (nog leeg)
```

## Starten

```bash
pnpm install
cp .env.example .env
pnpm db:up          # Postgres 16 via Docker
pnpm db:migrate     # voert packages/api/migrations/*.sql uit
pnpm test           # isolatie- en API-tests tegen de echte database
# vul SESSION_SECRET (openssl rand -hex 32) en ADMIN_TOKEN in .env, daarna:
pnpm --filter @ai-lead/api dev
```

## API (v1)

| Route | Auth | Doel |
|---|---|---|
| `POST /api/v1/admin/sites` | `Bearer ADMIN_TOKEN` (tijdelijk) | Site + domeinen + instellingen aanmaken, geeft `pk_…` terug |
| `GET /api/v1/widget/config?key=pk_…` | publieke sleutel | Widgetconfiguratie; 403 bij origin die niet bij de site hoort |
| `POST /api/v1/conversations` | header `X-Site-Key` | Gesprek starten, geeft `conversationId` + sessietoken (2 uur, gebonden aan dat ene gesprek) |
| `POST /api/v1/conversations/:id/messages` | `Bearer <sessietoken>` | Bericht opslaan en het volledige antwoord terugkrijgen |
| `POST /api/v1/conversations/:id/messages/stream` | `Bearer <sessietoken>` | Zelfde, maar als SSE: `delta` `{text}` … daarna `done` `{messageId}` of `error` `{error}` |

Foutcodes voor de widget: `401` token ongeldig, `429` rate limit of gesprekslimiet, `503 budget_exceeded` (dagbudget van de site op),
`502 provider_unavailable` (alleen niet-streaming; bij streaming komt dit als `error`-event, omdat de stream dan al open is).
De widget moet de stream lezen met `fetch` + `ReadableStream` (EventSource kan geen POST met bearer-token).

Beveiliging in deze slice: HMAC-sessietokens, rate limiting (IP+sleutel, per gesprek), berichtlimiet per gesprek uit `site_settings`,
inputvalidatie met Zod, AI-aanroep buiten de databasetransactie, en de Origin-controle als *hygiëne* (niet als beveiliging: buiten browsers is Origin te vervalsen).

## AI-provider: Mistral

- `MistralProvider` praat rechtstreeks met `POST {MISTRAL_BASE_URL}/v1/chat/completions` (standaard `https://api.mistral.ai`, de EU-server), met `fetch`, timeout en afbreken via `AbortSignal`.
- Streaming volgens het gedocumenteerde SSE-formaat (`data: {…}` … `data: [DONE]`); token-usage wordt uit het laatste event gelezen.
  Ontbreekt die, dan wordt het verbruik geschat (±4 tekens per token) en in `usage_events.estimated` gemarkeerd.
- Standaardmodel per site: `mistral-small-latest` (kolom `site_settings.model`, per site aanpasbaar). Controleer in je Mistral-account of de alias nog naar het model wijst dat je wilt.
- **Prijzen staan niet in de code.** Zet `PRICE_INPUT_EUR_PER_M_TOKENS` en `PRICE_OUTPUT_EUR_PER_M_TOKENS` zelf in `.env`; de server start niet zonder.
  Zonder prijzen zou het dagbudget niets afdwingen.
- Dagbudget: vóór elke beurt wordt het verbruik van vandaag (UTC-dag) opgeteld; staat het op of boven `site_settings.daily_budget_eur`, dan volgt `503` en wordt er niets opgeslagen.
  Gelijktijdige beurten kunnen het budget overschrijden met hun eigen kosten (begrensd door `MAX_OUTPUT_TOKENS`).
- `usage_events` is append-only voor de runtime-rol (geen UPDATE/DELETE).
- Mislukte aanroepen worden ook geregistreerd (`status = 'error'`). Een client die tijdens het streamen wegvalt, breekt de aanvraag naar Mistral af; wat al getoond was blijft bewaard.
- Privacy: bezoekersberichten en de systeemprompt gaan naar Mistral. Leg dat vast in de verwerkersafspraken en in de tekst bij de widget.

## Isolatiemodel in het kort

- Elke tenant-tabel heeft `site_id` en een RLS-policy: `site_id = app_current_site_id()`.
- De API draait als rol `ailead_app` (geen superuser, geen BYPASSRLS). `FORCE ROW LEVEL SECURITY` staat aan.
- Context zetten gaat uitsluitend via `withTenant(db, siteId, fn)`: een transactie met `set_config('app.site_id', …, true)`.
  Die waarde is transactie-lokaal, dus veilig met connection pooling.
- Zonder context is het resultaat leeg (fail closed), niet "alles".
- De widget-sleutel (`pk_…`) wordt vóór de context opgezocht via `resolve_site_by_public_key()`,
  een smalle SECURITY DEFINER-functie. Er is geen open SELECT op `sites`.

## Bewust nog niet gedaan

- `users`, `site_memberships` en dashboard-auth (fase 1). Daarbij hoort ook een beheerpad dat over sites heen mag lezen
  (site-overzicht): dat kan niet via de runtime-rol met tenant-RLS en vraagt om een eigen policy of rol.
- `site_settings.provider` bestaat al, maar de API gebruikt nu één globale provider (`PROVIDER` in `.env`). Per-site-keuze komt wanneer er een tweede provider is.
- Dashboardoverzicht van kosten en gebruik (de gegevens staan al in `usage_events`).
- Rate limiter is in geheugen: prima voor één instantie, vervangen zodra je meerdere draait.
- `knowledge_*` (komt met fase 4).
- Spamcheck/honeypot op het leadformulier en een leadroute (fase 3).
