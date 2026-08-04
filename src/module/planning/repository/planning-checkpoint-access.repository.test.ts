import { describe, expect, it, vi } from "vitest";

import { repoAssertPlanningCheckpointAccess } from "./planning.repository";

function queryer(checkpoint: { status: string; responsible_role: string; assigned_user_id: number | null }) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [checkpoint] }),
  };
}

describe("planning checkpoint deep authorization", () => {
  it("refuse un secrétaire non assigné sans écrire l'historique", async () => {
    const tx = queryer({ status: "active", responsible_role: "planning", assigned_user_id: null });

    await expect(repoAssertPlanningCheckpointAccess({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Secretaire",
    })).rejects.toMatchObject({ status: 403, code: "WORKFLOW_CHECKPOINT_FORBIDDEN" });

    expect(tx.query).toHaveBeenCalledTimes(2);
    expect(String(tx.query.mock.calls[0]?.[0])).toContain("FROM public.commande_client");
    expect(String(tx.query.mock.calls[0]?.[0])).toContain("FOR UPDATE");
    expect(String(tx.query.mock.calls[1]?.[0])).toContain("commande_client_workflow_checkpoint");
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO commande_historique"))).toBe(false);
  });

  it("refuse un employé assigné à un autre utilisateur", async () => {
    const tx = queryer({ status: "active", responsible_role: "planning", assigned_user_id: 8 });

    await expect(repoAssertPlanningCheckpointAccess({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: "Employee",
    })).rejects.toMatchObject({ status: 403, code: "WORKFLOW_CHECKPOINT_FORBIDDEN" });
  });

  it.each([
    ["l'utilisateur assigné", "Employee", 7],
    ["le rôle planning", "Planification", null],
    ["l'administrateur", "Administrateur Systeme et Reseau", null],
  ])("autorise %s", async (_label, role, assignedUserId) => {
    const tx = queryer({ status: "active", responsible_role: "planning", assigned_user_id: assignedUserId });

    await expect(repoAssertPlanningCheckpointAccess({
      tx: tx as never,
      commande_id: 123,
      user_id: 7,
      user_role: role,
    })).resolves.toBeUndefined();
  });
});
