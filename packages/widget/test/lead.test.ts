import { describe, expect, it } from "vitest";
import { emptyLeadDraft, shouldOfferLead, validateLead, type LeadDraft } from "../src/lead";

const draft = (overrides: Partial<LeadDraft> = {}): LeadDraft => ({ ...emptyLeadDraft, ...overrides });

describe("leadformulier valideren", () => {
  it("eist minstens een e-mailadres of telefoonnummer", () => {
    // Alleen een naam is geen lead: er is geen manier om contact op te nemen.
    expect(validateLead(draft({ name: "Bo" }))).toEqual({ ok: false, payload: {}, error: "contact" });
    expect(validateLead(draft({ message: "Bel me even" })).error).toBe("contact");
  });

  it("weigert een e-mailadres dat niet klopt", () => {
    expect(validateLead(draft({ email: "bo@example" })).error).toBe("email");
    expect(validateLead(draft({ email: "bo example.nl" })).error).toBe("email");
  });

  it("weigert een telefoonnummer dat niet klopt", () => {
    expect(validateLead(draft({ phone: "123" })).error).toBe("phone");
    expect(validateLead(draft({ phone: "bel mij" })).error).toBe("phone");
  });

  it("accepteert een telefoonnummer met spaties, streepjes en een plus", () => {
    for (const phone of ["0612345678", "+31 6 1234 5678", "020-123 45 67", "(06) 12345678"]) {
      expect(validateLead(draft({ phone })).ok).toBe(true);
    }
  });

  it("trimt de velden en maakt het e-mailadres klein", () => {
    const result = validateLead(draft({ name: "  Bo  ", email: "  Bo@Example.NL ", phone: "" }));
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ name: "Bo", email: "bo@example.nl" });
  });

  it("laat lege velden weg in plaats van ze als lege string te sturen", () => {
    const result = validateLead(draft({ email: "bo@example.nl", message: "   " }));
    expect(result.payload).toEqual({ email: "bo@example.nl" });
    expect("phone" in result.payload).toBe(false);
    expect("message" in result.payload).toBe(false);
  });

  it("geeft voorrang aan contact boven een kapot veld", () => {
    // Beide leeg is een andere fout dan een typefout; de bezoeker moet de juiste hint zien.
    expect(validateLead(draft({ name: "Bo", email: "kapot" })).error).toBe("email");
  });
});

describe("wanneer het formulier zichzelf aanbiedt", () => {
  const base = { userTurns: 0, leadCaptured: false, blocked: false, alreadyOffered: false };

  it("biedt het pas aan na een paar beurten", () => {
    expect(shouldOfferLead({ ...base, userTurns: 2 })).toBe(false);
    expect(shouldOfferLead({ ...base, userTurns: 3 })).toBe(true);
  });

  it("biedt het maar één keer aan", () => {
    expect(shouldOfferLead({ ...base, userTurns: 8, alreadyOffered: true })).toBe(false);
  });

  it("biedt het altijd aan als de assistent geblokkeerd is, ook als het al is aangeboden", () => {
    // Budget op of gesprekslimiet: het formulier is dan het enige dat nog werkt.
    expect(shouldOfferLead({ ...base, blocked: true })).toBe(true);
    expect(shouldOfferLead({ ...base, blocked: true, alreadyOffered: true, userTurns: 9 })).toBe(true);
  });

  it("biedt niets aan als de gegevens al binnen zijn", () => {
    expect(shouldOfferLead({ ...base, leadCaptured: true, userTurns: 9 })).toBe(false);
    expect(shouldOfferLead({ ...base, leadCaptured: true, blocked: true })).toBe(false);
  });
});
