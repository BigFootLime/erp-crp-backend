import { describe, expect, it } from "vitest";

import {
  createMatiereSousEtatSchema,
  updateMatiereSousEtatSchema,
} from "./stock.validators";

describe("matiere sous-etat informations validation", () => {
  it("accepts an optional trimmed paragraph and preserves the code-only flow", () => {
    const withInformation = createMatiereSousEtatSchema.parse({
      body: { code: "RECT", informations: "  Rectification après usinage.\nContrôle visuel requis.  " },
    }).body;
    const codeOnly = createMatiereSousEtatSchema.parse({ body: { code: "BRUT" } }).body;

    expect(withInformation.informations).toBe("Rectification après usinage.\nContrôle visuel requis.");
    expect(codeOnly.informations).toBeNull();
    expect(codeOnly.designation).toBeNull();
  });

  it("allows an information paragraph to be cleared and enforces the shared length limit", () => {
    expect(updateMatiereSousEtatSchema.parse({ body: { informations: null } }).body.informations).toBeNull();
    expect(updateMatiereSousEtatSchema.safeParse({ body: { informations: "X".repeat(10_001) } }).success).toBe(false);
    expect(updateMatiereSousEtatSchema.safeParse({ body: { informations: "X".repeat(10_000) } }).success).toBe(true);
  });
});
