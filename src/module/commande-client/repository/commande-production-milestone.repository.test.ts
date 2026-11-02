import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const mocks = vi.hoisted(() => ({ apply: vi.fn(), quality: vi.fn() }));
vi.mock("./commande-client.repository", () => ({ repoApplyCommandeWorkflowMilestone: mocks.apply, repoEnsureCommandeWorkflowCheckpoints: vi.fn() }));
vi.mock("./commande-quality-milestone.repository", () => ({ reconcileCommandeQualityMilestoneInTransaction: mocks.quality }));

import { reconcileCommandeProductionMilestonesInTransaction } from "./commande-production-milestone.repository";

function tx(ofs: string[], checkpoints: Array<{ checkpoint_code: string; status: string }>) {
  return { query: vi.fn(async (sql: string) => {
    if (sql.includes("FROM public.ordres_fabrication o")) return { rows: ofs.map(statut => ({ statut })) };
    if (sql.includes("workflow_checkpoint")) return { rows: checkpoints };
    if (sql.includes("commande_historique")) return { rows: [{ nouveau_statut: "AR_ENVOYE" }] };
    return { rows: [] };
  }) } as unknown as Pick<PoolClient, "query">;
}

describe("production milestone reconciliation", () => {
  it("does not advance a multi-OF line-linked order until every OF starts, then completes idempotently", async () => {
    mocks.apply.mockReset(); mocks.quality.mockReset();
    const client = tx(["EN_COURS", "PLANIFIE"], [{ checkpoint_code: "production_launch", status: "active" }, { checkpoint_code: "production_completion", status: "active" }]);
    await reconcileCommandeProductionMilestonesInTransaction({ client, actorUserId: 7, orderIds: [12, 12] });
    expect(mocks.apply).not.toHaveBeenCalled();
    const finished = tx(["TERMINE", "CLOTURE"], [{ checkpoint_code: "production_launch", status: "active" }, { checkpoint_code: "production_completion", status: "active" }]);
    await reconcileCommandeProductionMilestonesInTransaction({ client: finished, actorUserId: 7, orderIds: [12] });
    expect(mocks.apply.mock.calls.map(call => call[0].nouveau_statut)).toEqual(["EN_PRODUCTION", "PRODUCTION_TERMINEE"]);
    expect(mocks.quality).toHaveBeenCalledWith(finished, 12, 7);
  });

  it("does not override a blocked checkpoint", async () => {
    mocks.apply.mockReset(); mocks.quality.mockReset();
    const client = tx(["TERMINE"], [{ checkpoint_code: "production_launch", status: "blocked" }, { checkpoint_code: "production_completion", status: "blocked" }]);
    await reconcileCommandeProductionMilestonesInTransaction({ client, actorUserId: 7, orderIds: [12] });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.quality).not.toHaveBeenCalled();
  });
});
