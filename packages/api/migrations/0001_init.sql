-- 0001_init.sql
-- Multi-tenant basis met Row-Level Security.
--
-- Principes:
--  * Elke tenant-tabel heeft site_id.
--  * De API draait als rol ailead_app: geen superuser, geen BYPASSRLS, geen eigenaar van de tabellen.
--  * FORCE ROW LEVEL SECURITY zodat zelfs de tabeleigenaar het beleid volgt.
--  * De tenant-context staat in app.site_id (via SET LOCAL binnen een transactie).
--    Is die niet gezet, dan is current_setting(..., true) NULL en matcht er geen enkele rij (fail closed).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Rol voor de API-runtime
-- ---------------------------------------------------------------------------
-- Bewust zonder wachtwoord: een rol zonder wachtwoord kan niet inloggen (fail closed).
-- `pnpm db:migrate` zet het wachtwoord uit APP_DB_PASSWORD met ALTER ROLE, zodat er geen
-- wachtwoord in een migratiebestand staat en een vergeten variabele meteen opvalt.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ailead_app') THEN
    CREATE ROLE ailead_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Helper: huidige tenant uit sessievariabele
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_current_site_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.site_id', true), '')::uuid
$$;

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  public_key  text        NOT NULL UNIQUE,            -- pk_..., publiek, alleen voor identificatie
  status      text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- site_domains
-- ---------------------------------------------------------------------------
CREATE TABLE site_domains (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id    uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  domain     text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, domain)
);
CREATE INDEX site_domains_site_id_idx ON site_domains (site_id);

-- ---------------------------------------------------------------------------
-- site_settings (1 rij per site)
-- ---------------------------------------------------------------------------
CREATE TABLE site_settings (
  site_id           uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  system_prompt     text        NOT NULL DEFAULT '',
  provider          text        NOT NULL DEFAULT 'anthropic',
  model             text        NOT NULL DEFAULT '',
  greeting          text        NOT NULL DEFAULT 'Hoi! Waar kan ik je mee helpen?',
  opening_question  text,
  widget_position   text        NOT NULL DEFAULT 'bottom-right' CHECK (widget_position IN ('bottom-right', 'bottom-left')),
  primary_color     text        NOT NULL DEFAULT '#2563eb',
  daily_budget_eur  numeric(10,2) NOT NULL DEFAULT 5.00,   -- harde dagelijkse kostenbegrenzing
  max_messages_per_conversation integer NOT NULL DEFAULT 40,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
CREATE TABLE conversations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  stage       text        NOT NULL DEFAULT 'discovery'
              CHECK (stage IN ('discovery', 'qualification', 'conversion', 'completed')),
  page_url    text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_site_id_idx ON conversations (site_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- messages
-- site_id is bewust gedenormaliseerd zodat RLS zonder join kan en niet te omzeilen is
-- ---------------------------------------------------------------------------
CREATE TABLE messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text        NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content         text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_site_id_idx ON messages (site_id);

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------
CREATE TABLE leads (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id         uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  conversation_id uuid        REFERENCES conversations(id) ON DELETE SET NULL,
  name            text,
  email           text,
  phone           text,
  message         text,
  status          text        NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new', 'contacted', 'qualified', 'won', 'lost')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- voorkomt dubbele leads uit hetzelfde gesprek
  UNIQUE (conversation_id)
);
CREATE INDEX leads_site_id_idx ON leads (site_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- Tenant-tabellen met kolom site_id
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['site_domains', 'site_settings', 'conversations', 'messages', 'leads']
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

-- sites: een tenant ziet alleen zijn eigen rij. id is hier de tenantsleutel.
ALTER TABLE sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE sites FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sites
  USING (id = app_current_site_id())
  WITH CHECK (id = app_current_site_id());

-- Opzoeken van een site via public_key gebeurt VÓÓR er een tenant-context is.
-- Dat mag niet via een open SELECT op sites; daarom een smalle SECURITY DEFINER-functie
-- die alleen het id van een actieve site teruggeeft en niets anders.
CREATE OR REPLACE FUNCTION resolve_site_by_public_key(p_key text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM sites WHERE public_key = p_key AND status = 'active'
$$;
REVOKE ALL ON FUNCTION resolve_site_by_public_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_site_by_public_key(text) TO ailead_app;

-- ---------------------------------------------------------------------------
-- Rechten voor de runtime-rol (geen DDL, geen TRUNCATE)
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO ailead_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sites, site_domains, site_settings, conversations, messages, leads
TO ailead_app;
GRANT EXECUTE ON FUNCTION app_current_site_id() TO ailead_app;
