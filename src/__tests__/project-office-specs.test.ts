import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/project-office/repository/project-office.repository", async (io) => {
  const actual = await io<typeof import("../module/project-office/repository/project-office.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
    insertProjectActivity: vi.fn(async () => undefined),
    repoGetProjectAccess: vi.fn(),
  };
});
vi.mock("../module/project-office/repository/project-office-registers.repository", () => ({
  repoListSpecs: vi.fn(),
  repoGetSpecById: vi.fn(),
  repoCreateSpec: vi.fn(),
  repoSetSpecStatus: vi.fn(),
  repoListSpecVersions: vi.fn(),
  repoGetSpecVersionById: vi.fn(),
  repoCreateSpecVersion: vi.fn(),
  repoApproveSpecVersion: vi.fn(),
  repoCreateEvidence: vi.fn(),
  repoGetEvidenceById: vi.fn(),
  repoListEvidence: vi.fn(),
  repoCreateDecision: vi.fn(),
  repoListDecisions: vi.fn(),
  repoCreateRisk: vi.fn(),
  repoListRisks: vi.fn(),
  repoGetRiskById: vi.fn(),
  repoPatchRisk: vi.fn(),
  repoCreateAction: vi.fn(),
  repoListActions: vi.fn(),
  repoGetActionById: vi.fn(),
  repoPatchAction: vi.fn(),
  repoCreateExternalLink: vi.fn(),
  repoListExternalLinks: vi.fn(),
}));

import * as baseRepo from "../module/project-office/repository/project-office.repository";
import * as regRepo from "../module/project-office/repository/project-office-registers.repository";
import * as svc from "../module/project-office/services/project-office-registers.service";

const base = vi.mocked(baseRepo);
const reg = vi.mocked(regRepo);

const AUDIT = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const AUTEUR = { id: 42, role: "Directeur" };
const APPROBATEUR = { id: 43, role: "Directeur" };
const P = "11111111-1111-4111-8111-111111111111";
const SPEC = "44444444-4444-4444-8444-444444444444";
const V1 = "55555555-5555-4555-8555-555555555555";

const manage = { project_id: P, visibility: "PRIVATE" as const, owner_id: 42, effective_role: "OWNER" as const };
const manage43 = { project_id: P, visibility: "PRIVATE" as const, owner_id: 1, effective_role: "MANAGER" as const };

beforeEach(() => vi.clearAllMocks());

describe("Cahier des charges versionné", () => {
  it("createSpec avec contenu initial → v1.0 créée", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage);
    reg.repoCreateSpec.mockResolvedValue({ id: SPEC, project_id: P, title: "CDC CERP", status: "DRAFT", current_version_id: null, current_version: null, created_at: "t", updated_at: "t" });
    reg.repoCreateSpecVersion.mockImplementation(async (_tx, i) => ({ id: V1, spec_id: i.spec_id, version: i.version, content_markdown: i.content_markdown, change_summary: i.change_summary, author_id: i.author_id, approved_by: null, approved_at: null, created_at: "t" }));
    const spec = await svc.createSpec(AUTEUR, P, { title: "CDC CERP", content_markdown: "# V1" }, AUDIT);
    expect(spec.current_version).toBe("1.0");
    expect(reg.repoCreateSpecVersion.mock.calls[0][1].author_id).toBe(42);
  });
  it("version dupliquée → 409", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage);
    reg.repoGetSpecById.mockResolvedValue({ id: SPEC, project_id: P, status: "DRAFT", current_version_id: V1 } as never);
    reg.repoCreateSpecVersion.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(svc.createSpecVersion(AUTEUR, SPEC, { version: "1.0", content_markdown: "x" }, AUDIT))
      .rejects.toMatchObject({ status: 409, code: "PO_SPEC_VERSION_TAKEN" });
  });
  it("nouvelle version sur une spec APPROVED → repasse en DRAFT (l'approuvée reste figée en historique)", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage);
    reg.repoGetSpecById.mockResolvedValue({ id: SPEC, project_id: P, status: "APPROVED", current_version_id: V1 } as never);
    reg.repoCreateSpecVersion.mockImplementation(async (_tx, i) => ({ id: "v2", spec_id: SPEC, version: i.version, content_markdown: i.content_markdown, change_summary: null, author_id: i.author_id, approved_by: null, approved_at: null, created_at: "t" }));
    await svc.createSpecVersion(AUTEUR, SPEC, { version: "2.0", content_markdown: "# V2" }, AUDIT);
    expect(reg.repoSetSpecStatus).toHaveBeenCalledWith(expect.anything(), SPEC, "DRAFT");
  });
  it("approve : l'auteur ne peut PAS approuver sa propre version → 403", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage);
    reg.repoGetSpecById.mockResolvedValue({ id: SPEC, project_id: P, status: "REVIEW", current_version_id: V1 } as never);
    reg.repoGetSpecVersionById.mockResolvedValue({ id: V1, spec_id: SPEC, version: "1.0", author_id: 42, approved_at: null } as never);
    await expect(svc.approveSpec(AUTEUR, SPEC, AUDIT)).rejects.toMatchObject({ status: 403, code: "PO_SPEC_SELF_APPROVE" });
  });
  it("approve par un manager tiers → APPROVED + version horodatée + audit", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage43);
    reg.repoGetSpecById.mockResolvedValue({ id: SPEC, project_id: P, status: "REVIEW", current_version_id: V1 } as never);
    reg.repoGetSpecVersionById.mockResolvedValue({ id: V1, spec_id: SPEC, version: "1.0", author_id: 42, approved_at: null } as never);
    reg.repoApproveSpecVersion.mockResolvedValue({ id: V1, spec_id: SPEC, version: "1.0", content_markdown: "x", change_summary: null, author_id: 42, approved_by: 43, approved_at: "t", created_at: "t" });
    const r = await svc.approveSpec(APPROBATEUR, SPEC, AUDIT);
    expect(r.spec.status).toBe("APPROVED");
    expect(r.version.approved_by).toBe(43);
    expect(reg.repoSetSpecStatus).toHaveBeenCalledWith(expect.anything(), SPEC, "APPROVED");
    expect(base.insertAuditLog.mock.calls[0][2].action).toBe("project-office.spec.approve");
  });
  it("passer en REVIEW sans version → 409", async () => {
    base.repoGetProjectAccess.mockResolvedValue(manage);
    reg.repoGetSpecById.mockResolvedValue({ id: SPEC, project_id: P, status: "DRAFT", current_version_id: null } as never);
    await expect(svc.patchSpecStatus(AUTEUR, SPEC, "REVIEW", AUDIT)).rejects.toMatchObject({ status: 409, code: "PO_SPEC_NO_VERSION" });
  });
});
