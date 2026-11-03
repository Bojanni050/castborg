-- 0008_knowledge_base.sql
-- Kennisbank: geïndexeerde pagina's als bronkennis voor de assistent.
--
-- Principes:
--  * site_pages bevat per bron de status van de extractie; page_chunks de doorzoekbare stukken.
--  * De tsvector is een GENERATED-kolom: hij volgt de inhoud automatisch en kan niet uitslijpen.
--  * 'simple' als tekstconfiguratie: bronnen zijn NL of EN door elkaar en een stemmer per taal
--    is hier niet nodig; woordoverlap is voor deze selectie precies genoeg.
--  * dezelfde RLS-vorm als de andere tenant-tabellen (site_id, FORCE, fail closed).

CREATE TABLE site_pages (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id        uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  url            text        NOT NULL,
  title          text,
  -- pending: aangemaakt, nog opgehaald. ok: extractie gelukt. failed: opgehaald, mislukt;
  -- error_code legt vast wát er misging (fetch_failed, te_groot, geen_tekst, ...).
  status         text        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'ok', 'failed')),
  error_code     text,
  content_length integer     NOT NULL DEFAULT 0,
  -- Bewuste kopie van de opgehaalde tekst: herindexeren moet de vorige stand kunnen vervangen
  -- zonder dat de oude chunks weg zijn voordat de nieuwe er zijn.
  raw_text       text        NOT NULL DEFAULT '',
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, url)
);
CREATE INDEX site_pages_site_id_idx ON site_pages (site_id);

CREATE TABLE page_chunks (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id      uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  page_id      uuid        NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  chunk_index  integer     NOT NULL,
  content      text        NOT NULL,
  ts           tsvector    GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  UNIQUE (page_id, chunk_index)
);
CREATE INDEX page_chunks_ts_idx ON page_chunks USING GIN (ts);

-- ---------------------------------------------------------------------------
-- Row-Level Security: exact de vorm van 0001
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_pages', 'page_chunks']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (site_id = app_current_site_id())
         WITH CHECK (site_id = app_current_site_id())', t);
  END LOOP;
END
$$;

-- Rechten voor de runtime-rol (geen DDL, geen TRUNCATE)
GRANT SELECT, INSERT, UPDATE, DELETE ON site_pages, page_chunks TO ailead_app;
