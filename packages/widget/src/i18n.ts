/**
 * Alle vaste tekst van de widget, in twee talen. De sitehouder bepaalt de taal via de
 * site-instelling; de assistent zelf antwoordt in de taal van de bezoeker (zie de
 * taalregel in de systeemprompt). Dit bestand gaat alleen over de widget-teksten.
 */

export interface Dict {
  /** aria-label van het dialoogvenster. */
  panelLabel: string;
  title: string;
  subtitle: string;
  close: string;
  leadTitle: string;
  leadHint: string;
  fieldName: string;
  fieldEmail: string;
  fieldPhone: string;
  fieldAbout: string;
  fieldAboutAria: string;
  sendBusy: string;
  send: string;
  leadSkip: string;
  leadInvite: string;
  inputPlaceholderBlocked: string;
  inputPlaceholder: string;
  inputAria: string;
  sendAria: string;
  launcherAria: string;
  /** Assistant message after the lead form succeeds. */
  leadThanks: string;
  /** Notice when a request that is not a lead submission fails without an API error. */
  leadSendFailed: string;
  dotsAria: string;
  leadError: { contact: string; email: string; phone: string };
  errorBudget: string;
  errorLimit: string;
  errorRate: string;
  errorOrigin: string;
  errorNotFound: string;
  errorDefault: string;
  errorGeneric: string;
}

const nl: Dict = {
  panelLabel: "Chatassistent",
  title: "Assistent",
  subtitle: "AI-assistent · antwoorden kunnen onjuist zijn",
  close: "Sluiten",
  leadTitle: "Contactgegevens",
  leadHint: "Laat je e-mailadres of telefoonnummer achter, dan neemt een medewerker contact op.",
  fieldName: "Naam",
  fieldEmail: "E-mailadres",
  fieldPhone: "Telefoonnummer",
  fieldAbout: "Waar gaat het over? (optioneel)",
  fieldAboutAria: "Waar gaat het over",
  sendBusy: "Versturen…",
  send: "Versturen",
  leadSkip: "Later",
  leadInvite: "Laat je contactgegevens achter",
  inputPlaceholderBlocked: "Dit gesprek is afgelopen.",
  inputPlaceholder: "Typ je bericht…",
  inputAria: "Je bericht",
  sendAria: "Verstuur",
  launcherAria: "Chat openen",
  leadThanks: "Bedankt! Ik heb je gegevens doorgegeven; er wordt contact met je opgenomen.",
  leadSendFailed: "Je gegevens konden niet worden verstuurd. Probeer het opnieuw.",
  dotsAria: "De assistent typt",
  leadError: {
    contact: "Vul een e-mailadres of telefoonnummer in.",
    email: "Dit e-mailadres lijkt niet te kloppen.",
    phone: "Dit telefoonnummer lijkt niet te kloppen.",
  },
  errorBudget: "De assistent is vandaag niet meer beschikbaar.",
  errorLimit: "Dit gesprek is afgelopen. Laat je gegevens achter, dan nemen we contact op.",
  errorRate: "Het gaat te snel. Wacht even en probeer opnieuw.",
  errorOrigin: "Deze site is niet gemachtigd voor de assistent.",
  errorNotFound: "De assistent is niet meer bereikbaar.",
  errorDefault: "Er ging iets mis bij het ophalen van een antwoord.",
  errorGeneric: "Er ging iets mis. Probeer het opnieuw.",
};

const en: Dict = {
  panelLabel: "Chat assistant",
  title: "Assistant",
  subtitle: "AI assistant · replies may be inaccurate",
  close: "Close",
  leadTitle: "Contact details",
  leadHint: "Leave your email address or phone number and a team member will get back to you.",
  fieldName: "Name",
  fieldEmail: "Email address",
  fieldPhone: "Phone number",
  fieldAbout: "What is it about? (optional)",
  fieldAboutAria: "What is it about",
  sendBusy: "Sending…",
  send: "Send",
  leadSkip: "Later",
  leadInvite: "Leave your contact details",
  inputPlaceholderBlocked: "This conversation has ended.",
  inputPlaceholder: "Type your message…",
  inputAria: "Your message",
  sendAria: "Send",
  launcherAria: "Open chat",
  leadThanks: "Thanks! I have passed your details on; we will get back to you.",
  leadSendFailed: "Your details could not be sent. Please try again.",
  dotsAria: "The assistant is typing",
  leadError: {
    contact: "Enter an email address or phone number.",
    email: "This email address does not look right.",
    phone: "This phone number does not look right.",
  },
  errorBudget: "The assistant is not available for the rest of today.",
  errorLimit: "This conversation has ended. Leave your details and we will get back to you.",
  errorRate: "That is going too fast. Wait a moment and try again.",
  errorOrigin: "This site is not allowed to use the assistant.",
  errorNotFound: "The assistant is no longer reachable.",
  errorDefault: "Something went wrong while getting an answer.",
  errorGeneric: "Something went wrong. Please try again.",
};

export function dict(lang: string): Dict {
  return lang === "en" ? en : nl;
}
