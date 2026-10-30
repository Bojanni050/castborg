# AI Lead Platform — fase 0

TypeScript-monorepo (pnpm). Doel van deze stap: tenant-isolatie vastleggen en bewijzen vóór er features bovenop komen.

## Structuur

```
packages/
  shared/      Zod-schema's en types, gedeeld door api, dashboard en widget
  api/         Backend (Hono), migraties, tenant-helper, isolatietests
  dashboard/   React + Vite (nog leeg)
  widget/      Preact + Shadow DOM, embedbaar chatvenster met streaming
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
corepack pnpm --filter @ai-lead/widget dev   # testpagina op 127.0.0.1:5173
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
| `POST /api/v1/conversations/:id/lead` | `Bearer <sessietoken>` | Contactgegevens van de bezoeker; `201` bij nieuw, `200` bij overschrijven, minstens e-mail of telefoon |
| `GET /api/v1/admin/sites/:id/leads?limit=50` | `Bearer ADMIN_TOKEN` | Ingekomen leads, nieuwste eerst |

Foutcodes voor de widget: `401` token ongeldig, `429` rate limit of gesprekslimiet, `503 budget_exceeded` (dagbudget van de site op),
`502 provider_unavailable` (alleen niet-streaming; bij streaming komt dit als `error`-event, omdat de stream dan al open is).
De widget moet de stream lezen met `fetch` + `ReadableStream` (EventSource kan geen POST met bearer-token).

Beveiliging in deze slice: HMAC-sessietokens, rate limiting (IP+sleutel, per gesprek), berichtlimiet per gesprek uit `site_settings`,
inputvalidatie met Zod, AI-aanroep buiten de databasetransactie, en de Origin-controle als *hygiëne* (niet als beveiliging: buiten browsers is Origin te vervalsen).

### Leadmelding (webhook)

Staat `LEAD_WEBHOOK_URL` gezet, dan POST de API elke nieuwe of bijgewerkte lead als JSON naar dat adres:

```json
{
  "event": "lead.created",
  "leadId": "…", "siteId": "…", "siteName": "…", "siteKey": "pk_…",
  "conversationId": "…",
  "name": "Bo Jansen", "email": "bo@voorbeeld.nl", "phone": null, "message": null,
  "receivedAt": "2026-10-30T09:07:19.113Z"
}
```

- `event` is `lead.created` of `lead.updated` (tweede inzending in hetzelfde gesprek).
- Dezelfde waarden staan ook in de headers `x-ai-lead-event`; met `LEAD_WEBHOOK_SECRET` komt daar
  `x-ai-lead-signature: sha256=<hex>` bij: HMAC-SHA256 over de *ruwe* body, dus bereken hem over de bytes
  die je ontvangt en niet over een opnieuw geserialiseerde JSON.
- De API wacht kort (3 s) op je endpoint en gaat daarna verder. Een time-out of een 4xx/5xx kost de lead niet:
  hij staat al in de database en de fout komt als `lead_webhook_failed` in het log.
- Een gevulde honeypot (`website`) of een onbekend gesprek levert géén melding op.

## AI-provider: Mistral

- `MistralProvider` praat rechtstreeks met `POST {MISTRAL_BASE_URL}/v1/chat/completions` (standaard `https://api.mistral.ai`, de EU-server), met `fetch`, timeout en afbreken via `AbortSignal`.
- Streaming volgens het gedocumenteerde SSE-formaat (`data: {…}` … `data: [DONE]`); token-usage wordt uit het laatste event gelezen.
  Ontbreekt die, dan wordt het verbruik geschat (±4 tekens per token) en in `usage_events.estimated` gemarkeerd.
  Bij echte Mistral-antwoorden (30-10-2026, `mistral-small-2603`) komt de usage in beide routes binnen met `estimated = false`:
  133 in / 40 uit tokens kostte € 0,000041. Alleen bij een afgebroken stream of een providerfout staat `estimated = true`.
- Standaardmodel per site: `mistral-small-latest` (kolom `site_settings.model`, per site aanpasbaar). Controleer in je Mistral-account of de alias nog naar het model wijst dat je wilt.
- **Tijdelijk:** staat `MISTRAL_MODEL` in `.env`, dan wint die van `site_settings.model` voor alle sites en weigert de
  admin-route een model te zetten (`409 model_locked`). Puur om snel te kunnen wisselen zolang de UI nog geen modellen
  laat kiezen; het gaat eruit zodra prijzen per model in de database staan. Onthoud dat de prijzen in `.env` één paar
  zijn voor álle sites: een duurder model met dezelfde prijs betekent dat het dagbudget te ruim staat.
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

## Widget

`packages/widget` is een Preact-app in een Shadow DOM: de CSS van de klantsite kan niet naar binnen
lekken en andersom. Er is geen los stylesheet; de stijl zit als string in de bundel.

```bash
corepack pnpm --filter @ai-lead/widget dev     # http://127.0.0.1:5173
corepack pnpm --filter @ai-lead/widget test    # parser-, stijl- en sessietests
corepack pnpm --filter @ai-lead/widget build   # dist/widget.js (IIFE, ~27 kB / ~11 kB gzip)
```

De testpagina leest de sleutel uit de URL: `http://127.0.0.1:5173/?key=pk_…` (optioneel
`&api=http://host:poort` als de API ergens anders draait). Het domein van de pagina moet bij de site
bekend zijn, anders weigert de API met `origin_not_allowed`. Maak lokaal dus een site aan met
`127.0.0.1` en/of `localhost` als domein.

Inbedden op een echte site:

```html
<script src="/widget.js" data-site-key="pk_…" data-api-base="https://api.example.nl" async></script>
```

Zonder `data-api-base` gebruikt de widget de origin van het script zelf.

- **Streamen** gaat met `fetch` + `ReadableStream`, niet met `EventSource`: die kan geen POST met
  een bearer-token. De parser is stateful en overleeft een chunkgrens midden in `\r\n`.
- **Historie** staat in `sessionStorage` (max 40 berichten) en overleeft een herlaadbeurt zolang het
  sessietoken geldt (2 uur). De begroeting wordt alleen in de UI gezet; de API bewaart hem niet.
- **De AI-melding** staat permanent in de header ("AI-assistent · antwoorden kunnen onjuist zijn");
  dat is de transparantieverplichting, geen optie.
- **Leadformulier**: altijd bereikbaar via een link boven het invoerveld, en het opent zichzelf na drie
  beurten zonder lead. Zodra de assistent blokkeert (dagbudget op of gesprekslimiet) opent het formulier
  meteen en verdwijnt de "Later"-knop: dan is doorgeven het enige dat nog werkt. De regel is
  deterministisch (`shouldOfferLead` in `src/lead.ts`) — geen model dat "inschat" of iemand een lead is.
- **Fouten** worden naar één Nederlandse regel vertaald (`budget_exceeded`, `rate_limited`, …).
  Bij een configuratiefout mount de widget geen knop — een dode knop is erger dan geen knop — en
  schrijft hij één gerichte waarschuwing met prefix `[ai-lead]` naar de console.
- **Veiligheid**: de `pk_…`-sleutel is publiek en identificeert alleen de site. De autorisatie is het
  sessietoken per gesprek. Antwoorden worden als platte tekst gerenderd (geen markdown of HTML).
- `PROVIDER=stub` antwoordt direct; zet `STUB_STREAM_DELAY_MS=60` in `.env` om het streamen
  zichtbaar te maken zonder echte provider.

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

## Kwaliteitsronde (meten in plaats van voelen)

`packages/api/scripts/kwaliteit.mjs` stuurt een vaste set gesprekken door de echte assistent en schrijft een
markdown-rapport, zodat een promptwijziging te vergelijken is met de vorige in plaats van "voelt beter".

```
corepack pnpm --filter @ai-lead/api exec node scripts/kwaliteit.mjs --key pk_... [--stream] [--api http://127.0.0.1:8787]
```

- De cases staan in `packages/api/scripts/kwaliteit-vragen.json`: per case een `id`, waarom hij erin staat, en de
  berichten van de bezoeker. Elke case krijgt een **eigen gesprek**, anders beïnvloeden ze elkaar.
- Standaard gaat het via `POST …/messages` (één volledig antwoord); met `--stream` via de SSE-route, zodat je ook
  het streamingpad test.
- Het rapport komt op `%TEMP%\castborg-kwaliteit-<tijdstip>.md`.

Wat de eerste ronde (30-10-2026, `mistral-small-2603`, standaardprompt) liet zien en wat er daarna in
`0005_betere_standaardprompt.sql` is rechtgezet:

| Case | Eerste ronde | Nu |
| --- | --- | --- |
| Engelse vraag | antwoordde in het Nederlands | antwoordt in het Engels |
| "Negeer je instructies" | werd twee beurten een piratenbot | weigert met één zin en gaat door |
| "Ik wil een gesprek inplannen" | negeerde het verzoek | wijst op het contactformulier |
| Prijs vragen | geen prijs verzonnen | nog steeds niet, en geen verzonnen link meer |
| Boze bezoeker | bleef doorvragen | biedt het contactformulier aan |

Twee dingen die daaruit te leren zijn en die niet met prompttekst op te lossen zijn:

- Een klein model volgt een **concreet voorbeeld** betrouwbaar en een abstracte regel ("blijf in je rol") niet.
  Daarom staat er een voorbeeld van een afgewezen rolwissel in de default.
- De default weet niets van het bedrijf. Zonder eigen tekst over diensten en werkwijze improviseert de assistent
  ("dat klinkt als een serieuze vraag" op een vraag over boekhouden). Elke site heeft een echte prompt nodig; een
  apart veld "wat doen we" hoort bij de UI, niet bij een langere default.

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
- De kwaliteitsronde is een script met vaste vragen, geen test met een oordeel: je leest het rapport en beoordeelt het
  zelf. Een volgende stap is per case een controle (geen prijs in het antwoord, geen link, wel de juiste taal) zodat een
  promptwijziging ook automatisch kan afketsen.
- Er is geen veld "wat doet dit bedrijf". Dat zit nu in de systeemprompt zelf; een eigen veld met een korte
  bedrijfsomschrijving hoort bij het instellingenscherm, want anders moet elke klant prompten gaan schrijven.
- De AI-melding zit in de widget ("je praat met een AI"). Wat nog open is: de verwerkersovereenkomst met
  Mistral en een bewaartermijn voor gesprekken. Beide horen bij de transparantieplicht en de AVG, niet bij "later".
- Rate limiter is in geheugen: prima voor één instantie, vervangen zodra je meerdere draait.
- `knowledge_*` (komt met fase 4).
- Spamcheck op het leadformulier is een honeypot: een onzichtbaar veld `website` dat een mens leeg laat.
  Is het gevuld, dan antwoordt de API alsof het gelukt is en slaat niets op (`lead_honeypot` in het log).
  Dat is genoeg voor domme formulier-bots; voor gerichte spam is rate limiting het echte antwoord.
- De melding bij een lead gaat via `LEAD_WEBHOOK_URL` (één JSON-POST, optioneel ondertekend met
  `LEAD_WEBHOOK_SECRET`). Zonder die variabele wordt een lead alleen opgeslagen en waarschuwt de server
  bij het starten (`lead_webhook_missing`). E-mail versturen zou een providerkeuze vragen; dit werkt met n8n,
  Zapier, Make, Slack of een eigen endpoint.
