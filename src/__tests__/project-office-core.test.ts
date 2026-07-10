import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/project-office/repository/project-office.repository", async (io) => {
  const actual = await io<typeof import("../module/project-office/repository/project-office.repository")>();
  return {
    ...actual,
    withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn() })),
    insertAuditLog: vi.fn(async () => undefined),
    insertProjectActivity: vi.fn(async () => undefined),
    repoGetProjectAccess: vi.fn(),
    repoCreateProject: vi.fn(),
    repoGetProjectById: vi.fn(),
    repoUserExists: vi.fn(),
    repoUpsertMember: vi.fn(),
  };
});
vi.mock("../module/project-office/repository/project-office-work.repository", () => ({
  repoGetWorkPackageById: vi.fn(),
  repoListWorkPackages: vi.fn(),
  repoListAllWorkPackages: vi.fn(),
  repoNextWorkPackageCode: vi.fn(),
  repoCreateWorkPackage: vi.fn(),
  repoPatchWorkPackage: vi.fn(),
  repoCreateDependency: vi.fn(),
  repoListProjectDependencies: vi.fn(),
  repoDependencyPathExists: vi.fn(),
  repoCreateComment: vi.fn(),
  repoListComments: vi.fn(),
  repoListMilestones: vi.fn(),
  repoGetMilestoneById: vi.fn(),
  repoCreateMilestone: vi.fn(),
  repoPatchMilestone: vi.fn(),
}));
vi.mock("../module/project-office/repository/project-office-registers.repository", () => ({
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
  repoListSpecs: vi.fn(),
  repoGetSpecById: vi.fn(),
  repoCreateSpec: vi.fn(),
  repoSetSpecStatus: vi.fn(),
  repoListSpecVersions: vi.fn(),
  repoGetSpecVersionById: vi.fn(),
  repoCreateSpecVersion: vi.fn(),
  repoApproveSpecVersion: vi.fn(),
  repoCreateExternalLink: vi.fn(),
  repoGetExternalEntityProjectId: vi.fn(),
  repoListExternalLinks: vi.fn(),
}));

import * as baseRepo from "../module/project-office/repository/project-office.repository";
import * as workRepo from "../module/project-office/repository/project-office-work.repository";
import * as regRepo from "../module/project-office/repository/project-office-registers.repository";
import * as projectsSvc from "../module/project-office/services/project-office-projects.service";
import * as workSvc from "../module/project-office/services/project-office-work.service";
import * as regSvc from "../module/project-office/services/project-office-registers.service";

const base = vi.mocked(baseRepo);
const work = vi.mocked(workRepo);
const reg = vi.mocked(regRepo);

const AUDIT = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };
const OWNER = { id: 42, role: "Directeur" };
const P = "11111111-1111-4111-8111-111111111111";
const WP1 = "22222222-2222-4222-8222-222222222222";
const WP2 = "33333333-3333-4333-8333-333333333333";

const ownerAccess = { project_id: P, visibility: "PRIVATE" as const, owner_id: 42, effective_role: "OWNER" as const };

beforeEach(() => vi.clearAllMocks());

describe("Projets", () => {
  it("createProject : owner = acteur (jamais du body), activité + audit écrits", async () => {
    base.repoCreateProject.mockImplementation(async (_tx, i) => ({
      id: P, code: i.code, name: i.name, description: null, owner_id: i.owner_id,
      visibility: "PRIVATE", status: "DRAFT", start_date: null, target_date: null, created_at: "t", updated_at: "t",
    }));
    const r = await projectsSvc.createProject(OWNER, { code: "cerp", name: "CERP", visibility: "PRIVATE", status: "DRAFT" }, AUDIT);
    expect(r.owner_id).toBe(42);
    expect(r.code).toBe("CERP"); // upper-case normalisé
    expect(base.insertProjectActivity).toHaveBeenCalledOnce();
    expect(base.insertAuditLog).toHaveBeenCalledOnce();
    expect(base.insertAuditLog.mock.calls[0][2].action).toBe("project-office.project.create");
  });
  it("code déjà pris → 409 PO_PROJECT_CODE_TAKEN", async () => {
    base.repoCreateProject.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(projectsSvc.createProject(OWNER, { code: "X", name: "x", visibility: "PRIVATE", status: "DRAFT" }, AUDIT))
      .rejects.toMatchObject({ status: 409, code: "PO_PROJECT_CODE_TAKEN" });
  });
  it("addMember refuse le rôle OWNER et exige un user existant", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    await expect(projectsSvc.addMember(OWNER, P, { user_id: 9, role: "OWNER" }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "PO_MEMBER_OWNER_FIXED" });
    base.repoUserExists.mockResolvedValue(false);
    await expect(projectsSvc.addMember(OWNER, P, { user_id: 9, role: "VIEWER" }, AUDIT))
      .rejects.toMatchObject({ status: 404, code: "PO_USER_NOT_FOUND" });
  });
});

describe("Work packages", () => {
  it("createWorkPackage : code auto WP-00x, reporter = acteur, audit tx", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoNextWorkPackageCode.mockResolvedValue("WP-001");
    work.repoCreateWorkPackage.mockImplementation(async (_tx, i) => ({
      id: WP1, project_id: i.project_id, parent_id: null, code: i.code, title: i.title, description: null,
      type: i.type, status: i.status, priority: i.priority, assignee_id: null, assignee_username: null,
      reporter_id: i.reporter_id, start_date: null, due_date: null, progress_percent: 0,
      estimated_hours: null, spent_hours: null, created_at: "t", updated_at: "t",
    }) as never);
    const wp = await workSvc.createWorkPackage(OWNER, {
      project_id: P, title: "Tâche 1", type: "TASK", status: "BACKLOG", priority: "NORMAL",
    }, AUDIT);
    expect(wp.code).toBe("WP-001");
    expect(wp.reporter_id).toBe(42);
    expect(base.insertAuditLog).toHaveBeenCalled();
  });
  it("createWorkPackage accepte un code métier explicite normalisé", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoCreateWorkPackage.mockImplementation(async (_tx, i) => ({
      id: WP1, project_id: i.project_id, parent_id: null, code: i.code, title: i.title, description: null,
      type: i.type, status: i.status, priority: i.priority, assignee_id: null, assignee_username: null,
      reporter_id: i.reporter_id, start_date: null, due_date: null, progress_percent: 0,
      estimated_hours: null, spent_hours: null, created_at: "t", updated_at: "t",
    }) as never);
    const wp = await workSvc.createWorkPackage(OWNER, {
      project_id: P, code: "ui-gov-01", title: "Audit UI", type: "AUDIT", status: "IN_PROGRESS", priority: "HIGH",
    }, AUDIT);
    expect(wp.code).toBe("UI-GOV-01");
    expect(work.repoNextWorkPackageCode).not.toHaveBeenCalled();
  });
  it("retourne 409 quand un code métier explicite existe déjà", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoCreateWorkPackage.mockRejectedValue(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(workSvc.createWorkPackage(OWNER, {
      project_id: P, code: "UI-GOV", title: "Gouvernance", type: "EPIC", status: "IN_PROGRESS", priority: "HIGH",
    }, AUDIT)).rejects.toMatchObject({ status: 409, code: "PO_WP_CODE_TAKEN" });
    expect(work.repoNextWorkPackageCode).not.toHaveBeenCalled();
  });
  it("dates incohérentes → 400", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    await expect(workSvc.createWorkPackage(OWNER, {
      project_id: P, title: "x", type: "TASK", status: "BACKLOG", priority: "NORMAL",
      start_date: "2026-08-10", due_date: "2026-08-01",
    }, AUDIT)).rejects.toMatchObject({ status: 400, code: "PO_WP_BAD_DATES" });
  });
  it("dépendance vers soi-même → 400 PO_DEP_SELF", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById.mockResolvedValue({ id: WP1, project_id: P } as never);
    await expect(workSvc.addDependency(OWNER, WP1, { target_work_package_id: WP1, dependency_type: "BLOCKS" }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "PO_DEP_SELF" });
  });
  it("dépendance inter-projets → 400 ; cycle BLOCKS → 409", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById
      .mockResolvedValueOnce({ id: WP1, project_id: P, code: "WP-001" } as never)
      .mockResolvedValueOnce({ id: WP2, project_id: "99999999-9999-4999-8999-999999999999", code: "WP-002" } as never);
    await expect(workSvc.addDependency(OWNER, WP1, { target_work_package_id: WP2, dependency_type: "BLOCKS" }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "PO_DEP_CROSS_PROJECT" });

    work.repoGetWorkPackageById
      .mockResolvedValueOnce({ id: WP1, project_id: P, code: "WP-001" } as never)
      .mockResolvedValueOnce({ id: WP2, project_id: P, code: "WP-002" } as never);
    work.repoDependencyPathExists.mockResolvedValue(true);
    await expect(workSvc.addDependency(OWNER, WP1, { target_work_package_id: WP2, dependency_type: "BLOCKS" }, AUDIT))
      .rejects.toMatchObject({ status: 409, code: "PO_DEP_CYCLE" });
  });
  it("dépendance valide → créée + audit", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById
      .mockResolvedValueOnce({ id: WP1, project_id: P, code: "WP-001" } as never)
      .mockResolvedValueOnce({ id: WP2, project_id: P, code: "WP-002" } as never);
    work.repoDependencyPathExists.mockResolvedValue(false);
    work.repoCreateDependency.mockResolvedValue({ id: "d1", source_work_package_id: WP1, target_work_package_id: WP2, dependency_type: "BLOCKS", created_at: "t" });
    const dep = await workSvc.addDependency(OWNER, WP1, { target_work_package_id: WP2, dependency_type: "BLOCKS" }, AUDIT);
    expect(dep.id).toBe("d1");
    expect(base.insertAuditLog.mock.calls[0][2].action).toBe("project-office.dependency.create");
  });
  it("patch status DONE force progress 100", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById.mockResolvedValue({ id: WP1, project_id: P, start_date: null, due_date: null } as never);
    work.repoPatchWorkPackage.mockImplementation(async (_tx, _id, patch) => ({ id: WP1, project_id: P, ...(patch as object) }) as never);
    await workSvc.patchWorkPackage(OWNER, WP1, { status: "DONE" }, AUDIT);
    expect(work.repoPatchWorkPackage.mock.calls[0][2]).toMatchObject({ status: "DONE", progress_percent: 100 });
  });
  it("refuse un parent descendant qui créerait un cycle hiérarchique", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById
      .mockResolvedValueOnce({ id: WP1, project_id: P, parent_id: null, start_date: null, due_date: null } as never)
      .mockResolvedValueOnce({ id: WP2, project_id: P, parent_id: WP1 } as never);
    work.repoListAllWorkPackages.mockResolvedValue([
      { id: WP1, project_id: P, parent_id: null } as never,
      { id: WP2, project_id: P, parent_id: WP1 } as never,
    ]);
    await expect(workSvc.patchWorkPackage(OWNER, WP1, { parent_id: WP2 }, AUDIT))
      .rejects.toMatchObject({ status: 409, code: "PO_WP_PARENT_CYCLE" });
  });
  it("retourne les données Gantt du projet autorisé", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoListAllWorkPackages.mockResolvedValue([{ id: WP1, project_id: P } as never]);
    work.repoListMilestones.mockResolvedValue([{ id: "m1", project_id: P } as never]);
    work.repoListProjectDependencies.mockResolvedValue([{ id: "d1", source_work_package_id: WP1, target_work_package_id: WP2 } as never]);
    const gantt = await workSvc.getGanttData(OWNER, P);
    expect(gantt.work_packages).toHaveLength(1);
    expect(gantt.milestones).toHaveLength(1);
    expect(gantt.dependencies).toHaveLength(1);
  });
  it("retourne les colonnes Kanban depuis les tâches du projet autorisé", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoListAllWorkPackages.mockResolvedValue([
      { id: WP1, project_id: P, status: "BACKLOG" } as never,
      { id: WP2, project_id: P, status: "DONE" } as never,
    ]);
    const kanban = await workSvc.getKanbanData(OWNER, P);
    expect(kanban.work_packages.map((wp) => wp.status)).toEqual(["BACKLOG", "DONE"]);
  });
});

describe("Registres", () => {
  it("createDecision : décideur = acteur, audit", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    reg.repoCreateDecision.mockImplementation(async (_tx, i) => ({ id: "dec1", ...i, decided_at: "t", created_at: "t" }) as never);
    const d = await regSvc.createDecision(OWNER, P, { title: "Choix Gantt maison", decision: "MVP CSS/SVG" }, AUDIT);
    expect(d.decided_by).toBe(42);
    expect(base.insertAuditLog.mock.calls[0][2].action).toBe("project-office.decision.create");
  });
  it("createRisk : renvoie la sévérité calculée + audit", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    reg.repoCreateRisk.mockImplementation(async (_tx, i) => ({ id: "r1", ...i, severity: i.probability * i.impact, status: "OPEN", created_at: "t", updated_at: "t" }) as never);
    const r = await regSvc.createRisk(OWNER, P, { title: "Fuite données internes", probability: 2, impact: 5 }, AUDIT);
    expect(r.severity).toBe(10);
  });
  it("createEvidence : lecteur seul → 403, contributeur → OK", async () => {
    base.repoGetProjectAccess.mockResolvedValue({ ...ownerAccess, owner_id: 1, effective_role: "VIEWER" });
    await expect(regSvc.createEvidence({ id: 7, role: "Employee" }, P, { type: "PR", title: "PR #1" }, AUDIT))
      .rejects.toMatchObject({ status: 403 });
    base.repoGetProjectAccess.mockResolvedValue({ ...ownerAccess, owner_id: 1, effective_role: "CONTRIBUTOR" });
    reg.repoCreateEvidence.mockImplementation(async (_tx, i) => ({ id: "e1", ...i, created_at: "t" }) as never);
    const e = await regSvc.createEvidence({ id: 7, role: "Employee" }, P, { type: "PR", title: "PR #1", url: "https://github.com/x/y/pull/1" }, AUDIT);
    expect(e.created_by).toBe(7);
  });
  it("refuse une preuve liée à une tâche d'un autre projet", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    work.repoGetWorkPackageById.mockResolvedValue({ id: WP2, project_id: "99999999-9999-4999-8999-999999999999" } as never);
    await expect(regSvc.createEvidence(OWNER, P, { type: "TEST", title: "Suite", work_package_id: WP2 }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "PO_WP_BAD_PROJECT" });
  });
  it("refuse un lien externe vers une entité d'un autre projet", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    reg.repoGetExternalEntityProjectId.mockResolvedValue("99999999-9999-4999-8999-999999999999");
    await expect(regSvc.createExternalLink(OWNER, {
      project_id: P, entity_type: "work_package", entity_id: WP2,
      provider: "GITHUB", external_type: "PR", url: "https://github.com/example/repo/pull/1",
    }, AUDIT)).rejects.toMatchObject({ status: 400, code: "PO_EXTERNAL_ENTITY_BAD_PROJECT" });
  });
  it("action corrective avec preuve d'un autre projet → 400", async () => {
    base.repoGetProjectAccess.mockResolvedValue(ownerAccess);
    reg.repoGetEvidenceById.mockResolvedValue({ id: "e9", project_id: "99999999-9999-4999-8999-999999999999" } as never);
    await expect(regSvc.createAction(OWNER, P, { source_type: "AUDIT", title: "x", priority: "NORMAL", evidence_id: "e9" }, AUDIT))
      .rejects.toMatchObject({ status: 400, code: "PO_EVIDENCE_BAD_PROJECT" });
  });
});
