# Walkthrough — Castborg / ai-lead

Chronologisch, oudste bovenaan. Per significante wijziging: Findings (aanleiding), Conclusions (waarom
deze aanpak), Actions (wat is gewijzigd).

## 2026-10-30 (Handover gelezen, risico's gewogen, ontwerp vastgelegd)

- Findings: de handover van fase 0 beschrijft een werkende slice met 53 tests, maar noemt vier "fix-eerst"-punten
  (`.env` wordt nergens geladen, lege systeemprompt, hardcoded wachtwoord voor `ailead_app`, eerste echte
  Mistral-call). Bij het nalopen van de code bleek iets anders: er is **geen route om instellingen te wijzigen**.
  `POST /admin/sites` zet `INSERT INTO site_settings (site_id) VALUES ($1)` en verder niets. De bot is dus niet
  "even" stil door een lege default, er is geen enkele manier om hem aan te zetten.
- Findings: ook staat er nul logging op het provider-pad. Beide berichtroutes vangen de fout met `catch { }` en
  gooien de velden van `ProviderError` (status, retryable, detail) weg. De eerste echte call die faalt geeft dus
  een 502 en geen spoor.
- Conclusions: privacy en de AI-melding zijn geen backlog-item. De transparantieplicht uit de AI Act geldt sinds
  augustus 2026 en bezoekersberichten naar Mistral sturen zonder verwerkersovereenkomst is geen "later". Beide
  zijn goedkoper dan de widget zelf.
- Conclusions: het budget is nu een check die achteraf meet. Kosten zijn pas bekend na de provider-call, dus
  gelijktijdige beurten schuiven voorbij de grens. Opgelost met een reservering per beurt in plaats van een
  teller: `usage_events` blijft append-only (dat is een bewuste eigenschap) en de reservering komt in een eigen
  tabel die na de beurt wordt opgeruimd.
- Conclusions: een statische `ADMIN_TOKEN` heeft geen "wie". Voor één gebruiker is dat te overzien, maar "wat was
  de vorige prompt" is wél pijnlijk: als antwoorden achteruitgaan wil je kunnen terugdraaien en vergelijken.
  Daarom een append-only historie met een actor-kolom die nu `admin_token` heet en later een `user_id` kan zijn
  zonder schemawijziging.
- Actions: plan vastgelegd in `C:\Users\bojan\.opencode\plan\castborg-fixes-en-settings-plan.md`; nog geen code.

## 2026-10-30 (Uitvoering: budgetreservering, instellingen, historie, logging)

- Findings: `pnpm db:migrate` deed niets, zonder foutmelding. De CLI-guard in `migrate.ts` vergeleek
  `import.meta.url` met `` `file://${process.argv[1]}` ``; op Windows heeft `import.meta.url` drie schuine strepen
  (`file:///K:/...`), dus de vergelijking was altijd onwaar. Migraties waren via dat script dus nooit gedraaid.
  Opgelost met `pathToFileURL(process.argv[1]).href`, plus een rejection-handler die wél iets meldt.
- Findings: host-poort 5432 is bezet door een native Postgres en 5434 door `chronicle-db` van een ander project.
  Postgres van dit project verhuisd naar 5435 in `docker-compose.yml`, `.env.example` en de testdefaults.
- Findings: `pnpm` staat niet in het PATH, dus de root-scripts (`pnpm -r ...`) falen. Overal `corepack pnpm` gebruikt;
  README vermeldt dat nu.
- Findings: de eerste versie van de historietrigger gaf `ailead_app` INSERT op `site_settings_history`, omdat de
  triggerfunctie als aanroeper draaide. Een test die probeerde een regel te vervalsen slaagde — precies het gat dat
  de historie moest dichten. Opgelost met `SECURITY DEFINER` + `REVOKE INSERT, UPDATE, DELETE` in `0004`.
- Conclusions: het budget wordt gereserveerd vóór de provider-call, niet gemeten erna. De reservering is de worst
  case van die beurt (inputschatting + `MAX_OUTPUT_TOKENS` × outputprijs), de som telt alleen reserveringen van de
  laatste 10 minuten (een crash laat dus geen budget voor altijd bezet), en `pg_advisory_xact_lock` per site
  serialiseert alleen transactie 1 — niet de provider-latency.
- Conclusions: de dag grens loopt op `site_settings.timezone` (`Europe/Amsterdam`), niet UTC: de klant denkt in
  Nederlandse dagen.
- Conclusions: een terugdraaiing is een gewone PATCH, zodat de geschiedenis zelf ook geschiedenis blijft.
- Conclusions: de actor komt uit `app.actor_type`/`app.actor_id` (transactie-lokaal, gezet door `withTenant`). Een
  handmatige `UPDATE` heeft die context niet en wordt `unknown` — dat is informatie, geen fout.
- Actions:
  - `migrations/0001_init.sql`: rol `ailead_app` zonder wachtwoord (fail-closed), wachtwoord komt nu uit
    `APP_DB_PASSWORD` via de migratierunner.
  - `migrations/0003_budget_and_settings.sql`: `usage_reservations`, `site_settings_history` + trigger,
    `site_settings.timezone`, bruikbare standaardprompt met `{{siteName}}` + backfill, `usage_events.request_id`,
    status `aborted` erbij.
  - `migrations/0004_harden_settings_history.sql`: trigger `SECURITY DEFINER`, runtime-rol mag alleen lezen.
  - `src/app.ts`: budgetreservering in `beginTurn`/`finishTurn`, `PATCH`/`GET /admin/sites/:id`,
    `GET .../history`, `POST .../history/:id/restore`, benoemde admin-tokens, `requestId` per beurt,
    `clientIp` fallback op het socket-adres, extra limiter per IP.
  - `src/log.ts` (nieuw): één JSON-regel per gebeurtenis; providerfouten met status/detail, zonder bezoekertekst.
  - `src/db/tenant.ts`: `Actor` + optionele actor-parameter op `withTenant`.
  - `src/db/migrate.ts`: tweede argument `appRolePassword` en de Windows-guardfix.
  - `src/server.ts`, `src/provider.ts`, `packages/shared/src/index.ts`, `.env.example`, `README.md`.
  - `test/support.ts` (nieuw) + `test/settings.test.ts` (nieuw, 16 tests).
  - Tests: 69/69 groen (was 53), typecheck schoon op `api` en `shared`.
- Gevolgen om te weten: budgettests in `stream.test.ts` gebruiken nu `maxOutputTokens: 4` en een budget van 0,02,
  omdat de reservering strenger is dan de oude meting. Een budget onder de worst case van één beurt blokkeert nu
  elke beurt — dat is de prijs van een harde grens en staat in de README.

## 2026-10-30 (Root-scripts via corepack)

- Findings: `corepack enable` faalt met EPERM op `C:\Program Files\nodejs` (geen schrijfrechten, en corepack probeert ook yarn neer te zetten). Daardoor werkten `pnpm test`, `pnpm typecheck` en `pnpm db:migrate` niet op deze machine, want die roepen intern `pnpm` aan.
- Conclusions: geen PATH-gepriegel in de repo stoppen. De root-scripts roepen nu expliciet `corepack pnpm` aan, wat ook werkt als pnpm later wél op PATH staat. Eén woord per script, en het werkt op elke machine zonder setup.
- Actions: `package.json` — `db:migrate`, `test` en `typecheck` gebruiken `corepack pnpm`; `corepack pnpm typecheck` draait groen op beide packages.

## 2026-10-30 (Widget: Preact in een Shadow DOM)

- Findings: na de budget- en instellingenfixes was er nog niets dat de slice zichtbaar maakte; een API die
  correct streamt bewijst niet dat een bezoeker iets ziet. Bij het end-to-end proberen bleek bovendien dat de
  stub alle delta's in één keer uitlevert, waardoor streamen in de browser niet te controleren viel.
- Conclusions: Preact + Shadow DOM, omdat de widget in een vreemde pagina moet leven en de CSS van de klant
  geen invloed mag hebben (en andersom). Geen los stylesheet: de CSS gaat als string mee in de bundel, dus
  inbedden is één scripttag. Streamen met `fetch` + `ReadableStream` in plaats van `EventSource`, want die kan
  geen POST met een bearer-token doen. Antwoorden worden als platte tekst gerenderd — geen markdown, geen HTML.
  De AI-melding staat vast in de header en is niet instelbaar; dat is een verplichting, geen feature.
- Conclusions: de begroeting wordt in de UI gezet en niet in de database, omdat de API hem nooit als bericht
  heeft opgeslagen; twee bronnen voor dezelfde tekst lopen anders uit elkaar.
- Conclusions: bij een configuratiefout mount de widget geen knop. Een dode knop is erger dan geen knop, en de
  consolewaarschuwing met prefix `[ai-lead]` vertelt de integrator wat er mis is.
- Conclusions: `STUB_STREAM_DELAY_MS` is toegevoegd zodat je het streamen kunt zien zonder Mistral-sleutel.
  Zonder die vertraging is de stub te snel om iets te controleren.
- Actions:
  - `packages/widget/` (nieuw): `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`,
    `src/{embed.tsx,api.ts,sse.ts,session.ts,styles.ts}`, `src/ui/App.tsx`,
    `test/{sse,styles,session}.test.ts`.
  - `packages/api/src/provider.ts`: `StubProvider` accepteert `{delayMs}` (veld `streamDelayMs`, omdat
    `delayMs` al bestaat in de test-subklasse).
  - `packages/api/src/server.ts`: `STUB_STREAM_DELAY_MS`.
  - `.env.example`, `README.md`: widgetsectie, inbedvoorbeeld, AI-melding.
  - `packages/api/test/support.ts`: laadt `.env`, zodat tests hetzelfde rolwachtwoord gebruiken als de app.
- Gevonden tijdens het testen: tests riepen `migrate()` op dezelfde database en zetten daarmee het
  wachtwoord van `ailead_app` op de testwaarde; elke testrun sloopte zo de dev-server (500 met
  `password authentication failed`). Opgelost door de tests `.env` te laten lezen.
- Validatie: `typecheck` schoon, widgettests 20/20, API-tests 69/69, build 27,36 kB (10,87 kB gzip).
  In de browser gecontroleerd: launcher, paneel, begroeting, AI-melding, versturen, delta-voor-delta
  renderen, historie na herladen. De stub antwoordt met `(stub) Je schreef: …`.

## 2026-10-30 (Model tijdelijk uit de omgeving)

- Findings: het model stond per site (`site_settings.model`) maar de prijs stond globaal in `.env`, met één paar
  bedragen voor alle sites. Zodra twee sites een verschillend model hebben, rekent de tweede met de prijs van de eerste:
  medium op small-tarief is ongeveer tien keer te laag, dus het dagbudget gaat nooit af. Bo wilde het model voor nu
  gewoon ergens kunnen invullen; de UI gaat later modellen kiezen en de prijs automatisch bijwerken.
- Conclusions: daarom een expliciete, tijdelijke knop `MISTRAL_MODEL` in `.env` die van de site-instelling wint, in
  plaats van een stille override. De admin-route weigert dan een model te zetten (409 `model_locked`) in plaats van het
  te accepteren en te negeren — een instelling die niets doet is erger dan een instelling die weigert. Terugzetten van
  een oude prompt blijft werken: bij restore wordt het model uit de snapshot gehaald en blijft de rest intact.
- Conclusions: de echte vorm is optie B (prijs per model in de database, `DEFAULT_MODEL` in env voor nieuwe sites, en dan
  deze override verwijderen). Dat is bewust niet nu gedaan; de UI vraagt erom.
- Actions:
  - `packages/api/src/app.ts`: `AppDeps.modelOverride`, `modelOverride ?? settings.model` in `beginTurn`, `modelLocked()`
    op `POST`/`PATCH` en in de restore-haak.
  - `packages/api/src/server.ts`: `MISTRAL_MODEL` inlezen, doorgeven, en bij het starten `model_override_active` loggen.
  - `packages/api/test/settings.test.ts`: `lastModel` op de `RecordingProvider` + 3 tests (override wint, PATCH met model
    geeft 409, restore raakt het model niet aan).
  - `.env.example`, `README.md`, `walkthrough.md`.
- Validatie: `typecheck` schoon, 72/72 tests groen (was 69).

## 2026-10-30 (Lead-slice: van praten naar contactgegevens)

- Findings: de assistent kon een gesprek voeren maar hield niets vast. De `leads`-tabel bestond al sinds
  `0001_init.sql` (met `UNIQUE (conversation_id)`), maar er was geen route, geen formulier en geen manier om
  te zien wat er binnenkwam. Een lead die niemand kan lezen is geen lead.
- Conclusions: de bezoeker schrijft met zijn eigen sessietoken, niet met de admin-token. Het gesprek is de
  identiteit; `UNIQUE (conversation_id)` maakt een tweede inzending een update in plaats van een dubbele rij.
  Minstens e-mail of telefoon is verplicht — een lead zonder contactmogelijkheid is een notitie.
- Conclusions: het aanbod is deterministisch (`shouldOfferLead`), niet model-gedreven. Een model laten
  "inschatten" of iemand een lead is, is niet te testen en niet aan een klant uit te leggen. De regel: na drie
  beurten één keer aanbieden; zodra de assistent blokkeert (budget op of gesprekslimiet) altijd, en dan zonder
  "Later"-knop, want doorgeven is het enige dat nog werkt.
- Conclusions: de "Later"-knop verdwijnt alleen bij blokkade. Iemand die zelf wil typen mag dat; iemand wiens
  assistent op is heeft geen keuze meer, en een knop die niets oplevert is erger dan geen knop.
- Bug gevonden in de browser: de aanbieding sloot zichzelf meteen weer. `shouldOfferLead` zet `alreadyOffered`
  op true, waardoor `leadDue` in dezelfde render false werd en het formulier dus nooit zichtbaar was. Opgelost
  door de aanbieding te openen én te markeren in hetzelfde effect.
- Bug voorkomen: `type="email"` laat de browser zijn eigen validatie doen vóór `onSubmit`, dus de Nederlandse
  foutmelding zou nooit verschijnen. Formulier heeft nu `noValidate`; `type` blijft voor het toetsenbord op mobiel.
- Actions:
  - `packages/shared/src/index.ts`: `submitLeadInput` (strict, minstens e-mail of telefoon), `leadsQuery`.
  - `packages/api/src/app.ts`: `POST /conversations/:id/lead` (201 nieuw, 200 update) en
    `GET /admin/sites/:id/leads`, plus `normalizeLeadBody` (trimmen, e-mail lowercase, lege velden weglaten).
  - `packages/api/test/leads.test.ts` (nieuw, 9 tests).
  - `packages/widget/src/lead.ts` (nieuw): validatie en de aanbiedingsregel, zonder DOM.
  - `packages/widget/src/api.ts`: `submitLead`.
  - `packages/widget/src/session.ts`: `leadCaptured` en `leadOffered` in de opgeslagen toestand.
  - `packages/widget/src/ui/App.tsx`: formulier, invite-link, geblokkeerde stand, bevestiging als bericht.
  - `packages/widget/src/styles.ts`, `packages/widget/test/lead.test.ts` (11 tests), `README.md`.
- Validatie: API 9/9 nieuw, widget 31/31, typecheck schoon op api/shared/widget, build 33,29 kB (12,53 kB gzip).
  In de browser gecontroleerd: aanbieding na drie beurten, leeg verzenden geeft de juiste fout met twee rode
  velden, verzenden schrijft de lead (admin-route gaf `bo@example.nl`, getrimd en lowercase), formulier blijft
  weg na herladen, en bij budget 0 opent het formulier direct zonder "Later" met een uitgeschakeld invoerveld.
