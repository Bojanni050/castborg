-- Bewaartermijnen en het verwijderpad.
--
-- Aanleiding: er was geen enkele manier om gegevens van een bezoeker weg te halen. Een
-- verwerkersovereenkomst met een klant belooft een bewaartermijn, en een belofte die je niet kunt
-- uitvoeren is erger dan geen belofte.
--
-- Twee termijnen, want het zijn twee soorten gegevens met een eigen leven:
--   conversation_retention_days  de inhoud van het gesprek (wat de bezoeker typte)
--   lead_retention_days          de contactgegevens (het enige dat de klant echt wil hebben)
-- 0 betekent: nooit automatisch opruimen, alleen handmatig. Bewust toegestaan, maar de UI zet het
-- in oranje: stilzwijgend alles bewaren is precies wat je niet wilt.

ALTER TABLE site_settings
  ADD COLUMN conversation_retention_days integer NOT NULL DEFAULT 90
    CHECK (conversation_retention_days >= 0),
  ADD COLUMN lead_retention_days integer NOT NULL DEFAULT 365
    CHECK (lead_retention_days >= 0);

-- Opruimen kijkt naar de laatste activiteit, niet naar het moment van aanmaken: een gesprek dat
-- gisteren nog liep mag niet verdwijnen omdat het vorige maand begon.
CREATE INDEX conversations_site_updated_idx ON conversations (site_id, updated_at);

-- Aantoonbaar opruimen. Zonder deze tabel kun je een klant niet laten zien dat het gebeurt, en
-- kun je zelf niet terugvinden wanneer iets is weggegooid. Er staat geen inhoud in, alleen aantallen.
CREATE TABLE deletion_log (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ran_at        timestamptz NOT NULL DEFAULT now(),
  source        text        NOT NULL CHECK (source IN ('manual', 'retention')),
  subject       text        NOT NULL CHECK (subject IN ('conversation', 'lead')),
  conversations integer     NOT NULL DEFAULT 0 CHECK (conversations >= 0),
  messages      integer     NOT NULL DEFAULT 0 CHECK (messages >= 0),
  leads         integer     NOT NULL DEFAULT 0 CHECK (leads >= 0),
  actor_type    text        NOT NULL,
  actor_id      text        NOT NULL
);
CREATE INDEX deletion_log_site_idx ON deletion_log (site_id, ran_at DESC);

ALTER TABLE deletion_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON deletion_log
  USING (site_id = app_current_site_id())
  WITH CHECK (site_id = app_current_site_id());

-- Alleen toevoegen en lezen, geen wijzigen of wissen: een log die je kunt bijwerken is geen log.
GRANT SELECT, INSERT ON deletion_log TO ailead_app;
