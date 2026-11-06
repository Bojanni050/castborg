/**
 * Taal: wat is de uitwijktaal van de assistent en in welke taal schreef de bezoeker?
 *
 * Beide zijn deterministisch, geen modelinschatting. De uitwijkttaal komt uit site_settings
 * ('nl' of 'en') en zit via languageRule in ELKE systeemprompt. De taal van een bericht wordt
 * geraden aan de hand van stopwoorden; dat is stroef maar goedkoop en nooit een radend model.
 */

export type SiteLanguage = "nl" | "en";

/**
 * Systeemregel die bij ELKE beurt achter de prompt komt: de antwoordtaal volgt de bezoeker,
 * de uitwijktaal bepaalt de sitehouder via de instelling Taal.
 */
export function languageRule(lang: SiteLanguage): string {
  const uitwijk = lang === "en" ? "English" : "Nederlands";
  return (
    "\n\nLanguage: reply in the language the visitor writes in. If that is unclear, reply " +
    `in ${uitwijk}. Names of products and services stay as they appear in the site knowledge.`
  );
}

/**
 * Engelse en Nederlandse signaalwoorden. De lijsten zijn bewust smal en gescheiden — 'the' en
 * 'de' doen het zware werk — zodat een korte melding nooit op taal overschiet.
 */
const EN_MARKS =
  /\b(the|and|you|your|can|could|would|hello|hi|hey|please|thanks|thank|when|where|what|how|is|are|about|with|need|want|help me|i)\b/gi;
const NL_MARKS =
  /\b(ik|je|jij|mijn|jullie|de|het|een|kan|kun|kom|graag|hoe|wat|wie|waar|wanneer|hallo|dag|alstublieft|bedankt|medewerker|over|met|van|maar|omdat)\b/gi;

/**
 * Raadt de schrijftaal: de meeste signalen winnen, 'nl' is de standaard bij gelijke stand en bij
 * weinig signalen. Een klein bericht als "help" blijft dus netjes Nederlands.
 */
export function detectLanguage(text: string): SiteLanguage {
  const enCount = countMatches(text, EN_MARKS);
  const nlCount = countMatches(text, NL_MARKS);
  return enCount > nlCount ? "en" : "nl";
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}
