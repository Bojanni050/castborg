-- 0004_harden_settings_history.sql
-- De historie mag alleen door de trigger gevuld worden.
--
-- In 0003 kreeg ailead_app INSERT op site_settings_history, omdat de triggerfunctie als de
-- aanroeper draaide. Dat betekende ook dat een fout of een gecompromitteerde applicatie zelf
-- regels kon toevoegen en de geschiedenis kon vervalsen. De functie draait nu als eigenaar
-- (SECURITY DEFINER) en de runtime-rol mag alleen nog lezen.
--
-- De actor komt nog steeds uit de transactie-instelling (app.actor_type / app.actor_id), die
-- withTenant zet; SECURITY DEFINER verandert daar niets aan.

ALTER FUNCTION site_settings_history_fn() SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE INSERT, UPDATE, DELETE ON site_settings_history FROM ailead_app;
