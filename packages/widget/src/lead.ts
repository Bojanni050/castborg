/**
 * Alles wat de widget over leads moet weten, zonder DOM: zo is het te testen en blijft App.tsx
 * leesbaar. De regels komen overeen met `submitLeadInput` in @ai-lead/shared — de server is altijd
 * de baas, dit is alleen om de bezoeker niet met een 400 te verrassen.
 */

export interface LeadDraft {
  name: string;
  email: string;
  phone: string;
  message: string;
}

export interface LeadPayload {
  name?: string;
  email?: string;
  phone?: string;
  message?: string;
}

export type LeadFieldError = "contact" | "email" | "phone";

export interface LeadValidation {
  ok: boolean;
  /** Alleen gevuld als `ok` waar is. Lege velden worden weggelaten, niet als lege string verstuurd. */
  payload: LeadPayload;
  /** Welk veld de bezoeker moet aanwijzen; `contact` betekent: geen van beide ingevuld. */
  error: LeadFieldError | null;
}

export const emptyLeadDraft: LeadDraft = { name: "", email: "", phone: "", message: "" };

/** Bewust streng: een typefout in het e-mailadres kost de klant een lead. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[\d\s()-]{6,}$/;

export function validateLead(draft: LeadDraft): LeadValidation {
  const name = draft.name.trim();
  const email = draft.email.trim().toLowerCase();
  const phone = draft.phone.trim();
  const message = draft.message.trim();

  if (email === "" && phone === "") return { ok: false, payload: {}, error: "contact" };
  if (email !== "" && !EMAIL.test(email)) return { ok: false, payload: {}, error: "email" };
  if (phone !== "" && !PHONE.test(phone)) return { ok: false, payload: {}, error: "phone" };

  const payload: LeadPayload = {};
  if (name !== "") payload.name = name;
  if (email !== "") payload.email = email;
  if (phone !== "") payload.phone = phone;
  if (message !== "") payload.message = message;
  return { ok: true, payload, error: null };
}

/** Na hoeveel beurten zonder lead de widget het formulier zelf aanbiedt. */
export const LEAD_OFFER_AFTER_TURNS = 3;

export interface LeadOfferInput {
  /** Aantal berichten dat de bezoeker zelf stuurde in dit gesprek. */
  userTurns: number;
  leadCaptured: boolean;
  /** De assistent is gestopt (dagbudget op of gesprekslimiet bereikt): dan is doorgeven het enige nuttige. */
  blocked: boolean;
  alreadyOffered: boolean;
}

/**
 * Deterministisch, geen model dat "inschat" of iemand een lead is: dat is niet te testen en niet uit
 * te leggen aan een klant. Budget op = altijd aanbieden, ook als het al eens is aangeboden, want dan
 * is het formulier het enige dat nog werkt.
 */
export function shouldOfferLead(input: LeadOfferInput): boolean {
  if (input.leadCaptured) return false;
  if (input.blocked) return true;
  if (input.alreadyOffered) return false;
  return input.userTurns >= LEAD_OFFER_AFTER_TURNS;
}
