import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../config/database", () => ({ default: { query }, query }));

import { repoListCurrentPieceTechniqueThreeDModels } from "./document-policy.repository";

const PIECE_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => query.mockReset());

describe("projection des modèles 3D d'une PT", () => {
  it("retourne vide pour une PT sans indice, sans demander de modèle global", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: PIECE_ID }] });
    query.mockResolvedValueOnce({ rows: [] });

    await expect(repoListCurrentPieceTechniqueThreeDModels(PIECE_ID)).resolves.toEqual({
      piece_technique_version_id: null,
      indice: null,
      models: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("ne liste que les modèles GED applicables, scannés et liés à l'indice courant", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: PIECE_ID }] });
    query.mockResolvedValueOnce({ rows: [{ id: VERSION_ID, indice: "A" }] });
    query.mockResolvedValueOnce({ rows: [{
      document_id: "33333333-3333-4333-8333-333333333333",
      version_id: "44444444-4444-4444-8444-444444444444",
      original_name: "piece.step",
      mime_type: "model/step",
      sha256: "a".repeat(64),
      size_bytes: "1024",
    }] });

    await expect(repoListCurrentPieceTechniqueThreeDModels(PIECE_ID)).resolves.toEqual({
      piece_technique_version_id: VERSION_ID,
      indice: "A",
      models: [{
        document_id: "33333333-3333-4333-8333-333333333333",
        version_id: "44444444-4444-4444-8444-444444444444",
        original_name: "piece.step",
        mime_type: "model/step",
        sha256: "a".repeat(64),
        size_bytes: 1024,
      }],
    });

    const [sql, values] = query.mock.calls[2] as [string, unknown[]];
    expect(values).toEqual([VERSION_ID]);
    expect(sql).toContain("d.class_key = 'MODELE_3D'");
    expect(sql).toContain("l.entity_type = 'PIECE_TECHNIQUE_VERSION'");
    expect(sql).toContain("l.link_role = 'MODELE_3D'");
    expect(sql).toContain("v.status = 'APPLICABLE'");
    expect(sql).toContain("s.scan_status = 'clean'");
    expect(sql).toContain("s.quarantine_status = 'released'");
    expect(sql).toContain("d.archived_at IS NULL");
    expect(sql).toContain("ORDER BY original_name ASC, document_id ASC");
  });

  it("ne choisit jamais un candidat lorsque plusieurs modèles existent", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: PIECE_ID }] });
    query.mockResolvedValueOnce({ rows: [{ id: VERSION_ID, indice: "A" }] });
    query.mockResolvedValueOnce({ rows: [
      { document_id: "d1", version_id: "v1", original_name: "a.step", mime_type: "model/step", sha256: "a", size_bytes: "1" },
      { document_id: "d2", version_id: "v2", original_name: "b.step", mime_type: "model/step", sha256: "b", size_bytes: "2" },
    ] });

    const result = await repoListCurrentPieceTechniqueThreeDModels(PIECE_ID);
    expect(result?.models).toHaveLength(2);
    expect(result?.models.map((model) => model.document_id)).toEqual(["d1", "d2"]);
  });
});
