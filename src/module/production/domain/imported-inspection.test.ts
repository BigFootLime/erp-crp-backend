import { describe, expect, it } from "vitest";
import { importedInspection } from "./imported-inspection";
const sheet = { id: "doc", version_id: "version", sha256: "a".repeat(64), role: "FICHE_AUTOCONTROLE", original_name: "MD07.xlsx" };
describe("Imported inspection source", () => {
  it("recognizes the existing spreadsheet without requesting another upload", () => expect(importedInspection([sheet])).toEqual(sheet));
  it("does not confuse other records or operator improvement feedback with a blank inspection sheet", () => {
    expect(importedInspection([{ ...sheet, role: "DOCUMENT" }, { ...sheet, role: "FICHE_AMELIORATION" }])).toBeNull();
  });
  it("does not silently choose between multiple current templates", () => expect(importedInspection([sheet, { ...sheet, id: "another" }])).toBeNull());
  it("rejects an unpinned or malformed content hash", () => {
    expect(importedInspection([{ ...sheet, sha256: null }])).toBeNull();
    expect(importedInspection([{ ...sheet, sha256: "unknown" }])).toBeNull();
  });
});
