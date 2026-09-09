import { describe, it, expect, vi, afterEach } from "vitest";
import {
  pinFingerprint,
  newDeviceToken,
  newPairingCode,
  tokenHash,
  assertSameTerminal,
  assertProgramConfirmation,
  requireAlternativeReason,
} from "./domain/terminal-policy";
import {
  identifySchema,
  pairingSchema,
} from "./validators/terminals.validators";
afterEach(() => vi.unstubAllEnvs());
describe("terminal trust boundaries", () => {
  it("accepts only four ASCII digits, with no account or terminal identity supplied by the caller", () => {
    expect(identifySchema.safeParse({ pin: "0123" }).success).toBe(true);
    for (const pin of ["123", "12345", "１２３４", "12a4"])
      expect(identifySchema.safeParse({ pin }).success).toBe(false);
    expect(identifySchema.safeParse({ pin: "1234", user_id: 1 }).success).toBe(
      false,
    );
  });
  it("does not treat a public tablet label as a pairing credential", () => {
    expect(
      pairingSchema.safeParse({ code: "TAB-0001", kind: "OPERATOR" }).success,
    ).toBe(false);
    expect(newPairingCode()).toMatch(/^[A-F0-9]{32}$/);
  });
  it("uses a server secret and site separation instead of reversible PIN storage", () => {
    vi.stubEnv(
      "TERMINAL_PIN_PEPPER",
      "test-only-1038-pepper-not-a-production-secret",
    );
    const hash = pinFingerprint("A", "0123");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toBe(tokenHash("0123"));
    expect(pinFingerprint("B", "0123")).not.toBe(hash);
    vi.stubEnv("TERMINAL_PIN_PEPPER", "");
    expect(() => pinFingerprint("A", "0123")).toThrow();
  });
  it("does not reuse device secrets or accept cross-tablet operator sessions", () => {
    const a = newDeviceToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDeviceToken()).not.toBe(a);
    expect(() => assertSameTerminal("one", "two")).toThrow();
    expect(() => assertSameTerminal("one", undefined)).toThrow();
  });
  it("requires a fresh confirmation of the exact applicable CN version", () => {
    expect(() =>
      assertProgramConfirmation("new-version", "old-version"),
    ).toThrow();
    expect(() => assertProgramConfirmation(null, "version")).toThrow();
    expect(() => assertProgramConfirmation("same", "same")).not.toThrow();
  });
  it("requires an explanation when choosing another planned operation", () => {
    expect(() =>
      requireAlternativeReason("first", "second", undefined),
    ).toThrow();
    expect(() =>
      requireAlternativeReason(
        "first",
        "second",
        "Priorité confirmée au poste",
      ),
    ).not.toThrow();
    expect(() =>
      requireAlternativeReason("first", "first", undefined),
    ).not.toThrow();
  });
});
