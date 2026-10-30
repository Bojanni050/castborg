import { describe, expect, it } from "vitest";
import { isSessionFresh } from "../src/session";

function tokenWith(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ conversationId: "x", exp }), "utf8").toString("base64url");
  return `${payload}.signature`;
}

describe("sessietoken", () => {
  it("is vers zolang de exp ruim in de toekomst ligt", () => {
    const now = 1_700_000_000_000;
    expect(isSessionFresh(tokenWith(now / 1000 + 600), now)).toBe(true);
  });

  it("is verlopen als de exp voorbij is", () => {
    const now = 1_700_000_000_000;
    expect(isSessionFresh(tokenWith(now / 1000 - 1), now)).toBe(false);
  });

  it("vervalt binnen de marge van 30 seconden", () => {
    const now = 1_700_000_000_000;
    expect(isSessionFresh(tokenWith(now / 1000 + 10), now)).toBe(false);
  });

  it("is nooit vers zonder leesbare exp", () => {
    expect(isSessionFresh("geen-token")).toBe(false);
    expect(isSessionFresh("abc.def")).toBe(false);
  });
});
