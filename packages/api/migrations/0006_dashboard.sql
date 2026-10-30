-- ---------------------------------------------------------------------------
-- 0006: het dashboard
--
-- De runtime-rol (ailead_app) ziet per RLS-beleid alleen de site waar hij op dat moment in werkt.
-- Dat blijft zo. Voor het dashboard is er één vraag die daar principieel buiten valt: "welke sites
-- zijn er?" Daarvoor komt er één smalle SECURITY DEFINER-functie, in dezelfde geest als
-- resolve_site_by_public_key: precies deze kolommen, geen blanket-bypass, geen extra tabelrechten.
--
-- Let op: SECURITY DEFINER werkt hier omdat de migrator de eigenaar van de functie is en RLS niet
-- afdwingt voor een superuser/BYPASSRLS-rol. Draai je migraties ooit als een gewone rol, dan moet
-- die rol BYPASSRLS hebben, anders geeft deze functie een lege lijst. Dat is fail-closed: je ziet
-- niets, je lekt niets.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION dashboard_list_sites() RETURNS TABLE (
  id uuid,
  name text,
  public_key text,
  created_at timestamptz,
  domains text[],
  lead_count bigint,
  conversation_count bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT
    s.id,
    s.name,
    s.public_key,
    s.created_at,
    COALESCE(
      (SELECT array_agg(d.domain ORDER BY d.domain) FROM site_domains d WHERE d.site_id = s.id),
      ARRAY[]::text[]
    ),
    (SELECT count(*) FROM leads l WHERE l.site_id = s.id),
    (SELECT count(*) FROM conversations c WHERE c.site_id = s.id)
  FROM sites s
  ORDER BY s.created_at DESC
$$;

REVOKE ALL ON FUNCTION dashboard_list_sites() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dashboard_list_sites() TO ailead_app;
