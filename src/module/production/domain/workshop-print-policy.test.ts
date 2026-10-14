import { describe, expect, it } from "vitest";
import { nextWorkshopOfficialOrdinal, workshopCopyMark, type WorkshopCopyStatus } from "./workshop-print-policy";

describe("manufacturing folder copy identification", () => {
  it("keeps the first official original unmarked and identifies subsequent copies", () => {
    expect(workshopCopyMark("OFFICIEL", nextWorkshopOfficialOrdinal(0))).toBeNull();
    expect(workshopCopyMark("OFFICIEL", nextWorkshopOfficialOrdinal(1))).toBe("DUPLICATA");
    expect(workshopCopyMark("OFFICIEL", 17)).toBe("DUPLICATA");
  });
  it("never turns a draft into an original or duplicata, however many draft outputs exist", () => {
    expect(workshopCopyMark("BROUILLON", null)).toBe("BROUILLON");
    expect(workshopCopyMark("BROUILLON", 1)).toBe("BROUILLON");
    expect(workshopCopyMark("BROUILLON", 50)).toBe("BROUILLON");
    expect(workshopCopyMark("OFFICIEL", 1)).toBeNull();
  });
  it("keeps an obsolete definition visibly obsolete", () => {
    expect(workshopCopyMark("OBSOLETE", 1)).toBe("OBSOLETE");
    expect(workshopCopyMark("OBSOLETE", 2)).toBe("OBSOLETE");
  });
  it("does not hide an unknown or corrupt official history by inventing a first copy", () => {
    expect(() => workshopCopyMark("UNKNOWN" as WorkshopCopyStatus, 1)).toThrow();
    for (const ordinal of [null, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => workshopCopyMark("OFFICIEL", ordinal)).toThrow();
    }
    for (const previous of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) expect(() => nextWorkshopOfficialOrdinal(previous)).toThrow();
  });
});
