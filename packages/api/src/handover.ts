/**
 * Menselijke overdracht.
 *
 * Detectie is deterministisch, geen modelinschatting: een bezoeker die om een mens vraagt en als
 * antwoord een prijzige generieke zin krijgt, is het slechtste gesprek dat het widget kan hebben.
 * Dezelfde redenering als `shouldOfferLead` in de widget; de server is altijd de baas, dit is
 * alleen de eerste en goedkoopste lijn.
 *
 * De vaste antwoordtekst is bewust een belofte die de sitehouder kán nakomen: het gesprek staat
 * in het dashboard met een open status en het bericht gaat via de webhook de deur uit.
 */

import { detectLanguage } from "./language.js";

/**
 * Woordgrenzen en frase-matching bewust smal: een vals-positief is goedkoop, maar een gemiste
 * request kost een contactmoment. 'Persoon' staat alleen in 'echte persoon', want "per persoon"
 * zou anders een vals alarm zijn.
 */
const HANDOVER_PATTERN =
  /\b(mens|mensen|medewerkers?|echte persoon|real person|persoonlijke hulp|contactpersoon|iemand van het team|praten met iemand|spreken met iemand|telefonisch contact|bel mij|bel me\b|kan ik bellen|mag ik bellen|telefoonnummer|speak to (?:a |an )?(?:human|person|human being|representative|agent)|talk to (?:a |an )?(?:human|person|human being|representative|agent)|human (?:agent|operator|representative)|actual human|i want a human|call me|give me a call)\b/iu;

export function isHandoverRequest(text: string): boolean {
  return HANDOVER_PATTERN.test(text);
}

/**
 * De assistent regelt de overdracht niet zelf: hij legt uit wat er gebeurt en wijst op de
 * contactgegevens die de sitehouder nodig heeft om daadwerkelijk contact op te nemen.
 */
export const HANDOVER_REPLY =
  "Ik zet dit gesprek klaar voor een medewerker, die leest het mee. " +
  "Laat hieronder je e-mailadres of telefoonnummer achter, dan wordt er contact met je opgenomen.";

/** Engelse vaste tekst; beide varianten horen bij dezelfde handeling in het dashboard. */
export const HANDOVER_REPLY_EN =
  "I'll mark this conversation for a member of our team, who will read it. " +
  "Leave your email address or phone number below and we'll get back to you.";

/**
 * De taal van de vaste tekst volgt de taal waarop de bezoeker schreef: een bezoeker die
 * "Can I talk to a human?" typt krijgt Engels terug, niemand moet dat in het model zoeken.
 */
export function handoverReply(text: string): string {
  return detectLanguage(text) === "en" ? HANDOVER_REPLY_EN : HANDOVER_REPLY;
}

/**
 * Extra systeemregel (komt bij ELKE beurt in de prompt): de deterministische detectie vangt de
 * letterlijke verzoeken af; dit vangt de omwegen af die niet in de lijst stonden, in andere
 * bewoordingen of een andere taal. Zijn rol is niet regelen maar doorverwijzen.
 */
export const HANDOVER_RULE =
  "\n\nOverdracht: vraagt de bezoeker om een mens, dan zeg je dat het gesprek voorgelegd wordt" +
  " aan een medewerker en wijs je op het contactformulier in dit venster" +
  " (\"Contactgegevens achterlaten\"). Je bent geen mens, geeft nooit uit eigen initiatief" +
  " contactgegevens en maakt geen beloftes namens het team.";
