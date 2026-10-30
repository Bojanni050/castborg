import { describe, expect, it } from "vitest";
import { buildStyles, safeColor, shade } from "../src/styles";

describe("kleuren uit de configuratie", () => {
  it("accepteert een geldige hex en normaliseert naar kleine letters", () => {
    expect(safeColor("#AABBCC")).toBe("#aabbcc");
  });

  it("valt terug op de standaardkleur bij rommel", () => {
    // De kleur belandt in CSS, dus alles wat geen hex is moet geweigerd worden.
    expect(safeColor("red; background: url(evil)")).toBe("#2563eb");
    expect(safeColor("#12345")).toBe("#2563eb");
    expect(safeColor(undefined)).toBe("#2563eb");
    expect(safeColor(null)).toBe("#2563eb");
  });

  it("maakt donkerder en lichter zonder buiten 0-255 te vallen", () => {
    expect(shade("#2563eb", -1)).toBe("#000000");
    expect(shade("#2563eb", 1)).toBe("#ffffff");
    expect(shade("#000000", -0.5)).toBe("#000000");
    expect(shade("#ffffff", 0.5)).toBe("#ffffff");
  });
});

describe("buildStyles", () => {
  it("zet de kleur als custom property en de gevraagde kant", () => {
    const css = buildStyles("#ff0000", "bottom-left");
    expect(css).toContain("--al-primary: #ff0000");
    expect(css).toContain("left: 20px");
    expect(css).not.toContain("right: 20px");
  });

  it("valt bij een ongeldige kleur terug op de standaardkleur", () => {
    expect(buildStyles("nope", "bottom-right")).toContain("--al-primary: #2563eb");
  });

  it("isoleert de widget van de pagina met een host-reset", () => {
    expect(buildStyles("#2563eb", "bottom-right")).toContain(":host { all: initial; }");
  });
});
