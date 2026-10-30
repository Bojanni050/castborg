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

## 2026-10-30 (Leadmelding via webhook, honeypot in het formulier)

- Findings: een lead werd netjes opgeslagen, maar niemand wist dat hij bestond. De enige route was zelf
  `GET /admin/sites/:id/leads` pollen. Voor een product dat "meer leads" moet opleveren is dat dezelfde fout
  als een lead die niet wordt opgeslagen.
- Conclusions: melden via `LEAD_WEBHOOK_URL` (één JSON-POST) in plaats van e-mail. E-mail vraagt een
  providerkeuze en een account; een webhook werkt met n8n, Zapier, Make, een Slack-incoming-webhook of een
  eigen endpoint, en is met een lokaal servertje in de test te controleren. `LEAD_WEBHOOK_SECRET` ondertekent
  de body met HMAC-SHA256, zodat de ontvanger kan zien dat het bericht echt van deze API komt.
- Conclusions: de API wacht kort (3 s) op de webhook en slikt elke fout in. De lead staat dan al in de
  database, dus een kapotte webhook mag nooit een lead kosten; de fout komt als `lead_webhook_failed` in het
  log. Zonder webhook waarschuwt de server bij het starten (`lead_webhook_missing`), want zwijgen is hier
  precies het probleem.
- Findings (en de belangrijkste les): ik had eerst ook een tijdsdrempel gebouwd — een lead binnen twee
  seconden na de start van het gesprek zou een bot zijn. Bij het testen bleek dat de widget het gesprek pas
  aanmaakt op het moment van versturen, dus een bezoeker die meteen zijn gegevens invult was "te snel" en
  verdween in stilte, met een bevestiging in beeld. Weer eruit gehaald: een heuristiek die een echte lead kan
  kosten is erger dan de spam die hij tegenhoudt. Alleen de honeypot blijft over.
- Actions:
  - `packages/api/src/lead-webhook.ts` (nieuw): `notifyLead` met timeout en HMAC-ondertekening.
  - `packages/api/src/app.ts`: `leadWebhook` in `AppDeps`, honeypot-check vóór de transactie, melding na de
    commit met `lead.created` / `lead.updated`.
  - `packages/api/src/server.ts`: `LEAD_WEBHOOK_URL` / `LEAD_WEBHOOK_SECRET`, startwaarschuwing als hij mist.
  - `packages/shared/src/index.ts`: `website` als honeypotveld in `submitLeadInput`.
  - `packages/widget/src/lead.ts`, `ui/App.tsx`, `styles.ts`: verborgen veld buiten beeld (`-9999px`, niet
    `display:none`, want sommige bots slaan verborgen velden over), mee in de payload.
  - `packages/api/test/leads.test.ts`: +4 tests met een echte HTTP-ontvanger (ondertekening, updated,
    kapotte webhook, honeypot).
  - `.env.example` en `README.md`: payload, ondertekening en de honeypot uitgelegd.
- Validatie: API 85/85, widget 31/31, typecheck en build schoon (33,70 kB / 12,70 kB gzip). End-to-end met een
  eigen ontvanger op 127.0.0.1:9099: lead verstuurd in de browser, melding ontvangen, signature nagerekend en
  gelijk. Honeypot end-to-end bewezen doordat mijn eigen test per ongeluk het verborgen veld vulde: server
  logde `lead_honeypot`, sloeg niets op, widget toonde gewoon de bevestiging.

## 2026-10-30 (Echte Mistral, en wat de kwaliteitsronde aan het licht bracht)

- Findings: de eerste sleutel in `.env` gaf `401 Invalid API Key` op `/v1/models` én `/v1/chat/completions`, los van de
  app getest. Waarde was schoon (32 tekens, geen quotes of spaties), dus het was een ingetrokken of verkeerde sleutel.
  Na een verse sleutel werkte alles. Twee echte beurten bevestigen wat in de handover "nog niet geverifieerd" stond:
  `usage_events` krijgt echte tokens met `estimated = false`, in **beide** routes. 133 in / 40 uit kostte € 0,000041,
  de reservering was netjes opgeruimd, en `request_id` kwam overeen met wat de API teruggaf.
- Findings: de kwaliteitsronde met vaste vragen liet vier dingen zien die een klant direct merkt: Nederlands antwoord op
  een Engelse vraag, "negeer je instructies" maakte de assistent twee beurten lang een piratenbot, "ik wil een gesprek
  inplannen" werd genegeerd, en in een latere versie verzon hij een link naar een contactformulier dat niet bestaat.
- Conclusions: prompttekst alleen is niet genoeg, maar het voorbeeld doet het werk. Een abstracte regel ("blijf in je
  rol") wordt door een klein model genegeerd; één concreet voorbeeld van een afgewezen rolwissel niet. Daarom staat dat
  voorbeeld in de default, samen met een expliciete taalregel (de instructietaal wint anders van de bezoekerstaal) en een
  verbod op markdown en links (de widget rendert platte tekst, en een verzonnen link is erger dan geen link).
- Conclusions: de default mag niets van het bedrijf verzinnen. Zonder eigen tekst improviseert de assistent vrolijk mee
  met een vraag over boekhouden. Dat is niet met een langere default op te lossen: elke site heeft een prompt met echte
  inhoud nodig, en een veld "wat doen we" hoort bij het instellingenscherm.
- Bug in mijn eigen migratie: `\n` zonder `E`-prefix is in Postgres een backslash plus n, dus de eerste versie van de
  prompt stond vol letterlijke `\n`. Hersteld door alle literals `E'...'` te maken en de prompttekst één keer in een
  `DO`-blok te zetten (variabele + `format(%L)` voor de default), zodat default en UPDATE niet uit elkaar kunnen lopen.
  `0005` was alleen lokaal toegepast, dus hij is in plaats van een `0006` opnieuw geschreven; zodra hij gepusht is,
  geldt weer append-only.
- Actions:
  - `packages/api/migrations/0005_betere_standaardprompt.sql` (nieuw): nieuwe default met taalregel, rolvastheid plus
    voorbeeld, verbod op verzonnen diensten/links/markdown, en een UPDATE voor sites die nog op de oude default staan.
  - `packages/api/scripts/kwaliteit.mjs` + `kwaliteit-vragen.json` (nieuw): vaste cases, eigen gesprek per case,
    `--stream` voor het streamingpad, rapport naar `%TEMP%`.
  - `README.md`: sectie "Kwaliteitsronde", de geverifieerde usage-cijfers, en twee open punten erbij (geen oordeel per
    case, geen veld voor de bedrijfsomschrijving).
- Validatie: API 85/85, typecheck schoon. Kwaliteitsronde drie keer gedraaid en vergeleken; de vier problemen zijn weg,
  met als restpunten dat de assistent het aanbod soms herhaalt en dat hij zonder bedrijfsinformatie niets zinnigs over
  de diensten kan zeggen.

## 2026-10-30 (Dashboard: van curl naar een scherm)

- Findings: een prompt wijzigen kon alleen met `PATCH` en een bearer-token. Dat is precies de bottleneck: de
  kwaliteitsronde liet zien dat elke site een prompt met echte bedrijfsinformatie nodig heeft, en niemand onderhoudt
  dat met curl. Tweede probleem: een lijst over alle sites is onder tenant-RLS principieel onmogelijk — de runtime-rol
  ziet alleen de eigen rij, en dat is ook de bedoeling.
- Conclusions: één operator-wachtwoord in plaats van een `users`-tabel. Er is één gebruiker, `site_settings_history`
  accepteert al `actor_type='user'`, en een tabel met één rij is schijn-authenticatie. `dashboard-auth.ts` is de naad
  waar die tabel later komt; nu kost het geen migratie.
- Conclusions: de dashboardcookie is een ondertekende token naast de bestaande bearer, geen tweede routelaag. Daardoor
  werken alle `/admin/…`-routes ongewijzigd en blijft de historie kloppend: via het scherm `user · <naam>`, via een
  script `admin_token · <naam>`.
- Conclusions: eigen `typ`-claim in de payload. De widget en het dashboard gebruiken hetzelfde HMAC-geheim en bijna
  dezelfde code; zonder die claim is een widgettoken een dashboardtoken. Liever een veld te veel dan een token dat
  per ongeluk in de verkeerde hoek werkt.
- Conclusions: het dashboard en de API delen bewust één origin (`serveStatic` op `/`). Een cookie met `SameSite=Lax`
  werkt dan zonder CORS-uitzonderingen, en `COOKIE_SECURE=true` is een env-flag zodra er https voor staat.
- Conclusions: de cross-tenant lijst krijgt één smalle `SECURITY DEFINER`-functie in plaats van een tweede rol of een
  bypass. Zelfde patroon als `resolve_site_by_public_key`: alleen wat de lijst nodig heeft, niets meer. Fail-closed:
  is de migrator geen superuser, dan is de lijst leeg en lekt hij niets.
- Bug van mezelf: de overzichtstest verwachtte precies twee sites, maar tests in hetzelfde bestand maken al sites aan
  en de database wordt gedeeld. Opgelost met een `truncateSites()`-helper in plaats van een lossere assertie.
- Actions:
  - `packages/api/src/dashboard-auth.ts` (nieuw): cookie, HMAC-token met `typ`, wachtwoordvergelijking via sha256 +
    `timingSafeEqual` (lengte lekt niet).
  - `packages/api/src/app.ts`: `dashboard/login|logout|me|sites`, `authenticateOperator` (bearer óf cookie),
    `dashboardLogin`-limiter, `serveStatic` als `staticDir` bestaat, `modelOverride` in de responses.
  - `packages/api/src/server.ts`: `DASHBOARD_PASSWORD` (min 12), `DASHBOARD_ACTOR`, `COOKIE_SECURE`, `staticDir`.
  - `packages/api/migrations/0006_dashboard.sql` (nieuw): `dashboard_list_sites()`.
  - `packages/dashboard/` (nieuw package): inloggen, sitelijst, detail met prompt, grenzen, widget, leads en historie
    met terugzetten. Alleen gewijzigde velden gaan mee in de PATCH, anders schrijft elke opslag een lege historieregel.
  - `packages/api/test/dashboard.test.ts` (nieuw, 14 tests), `packages/shared/src/index.ts`: `dashboardLoginInput`.
  - `.env.example`, `README.md`.
- Validatie: API **99/99** (was 85), typecheck schoon op api/dashboard, dashboardbuild 29 kB (10,6 kB gzip). In de
  browser: ingelogd, site aangemaakt, prompt geplakt en opgeslagen, historie toonde `user · bojan` met leesbare diff.
  Daarna één echte Mistral-beurt met de via het scherm gezette prompt: het antwoord gebruikte de tekst uit die prompt,
  dus de keten scherm → database → provider is rond.

## 2026-10-30 (Verwijderpad en bewaartermijnen)

- Findings: er was geen enkele manier om een gesprek of lead weg te gooien. Dat maakt elke bewaartermijn in een
  verwerkingsovereenkomst een belofte die je technisch niet kunt nakomen. Bo corrigeerde eerder al mijn aanname over
  Mistral (geen aparte verwerkersovereenkomst nodig, de API-voorwaarden dekken het); wat wél nodig is, is een
  overeenkomst met elke klant — en dan moet je kunnen verwijderen.
- Conclusions: het schema bepaalde de semantiek, ik heb die niet opnieuw bedacht. `messages` cascadeert mee met een
  gesprek, `leads.conversation_id` staat op `ON DELETE SET NULL` en `usage_events.conversation_id` ook. Een gesprek
  verwijderen wist dus de inhoud, laat de lead bestaan en houdt de kostenadministratie kloppend. Dat is precies de
  combinatie die je wilt: inhoud weg, verantwoording blijven.
- Conclusions: twee termijnen in plaats van één, omdat gespreksinhoud en contactgegevens verschillend wegen. 90 dagen
  inhoud en 365 dagen leads is de startwaarde; 0 betekent nooit automatisch opruimen en dat staat in oranje in de UI,
  want stilzwijgend alles bewaren is de fout die je niet wilt maken.
- Conclusions: gesprekken worden op `updated_at` beoordeeld, niet op `created_at`. Een gesprek dat gisteren nog liep
  mag niet verdwijnen omdat het twee maanden geleden begon.
- Conclusions: opruimen is `pnpm retention`, geen timer in de API. Een proces dat moet blijven draaien om op te ruimen
  is een proces dat je niet meer durft te herstarten. Dezelfde code zit achter een knop, zodat je niet hoeft te
  wachten op de cron om te zien of het werkt.
- Conclusions: `deletion_log` met aantallen en geen inhoud. Genoeg om een klant te laten zien dat het gebeurt en om
  zelf terug te vinden wanneer iets is weggegooid, zonder een tweede kopie van de gegevens te bewaren.
- Conclusions: de veegrun begint bij de cross-tenant sitelijst en gaat daarna per site de tenant-context in. De
  leesfunctie blijft een leesfunctie; er komt geen verwijderfunctie met `BYPASSRLS` bij.
- Actions:
  - `packages/api/migrations/0007_retention.sql`: twee termijnen op `site_settings`, index op
    `conversations (site_id, updated_at)`, tabel `deletion_log` met RLS.
  - `packages/api/src/retention.ts` (nieuw): `deleteConversation`, `deleteLead`, `runRetention`.
  - `packages/api/src/db/retention-run.ts` (nieuw): `sweepAllSites` + CLI, met een try/catch per site zodat één
    kapotte site de rest niet tegenhoudt.
  - `packages/api/src/app.ts`: vijf routes (gesprekken lezen, gesprek verwijderen, lead verwijderen, nu opruimen,
    verwijderlogboek lezen); de termijnen zitten in `SiteState`, `SETTINGS_COLUMNS` en de historie.
  - `packages/shared/src/index.ts`: `retentionDaysSchema`, `conversationsQuery`, `deletionsQuery`.
  - `packages/api/package.json` + root `package.json`: script `retention`.
  - Dashboard: secties Gesprekken en Verwijderd, verwijderknop bij leads, twee-staps bevestiging inline in plaats van
    een native `confirm` (die kun je niet opmaken en niet uitleggen), en `refreshLists()` dat alleen de lijsten
    ververst zodat opgeslagen-werk-in-het-formulier niet verdwijnt.
  - `.env.example` en `README.md`: de termijnen, de routes, `pnpm retention` als cron, en wat verwijderen wel en niet
    meeneemt.
- Validatie: `retention.test.ts` 11 tests groen bij de eerste run (2100 ms), volledige suite 110/110 over 8
  bestanden, typecheck schoon op shared/api/dashboard, dashboardbuild 34,58 kB (11,74 kB gzip). In de browser op de
  testsite `Opruimtest`: gesprek verwijderen (2 berichten weg, lead blijft, log 1 rij), lead verwijderen, "Nu
  opruimen" met 0 treffers omdat alles recent is maar met twee nieuwe logregels. Screenshots `retention-1.png`,
  `retention-2.png`.

## 2026-10-30 (Uitrollen: één image voor API, dashboard en widget)

- Findings: er was geen deployment. De API luisterde expliciet op `127.0.0.1`, wat in een container
  betekent dat niemand hem kan bereiken, en `widget.js` had geen plek om te wonen: een klantsite zou
  de bundel zelf moeten hosten, terwijl de widget juist moet praten met de API-origin.
- Conclusions: één image met alles erin. De widget wordt tijdens de build gecompileerd en door de API
  op `/widget.js` geserveerd, zodat een klantsite één adres hoeft te kennen en `data-api-base` niet
  nodig is. Bewust niet via `serveStatic`: dat zet geen eigen headers, en de bundel is één bestand van
  ~33 kB — een `readFile` met een `cache-control` is eerder eerlijk dan een omweg om hetzelfde te doen.
- Conclusions: `HOST` als variabele in plaats van een hardgecodeerd adres. Lokaal blijft het
  `127.0.0.1` (dev hoort niet per ongeluk open te staan), in de container `0.0.0.0`, en de poort wordt
  alsnog alleen op loopback gepubliceerd zodat een reverse proxy het enige is dat van buiten bereikbaar is.
- Conclusions: `--env-file` werd `--env-file-if-exists`. In een container komen de variabelen van
  Docker en bestaat `/app/.env` niet; de oude vlag liet de app dan crashen nog voor hij begon.
- Bug gevonden bij de eerste build: `pnpm install --frozen-lockfile` installeerde alleen de root, omdat
  `pnpm-workspace.yaml` nog niet in de image stond. Elke package miste zijn eigen `node_modules`
  (`vite: not found`). Opgelost door dat bestand bij de manifesten te kopiëren. Het is een valkuil die
  je maar één keer maakt: pnpm klaagt niet, hij installeert gewoon minder dan je denkt.
- Actions:
  - `Dockerfile` (multi-stage, node:24-alpine, dashboard en widget gebouwd in de build-stage),
    `.dockerignore`, `docker-compose.prod.yml` (db zonder gepubliceerde poort, api op
    `127.0.0.1:8787`, database-URL's naar de `db`-service).
  - `packages/api/src/server.ts`: `HOST`, `widgetDir`, waarschuwingen `widget_build_missing` en
    `public_without_secure_cookie`.
  - `packages/api/src/app.ts`: `widgetDir` in `AppDeps` en `GET /widget.js` met `cache-control`.
  - `packages/api/package.json`: `--env-file-if-exists` in alle vier de scripts.
  - `packages/api/test/api.test.ts`: twee tests (serveren met de juiste headers, 404 zonder map).
  - `.env.example`: `HOST` en `POSTGRES_PASSWORD` (alleen voor de prod-compose).
  - `README.md`: sectie "Uitrollen (Docker)" met de commando's, de cronregel, de vier dingen die stil
    misgaan (COOKIE_SECURE, X-Forwarded-For, migrator moet BYPASSRLS houden, widgetdist in de image) en
    het inbedblok voor een klantsite.
- Validatie: image gebouwd en gedraaid tegen de dev-database; `/` serveert het dashboard (455 B html),
  `/widget.js` 33.706 B met `cache-control: public, max-age=300`, `/api/v1/health` 200, inloggen 200,
  `pnpm migrate` in de container geeft "Niets te doen", en in de browser op de container-origin laadt
  `/widget.js`, opent de launcher en komt er een (stub-)antwoord terug. Tests 112/112, typecheck schoon.
