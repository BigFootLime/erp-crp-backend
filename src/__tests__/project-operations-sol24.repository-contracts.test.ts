import { describe, expect, it, vi } from "vitest";

import { runWithAccountModuleAccess } from "../module/access-control/context/account-module-access.context";
import { repoListProjects } from "../module/project-office/repository/project-office.repository";
import { repoGetTeamOperationsQueue } from "../module/temps-deplacements/repository/temps-deplacements-operations.repository";

describe("SOL-24 PostgreSQL repository contracts", () => {
  it("n'envoie aucun paramètre inutilisé quand le gate module élève la liste des projets", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [] });

    await new Promise<void>((resolve, reject) => {
      runWithAccountModuleAccess({ userId: 7, moduleKey: "PROJECT_OFFICE", elevated: true }, () => {
        void repoListProjects(7, { page: 1, pageSize: 25 }, { query } as never).then(() => resolve(), reject);
      });
    });

    expect(query.mock.calls[0][1]).toEqual([]);
    expect(query.mock.calls[1][1]).toEqual([25, 0]);
  });

  it("sélectionne un UUID de doublon sans appeler min(uuid), absent de PostgreSQL", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await repoGetTeamOperationsQueue({ manager_user_id: 7, privileged: true }, { query } as never);

    const duplicateSql = String(query.mock.calls[4][0]);
    expect(duplicateSql).toContain("array_agg(k.id ORDER BY k.id)");
    expect(duplicateSql).not.toMatch(/min\s*\(\s*k\.id\s*\)/i);
  });
});
