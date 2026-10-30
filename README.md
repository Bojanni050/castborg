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

`pnpm` staat op deze machine niet in het PATH; gebruik `corepack pnpm`. De scripts laden `.env`
zelf (`--env-file`), je hoeft niets te exporteren.

```bash
corepack pnpm install
cp .env.example .env     # vul APP_DB_PASSWORD, SESSION_SECRET (openssl rand -hex 32), ADMIN_TOKEN en de prijzen in
corepack pnpm db:up      # Postgres 16 via Docker op 127.0.0.1:5435
corepack pnpm db:migrate # voert packages/api/migrations/*.sql uit en zet het wachtwoord van ailead_app
corepack pnpm test       # isolatie-, API-, streaming- en instellingentests tegen de echte database
corepack pnpm --filter @ai-lead/api dev
```

Poort 5435 en niet 5432: op deze machine draait al een native Postgres op 5432 (en `chronicle-db`
op 5434). Pas `docker-compose.yml` en de URL's in `.env` samen aan als je een andere poort wilt.

`db:migrate` heeft `DATABASE_URL_MIGRATOR` én `APP_DB_PASSWORD` nodig. Het wachtwoord van de
runtime-rol `ailead_app` staat niet in een migratie (die is immers in te zien); de migratierunner
zet het bij elke run. Zonder `APP_DB_PASSWORD` stopt hij met een melding in plaats van door te gaan.

## API (v1)

| Route | Auth | Doel |
|---|---|---|
| `POST /api/v1/admin/sites` | `Bearer ADMIN_TOKEN` (tijdelijk) | Site + domeinen + instellingen aanmaken, geeft `pk_…` terug |
| `GET /api/v1/admin/sites/:id` | `Bearer ADMIN_TOKEN` | Huidige toestand inclusief instellingen |
| `PATCH /api/v1/admin/sites/:id` | `Bearer ADMIN_TOKEN` | Instellingen wijzigen; `domains` vervangt de hele lijst, onbekende velden geven `400` |
| `GET /api/v1/admin/sites/:id/history?limit=50` | `Bearer ADMIN_TOKEN` | Instellingenhistorie, nieuwste eerst |
| `POST /api/v1/admin/sites/:id/history/:historyId/restore` | `Bearer ADMIN_TOKEN` | Zet de instellingen terug naar de toestand na die wijziging |
| `GET /api/v1/widget/config?key=pk_…` | publieke sleutel | Widgetconfiguratie; 403 bij origin die niet bij de site hoort |
| `POST /api/v1/conversations` | header `X-Site-Key` | Gesprek starten, geeft `conversationId` + sessietoken (2 uur, gebonden aan dat ene gesprek) |
| `POST /api/v1/conversations/:id/messages` | `Bearer <sessietoken>` | Bericht opslaan en het volledige antwoord terugkrijgen |
| `POST /api/v1/conversations/:id/messages/stream` | `Bearer <sessietoken>` | Zelfde, maar als SSE: `delta` `{text}` … daarna `done` `{messageId}` of `error` `{error, requestId}` |

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
  Zonder prijzen zou het dagbudget niets afdwingen. Mistral heeft **geen prijs-API** (de Admin API met `/v1/admin/usage` is
  Enterprise-only en geeft achteraf je verbruik); neem de actuele bedragen van de prijspagina en noteer datum en model erbij.
  Pin het model op een concrete revisie in plaats van `-latest`, anders schuift de prijs onder je budgetcontrole vandaan.
- Dagbudget is een **harde grens**: vóór de AI-aanroep wordt het maximale bedrag van die beurt gereserveerd
  (inputschatting + `MAX_OUTPUT_TOKENS` × outputprijs) in `usage_reservations`. Gelijktijdige beurten zien elkaars
  reservering via een advisory lock per site, dus samen kunnen ze het budget niet overschrijden. De reservering wordt na
  de beurt opgeruimd; blijft er een staan door een crash, dan telt hij na 10 minuten niet meer mee.
- De dag grens loopt op `site_settings.timezone` (standaard `Europe/Amsterdam`), niet op UTC. Staat het verbruik op of boven
  `site_settings.daily_budget_eur`, dan volgt `503` en wordt er niets opgeslagen.
- Let op: staat het budget lager dan de worst case van één beurt, dan blokkeert dat elke beurt. Zet `MAX_OUTPUT_TOKENS` en het
  budget in verhouding tot elkaar.
- `usage_events` is append-only voor de runtime-rol (geen UPDATE/DELETE).
- Mislukte aanroepen worden ook geregistreerd (`status = 'error'`). Een client die tijdens het streamen wegvalt, breekt de aanvraag naar Mistral af; wat al getoond was blijft bewaard.
- Privacy: bezoekersberichten en de systeemprompt gaan naar Mistral. Leg dat vast in de verwerkersafspraken en in de tekst bij de widget.

## Instellingen en historie

- Een nieuwe site krijgt meteen een bruikbare systeemprompt met de variabele `{{siteName}}`, die bij elke beurt
  door de sitenaam wordt vervangen. Zonder prompt is de bot stom, en dat is een toestand die je niet stil wilt binnenkomen.
- Wijzigen gaat via `PATCH /api/v1/admin/sites/:id`. Domeinen worden in hun geheel vervangen, niet samengevoegd.
- Elke wijziging in `site_settings` laat een regel achter in `site_settings_history` (`before`, `after`, `changed_fields`,
  tijdstip en actor). Dat gebeurt met een trigger, dus ook een handmatige `UPDATE` buiten de API om komt in de historie.
- De actor komt uit de transactie-instelling die `withTenant` zet: `{"type":"admin_token","id":"<naam>"}`. Een handmatige
  `UPDATE` heeft die context niet en wordt als `unknown` vastgelegd.
- Een terugdraaiing is een gewone PATCH: er komt een nieuwe regel bij, de oude blijft staan.
- De runtime-rol mag de historie alleen lezen. De triggerfunctie is `SECURITY DEFINER`, zodat de applicatie zelf geen
  regels kan toevoegen of vervalsen.
- Meerdere beheerders zonder dashboard-auth: zet `ADMIN_TOKENS="naam:token,naam2:token2"` in plaats van `ADMIN_TOKEN`.
  De naam komt in de historie terecht. Dit is een benoemde sleutel, geen authenticatie: iedereen met een token is die naam.

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
- Dashboardoverzicht van kosten en gebruik (de gegevens staan al in `usage_events`, met `request_id` per beurt en
  `status` `ok`/`error`/`aborted`; een dashboard moet `error` niet als gratis succes tellen).
- Logging is één JSON-regel per gebeurtenis op stderr (`src/log.ts`), zonder retentie of aggregatie. Bezoekertekst en
  systeemprompt worden bewust niet gelogd. Zet er een logverzamelaar achter voordat je naar productie gaat.
- AI-melding in de widget ("je praat met een AI") en de verwerkersovereenkomst met Mistral. Beide horen bij de
  transparantieplicht en de AVG, niet bij "later".
- Rate limiter is in geheugen: prima voor één instantie, vervangen zodra je meerdere draait.
- `knowledge_*` (komt met fase 4).
- Spamcheck/honeypot op het leadformulier en een leadroute (fase 3).
