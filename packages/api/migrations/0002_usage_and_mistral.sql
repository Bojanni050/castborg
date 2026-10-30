-- 0002_usage_and_mistral.sql
-- Mistral als standaardprovider en registratie van AI-gebruik voor kostenbewaking.

ALTER TABLE site_settings
  ALTER COLUMN provider SET DEFAULT 'mistral',
  ALTER COLUMN model    SET DEFAULT 'mistral-small-latest';

UPDATE site_settings SET provider = 'mistral'              WHERE provider = 'anthropic';
UPDATE site_settings SET model    = 'mistral-small-latest' WHERE model = '';

CREATE TABLE usage_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid        REFERENCES conversations(id) ON DELETE SET NULL,
  provider        text        NOT NULL,
  model           text        NOT NULL,
  input_tokens    integer     NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens   integer     NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_eur        numeric(12,6) NOT NULL DEFAULT 0 CHECK (cost_eur >= 0),
  estimated       boolean     NOT NULL DEFAULT false,   -- tokens geschat omdat de provider geen usage gaf
  status          text        NOT NULL CHECK (status IN ('ok', 'error')),
  duration_ms     integer     NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_events_site_day_idx ON usage_events (site_id, created_at DESC);

ALTER TABLE usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_events
  USING (site_id = app_current_site_id())
  WITH CHECK (site_id = app_current_site_id());

-- Append-only voor de runtime-rol: geen UPDATE of DELETE, zodat kosten niet achteraf wegvallen.
GRANT SELECT, INSERT ON usage_events TO ailead_app;
