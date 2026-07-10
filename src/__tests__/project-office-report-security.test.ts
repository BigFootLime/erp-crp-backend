import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../module/project-office/services/project-office-access.service", () => ({
  requireProjectAccess: vi.fn(async () => ({ effective_role: "OWNER" })),
}));

vi.mock("../module/project-office/repository/project-office.repository", () => ({
  withTransaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn({ query: vi.fn() })),
  insertAuditLog: vi.fn(async () => undefined),
  insertProjectActivity: vi.fn(async () => undefined),
  isPgUniqueViolation: vi.fn(() => false),
  repoGetProjectById: vi.fn(),
}));

vi.mock("../module/project-office/repository/project-office-work.repository", () => ({
  repoGetWorkPackageById: vi.fn(),
}));

vi.mock("../module/project-office/repository/project-office-registers.repository", () => ({
  repoGetEvidenceById: vi.fn(),
}));

vi.mock("../module/project-office/repository/project-office-report.repository", () => ({
  repoCreateWorkLog: vi.fn(),
  repoCreateErrorRecord: vi.fn(),
  repoCreateAsset: vi.fn(),
  repoGetAssetById: vi.fn(),
  repoGetEntryProjectId: vi.fn(),
}));

import * as reportRepo from "../module/project-office/repository/project-office-report.repository";
import * as workRepo from "../module/project-office/repository/project-office-work.repository";
import {
  createAsset,
  createErrorRecord,
  createWorkLog,
} from "../module/project-office/services/project-office-report.service";

const report = vi.mocked(reportRepo);
const work = vi.mocked(workRepo);
const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "99999999-9999-4999-8999-999999999999";
const RESOURCE = "22222222-2222-4222-8222-222222222222";
const ACTOR = { id: 42, role: "Directeur" };
const AUDIT = { user_id: 42, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: null, client_session_id: null };

beforeEach(() => vi.clearAllMocks());

describe("Project Office report references", () => {
  it("refuse un journal lié à une tâche d'un autre projet", async () => {
    work.repoGetWorkPackageById.mockResolvedValue({ id: RESOURCE, project_id: OTHER_PROJECT } as never);
    await expect(createWorkLog(ACTOR, PROJECT, {
      work_package_id: RESOURCE,
      action_type: "CODE_CHANGE",
      title: "Modification",
    }, AUDIT)).rejects.toMatchObject({ status: 400, code: "PO_WP_BAD_PROJECT" });
  });

  it("refuse une erreur liée à une capture d'un autre projet", async () => {
    report.repoGetAssetById.mockResolvedValue({ id: RESOURCE, project_id: OTHER_PROJECT } as never);
    await expect(createErrorRecord(ACTOR, PROJECT, {
      title: "Erreur",
      severity: "HIGH",
      screenshot_asset_id: RESOURCE,
    }, AUDIT)).rejects.toMatchObject({ status: 400, code: "PO_ASSET_BAD_PROJECT" });
  });

  it("refuse une capture liée à une section d'un autre projet", async () => {
    report.repoGetEntryProjectId.mockResolvedValue(OTHER_PROJECT);
    await expect(createAsset(ACTOR, PROJECT, {
      report_entry_id: RESOURCE,
      title: "Capture",
      asset_type: "UI_SCREENSHOT",
    }, null, AUDIT)).rejects.toMatchObject({ status: 400, code: "PO_REPORT_ENTRY_BAD_PROJECT" });
  });

  it("vérifie la signature binaire et pas seulement le MIME déclaré", async () => {
    await expect(createAsset(ACTOR, PROJECT, {
      title: "Faux PNG",
      asset_type: "UI_SCREENSHOT",
    }, { buffer: Buffer.from("not-a-png"), mimetype: "image/png" }, AUDIT))
      .rejects.toMatchObject({ status: 415, code: "PO_ASSET_BAD_SIGNATURE" });
  });
});
