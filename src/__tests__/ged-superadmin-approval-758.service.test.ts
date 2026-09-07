import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ superadmin: vi.fn(), version: vi.fn(), setStatus: vi.fn(), approval: vi.fn(), log: vi.fn(), tx: {} }));
vi.mock("../module/access-control/repository/access-control.repository", () => ({ repoIsSuperadmin: mocks.superadmin }));
vi.mock("../module/ged/repository/ged.repository", async (original) => ({
  ...await original<typeof import("../module/ged/repository/ged.repository")>(),
  withGedTransaction: (fn: (tx: object) => Promise<unknown>) => fn(mocks.tx),
  repoGetVersionForUpdate: mocks.version,
  repoSetVersionStatus: mocks.setStatus,
  repoInsertApproval: mocks.approval,
  repoLogAccess: mocks.log,
  repoGetDocumentDetail: vi.fn().mockResolvedValue({ id: "document" }),
}));
import { approveVersion } from "../module/ged/services/ged.service";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.version.mockResolvedValue({ id: "version", document_id: "document", created_by: 42, version_number: 1, status: "EN_REVUE" });
  mocks.superadmin.mockResolvedValue(false);
});
describe("#758 — approbation GED du superutilisateur", () => {
  it("refuse un auteur même nommé Administrateur si le droit de compte est absent", async () => {
    await expect(approveVersion({ id: 42, role: "Administrateur" }, "version", null)).rejects.toMatchObject({ code: "GED_APPROVAL_SELF" });
    expect(mocks.superadmin).toHaveBeenCalledWith(42, mocks.tx);
    expect(mocks.setStatus).not.toHaveBeenCalled();
    expect(mocks.approval).not.toHaveBeenCalled();
  });
  it("conserve l'identité réelle et journalise l'exception vérifiée en base", async () => {
    mocks.superadmin.mockResolvedValue(true);
    await approveVersion({ id: 42, role: "Administrateur" }, "version", "Plan de recette vérifié");
    expect(mocks.setStatus).toHaveBeenCalledWith(mocks.tx, "version", "APPROUVE", 42);
    expect(mocks.approval).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ decided_by: 42, comment: expect.stringContaining("superutilisateur actif") }));
    expect(mocks.log).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ actor_id: 42, details: expect.objectContaining({ self_approval_by_superadmin: true, approval_policy: "ged-758" }) }));
  });
  it("refuse après révocation et échoue fermée si le contrôle de droit échoue", async () => {
    mocks.superadmin.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(approveVersion({ id: 42, role: "Administrateur" }, "version", null)).rejects.toThrow("Database unavailable");
    expect(mocks.setStatus).not.toHaveBeenCalled();
  });
  it("conserve le parcours d'un approbateur distinct habilité", async () => {
    await approveVersion({ id: 7, role: "Qualité" }, "version", "Revue indépendante");
    expect(mocks.superadmin).not.toHaveBeenCalled();
    expect(mocks.setStatus).toHaveBeenCalledWith(mocks.tx, "version", "APPROUVE", 7);
    expect(mocks.log).toHaveBeenCalledWith(mocks.tx, expect.objectContaining({ details: expect.objectContaining({ self_approval_by_superadmin: false }) }));
  });
});
