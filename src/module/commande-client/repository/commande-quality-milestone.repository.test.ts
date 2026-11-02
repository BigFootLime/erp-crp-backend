import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { reconcileCommandeQualityMilestoneInTransaction } from "./commande-quality-milestone.repository";
import { repoApplyCommandeWorkflowMilestone } from "./commande-client.repository";
import { HttpError } from "../../../utils/httpError";

vi.mock("./commande-client.repository", () => ({
  repoEnsureCommandeWorkflowCheckpoints: vi.fn(),
  repoApplyCommandeWorkflowMilestone: vi.fn(),
}));
vi.mock("../../../shared/realtime/realtime-outbox.service", () => ({
  enqueueAppNotificationCreated: vi.fn(), enqueueEntityChanged: vi.fn(),
}));

function fixture(status: string, checkpoint: string, openNc = 0, unreleased = 0) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.commande_historique")) return { rows: [{ nouveau_statut: status }] };
    if (sql.includes("FROM public.commande_client_workflow_checkpoint")) return { rows: [{ status: checkpoint }] };
    if (sql.includes("WITH active_of AS")) return { rows: [{ total: 2, open_nc: openNc, unreleased }] };
    if (sql.includes("FOR UPDATE")) return { rows: [{ id: 17 }] };
    throw new Error("Unexpected quality SQL");
  });
  return { query } as unknown as Pick<PoolClient, "query">;
}

describe("synchronisation du contrôle qualité de la commande", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["EN_PRODUCTION", "active", 0, 0],
    ["PRODUCTION_TERMINEE", "blocked", 0, 0],
    ["PRODUCTION_TERMINEE", "active", 1, 0],
    ["PRODUCTION_TERMINEE", "active", 0, 1],
    ["PRET_LIVRAISON", "done", 0, 0],
  ] as const)("préserve l'étape %s / %s avec %i NC et %i OF non libérés", async (status, checkpoint, openNc, unreleased) => {
    await reconcileCommandeQualityMilestoneInTransaction(fixture(status, checkpoint, openNc, unreleased), 17, 9);
    expect(repoApplyCommandeWorkflowMilestone).not.toHaveBeenCalled();
  });

  it("ouvre la livraison uniquement après les libérations nécessaires", async () => {
    vi.mocked(repoApplyCommandeWorkflowMilestone).mockResolvedValue({
      changed: true, ancien_statut: "PRODUCTION_TERMINEE", nouveau_statut: "PRET_LIVRAISON",
      history_id: 52, notifications: [],
    });
    await reconcileCommandeQualityMilestoneInTransaction(fixture("PRODUCTION_TERMINEE", "active"), 17, 9);
    expect(repoApplyCommandeWorkflowMilestone).toHaveBeenCalledWith(expect.objectContaining({
      commande_id: 17, user_id: 9, cause: "quality_sync", nouveau_statut: "PRET_LIVRAISON",
      completed_checkpoint_codes: ["quality_control"], active_checkpoint_code: "delivery",
    }));
  });

  it("remonte un échec de stockage de l'historique", async () => {
    const error = new HttpError(500, "WRITE_FAILED", "indisponible");
    vi.mocked(repoApplyCommandeWorkflowMilestone).mockRejectedValueOnce(error);
    await expect(reconcileCommandeQualityMilestoneInTransaction(fixture("PRODUCTION_TERMINEE", "active"), 17, 9))
      .rejects.toBe(error);
  });
});
