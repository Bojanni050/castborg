-- 0003_budget_and_settings.sql
--  * harde dagbudget-grens via reserveringen (in plaats van achteraf meten)
--  * bruikbare standaardprompt en per-site tijdzone
--  * append-only historie van wijzigingen aan site_settings, ook bij een handmatige UPDATE

-- ---------------------------------------------------------------------------
-- site_settings: tijdzone en een standaardprompt die ergens op slaat
-- ---------------------------------------------------------------------------
ALTER TABLE site_settings
  ADD COLUMN timezone text NOT NULL DEFAULT 'Europe/Amsterdam';

-- De default geldt alleen voor nieuwe rijen; bestaande lege prompts krijgen hem ook.
ALTER TABLE site_settings
  ALTER COLUMN system_prompt SET DEFAULT
    'Je bent de assistent van {{siteName}}. Antwoord kort, vriendelijk en in het Nederlands. '
    'Verzin niets: weet je iets niet, zeg dat dan en bied aan de bezoeker door te verbinden met een medewerker.';

UPDATE site_settings
   SET system_prompt = 'Je bent de assistent van {{siteName}}. Antwoord kort, vriendelijk en in het Nederlands. '
                       'Verzin niets: weet je iets niet, zeg dat dan en bied aan de bezoeker door te verbinden met een medewerker.'
 WHERE btrim(system_prompt) = '';

-- Foutopsporing: een beurt die halverwege afbreekt (weggevallen client) is geen succes.
ALTER TABLE usage_events DROP CONSTRAINT usage_events_status_check;
ALTER TABLE usage_events ADD CONSTRAINT usage_events_status_check
  CHECK (status IN ('ok', 'error', 'aborted'));

-- Correlatie tussen een verzoek en de kostenregel.
ALTER TABLE usage_events ADD COLUMN request_id uuid;

-- ---------------------------------------------------------------------------
-- usage_reservations: bedrag dat een lopende beurt maximaal mag kosten
-- ---------------------------------------------------------------------------
-- usage_events blijft append-only. Een reservering is iets anders: die bestaat tijdelijk en
-- verdwijnt zodra de beurt is afgerekend. Daarom een eigen tabel met DELETE-recht.
CREATE TABLE usage_reservations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  reserved_eur    numeric(12,6) NOT NULL CHECK (reserved_eur >= 0),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_reservations_site_idx ON usage_reservations (site_id, created_at DESC);

ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_reservations
  USING (site_id = app_current_site_id())
  WITH CHECK (site_id = app_current_site_id());

GRANT SELECT, INSERT, DELETE ON usage_reservations TO ailead_app;

-- ---------------------------------------------------------------------------
-- site_settings_history: wat er veranderde, wanneer en door wie
-- ---------------------------------------------------------------------------
-- actor_type/actor_id zijn expres tekst: nu de naam van een admin-token, later een user_id.
-- Daardoor hoeft er bij dashboard-auth niets aan deze tabel te veranderen.
CREATE TABLE site_settings_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  actor_type     text NOT NULL CHECK (actor_type IN ('admin_token', 'user', 'unknown')),
  actor_id       text NOT NULL DEFAULT 'unknown',
  changed_fields text[] NOT NULL,
  before         jsonb NOT NULL,
  after          jsonb NOT NULL
);
CREATE INDEX site_settings_history_site_idx ON site_settings_history (site_id, changed_at DESC);

ALTER TABLE site_settings_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_settings_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON site_settings_history
  USING (site_id = app_current_site_id())
  WITH CHECK (site_id = app_current_site_id());

-- Append-only: geen UPDATE of DELETE voor de runtime-rol.
GRANT SELECT, INSERT ON site_settings_history TO ailead_app;

-- De trigger, niet de route, is verantwoordelijk voor de historie. Een handmatige
-- `UPDATE site_settings` in psql levert daardoor ook een regel op (actor 'unknown'),
-- in plaats van stilletjes te verdwijnen. De actor komt uit een transactie-instelling
-- die de API zet; buiten de API is die leeg.
CREATE OR REPLACE FUNCTION site_settings_history_fn() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_before jsonb;
  v_after  jsonb;
  v_fields text[];
BEGIN
  v_after := to_jsonb(NEW);

  IF TG_OP = 'INSERT' THEN
    v_before := '{}'::jsonb;
    v_fields := ARRAY(SELECT key FROM jsonb_each(v_after) WHERE key <> 'updated_at');
  ELSE
    v_before := to_jsonb(OLD);
    v_fields := ARRAY(
      SELECT key FROM jsonb_each(v_after)
       WHERE key <> 'updated_at'
         AND v_after -> key IS DISTINCT FROM v_before -> key
    );
  END IF;

  -- Een update die alleen updated_at raakt is geen wijziging.
  IF cardinality(v_fields) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO site_settings_history (site_id, actor_type, actor_id, changed_fields, before, after)
  VALUES (
    NEW.site_id,
    COALESCE(NULLIF(current_setting('app.actor_type', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.actor_id', true), ''), 'unknown'),
    v_fields,
    v_before - 'updated_at',
    v_after - 'updated_at'
  );

  RETURN NEW;
END
$$;

CREATE TRIGGER site_settings_history_trigger
  AFTER INSERT OR UPDATE ON site_settings
  FOR EACH ROW EXECUTE FUNCTION site_settings_history_fn();
