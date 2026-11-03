-- 0009_handover.sql
-- Menselijke overdracht: een aanvraag om een mens is een feit, geen ai-antwoord.
--
-- Principes (zelfde als 0001):
--  * site_id erbij, zodat RLS zonder join kan.
--  * één rij per gesprek (UNIQUE op conversation_id): opnieuw vragen is een update,
--    geen tweede rij. De webhook-melding gaat alleen bij de eerste.
--  * trigger_message is het bericht waarmee de bezoeker om een mens vroeg: zonder dat
--    kan de sitehouder het gesprek niet beoordelen (statistieken alleen is onleesbaar).

CREATE TABLE handovers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id  uuid        NOT NULL UNIQUE REFERENCES conversations(id) ON DELETE CASCADE,
  trigger_message  text        NOT NULL,
  status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  handled_at       timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX handovers_site_idx ON handovers (site_id, status, created_at DESC);

ALTER TABLE handovers ENABLE ROW LEVEL SECURITY;
ALTER TABLE handovers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON handovers
  USING (site_id = app_current_site_id())
  WITH CHECK (site_id = app_current_site_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON handovers TO ailead_app;
