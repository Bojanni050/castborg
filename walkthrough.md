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
