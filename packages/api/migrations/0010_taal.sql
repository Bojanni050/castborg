-- Taal van het widget.
--
-- Bepaalt twee dingen: de vertaalde teksten in de widget (leadformulier, fouten, meldingen) en de
-- uitweichtaal van het model als de schrijftaal van de bezoeker onduidelijk is. De antwoordtaal
-- zelf volgt de bezoeker via de systeemregel LANGUAGE_RULE. Dit is geen vertaalsysteem: alleen
-- Nederlands en Engels, want dat is waar de teksten vandaan komen.
ALTER TABLE site_settings
  ADD COLUMN language TEXT NOT NULL DEFAULT 'nl' CHECK (language IN ('nl', 'en'));

COMMENT ON COLUMN site_settings.language IS 'Taal van de widget-teksten ("nl"|"en"); ook de uitwijkttaal van de assistent.';
