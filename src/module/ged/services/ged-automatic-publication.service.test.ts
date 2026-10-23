import { beforeEach, describe, expect, it, vi } from "vitest";
import { roleHasGedCapability } from "../domain/ged-policy";
import type { AutomaticPublicationSource } from "../repository/ged-automatic-publication.repository";

const m = vi.hoisted(() => ({ source: vi.fn(), parent: vi.fn(), obsolete: vi.fn(), status: vi.fn(), current: vi.fn(), log: vi.fn() }));
vi.mock("../repository/ged-automatic-publication.repository", () => ({ repoLockAutomaticPublicationSource: m.source }));
vi.mock("./ged-parent-authorization.service", () => ({ assertGedParentLinkWritable: m.parent }));
vi.mock("../repository/ged.repository", () => ({ repoObsoletePreviousApplicable: m.obsolete,
  repoSetVersionStatus: m.status, repoSetCurrentVersion: m.current, repoLogAccess: m.log }));
import { automaticallyPublishCleanUpload, canAutomaticallyPublishGedUpload } from "./ged-automatic-publication.service";

const source: AutomaticPublicationSource = { document_id: "document", version_id: "version", status: "BROUILLON",
  archived: false, held: false, checked_out_by_other: false, scan_status: "clean", quarantine_status: "released",
  scan_matches_blob: true, links: [{ entity_type: "PIECE_TECHNIQUE", entity_id: "piece" }] };
const tx = { query: vi.fn() };
const actor = { id: 7, role: "Commercial" };

beforeEach(() => { vi.clearAllMocks(); m.source.mockResolvedValue({ ...source }); m.parent.mockResolvedValue({}); });

describe("automatic document availability after antivirus", () => {
  it.each([
    { scan_status: "infected" }, { scan_status: "pending" }, { scan_status: "scan_failed" }, { scan_status: null },
    { quarantine_status: "quarantined" }, { quarantine_status: "deleted" }, { quarantine_status: null },
    { scan_matches_blob: false }, { archived: true }, { held: true }, { checked_out_by_other: true },
    { status: "APPLICABLE" }, { status: "OBSOLETE" }, { status: "EN_REVUE" },
  ])("does not publish an ineligible version: %j", async (change) => {
    m.source.mockResolvedValue({ ...source, ...change });
    expect(canAutomaticallyPublishGedUpload({ ...source, ...change })).toBe(false);
    await expect(automaticallyPublishCleanUpload(tx, actor, "document", "version")).resolves.toBe(false);
    expect(m.status).not.toHaveBeenCalled(); expect(m.obsolete).not.toHaveBeenCalled();
  });
  it.each(["PIECE_TECHNIQUE", "CLIENT", "FOURNISSEUR", "ORDRE_FABRICATION", "AFFAIRE", "FACTURE"])(
    "uses the same server policy for authorised uploads in %s", async (entity_type) => {
      m.source.mockResolvedValue({ ...source, links: [{ entity_type, entity_id: "parent" }] });
      await expect(automaticallyPublishCleanUpload(tx, actor, "document", "version")).resolves.toBe(true);
      expect(m.parent).toHaveBeenCalledWith(7, { entity_type, entity_id: "parent" });
      expect(m.obsolete).toHaveBeenCalledWith(tx, "document", "version");
      expect(m.status).toHaveBeenCalledWith(tx, "version", "APPLICABLE", 7);
      expect(m.current).toHaveBeenCalledWith(tx, "document", "version");
      expect(m.log).toHaveBeenCalledWith(tx, expect.objectContaining({ event_type: "PUBLISH",
        details: expect.objectContaining({ publication_mode: "AUTOMATIC_AFTER_CLEAN_SCAN", human_approval: false }) }));
    });
  it("retains manual publication permissions and records the automated policy instead of a human approval", async () => {
    expect(roleHasGedCapability(actor.role, "publish")).toBe(false);
    await expect(automaticallyPublishCleanUpload(tx, actor, "document", "version")).resolves.toBe(true);
    expect(m.log).toHaveBeenCalledOnce();
  });
  it("refuses upload rights and parent access before replacing the previous applicable version", async () => {
    await expect(automaticallyPublishCleanUpload(tx, { id: 8, role: "Visiteur" }, "document", "version")).rejects.toMatchObject({ status: 403 });
    expect(m.source).not.toHaveBeenCalled();
    m.parent.mockRejectedValue(new Error("parent inaccessible"));
    await expect(automaticallyPublishCleanUpload(tx, actor, "document", "version")).rejects.toThrow("parent inaccessible");
    expect(m.obsolete).not.toHaveBeenCalled();
  });
  it("propagates audit failure to the enclosing upload transaction", async () => {
    m.log.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(automaticallyPublishCleanUpload(tx, actor, "document", "version")).rejects.toThrow("audit unavailable");
  });
});
