import { describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => vi.fn());
vi.mock("../../../shared/authoritative-documents/authoritative-document.service", () => ({ queueCreationPdfArchive: queue }));

import { queueRootOfCreationPdf } from "./of-creation-pdf";

type OfCreationRow = {
  id: string; numero: string; root_of_id: string | null; parent_of_id: string | null; generation_level: number;
  piece_technique_id: string | null; piece_technique_version_id: string | null;
  technical_snapshot_sha256: string | null; commande_id: string | null; affaire_id: string | null; client_id: string | null; client_name: string | null;
  quantite_lancee: number; statut: string; priority: string; date_lancement_prevue: string | null; date_fin_prevue: string | null;
  updated_at: string;
};

const root: OfCreationRow = {
  id: "42", numero: "OF-00042", root_of_id: "42", parent_of_id: null, generation_level: 0,
  piece_technique_id: "11111111-1111-1111-1111-111111111111", piece_technique_version_id: "22222222-2222-2222-2222-222222222222",
  technical_snapshot_sha256: "a".repeat(64), commande_id: "18", affaire_id: "9", client_id: "001", client_name: "Client test",
  quantite_lancee: 12, statut: "BROUILLON", priority: "NORMAL", date_lancement_prevue: "2026-08-23", date_fin_prevue: null,
  updated_at: "2026-08-23T10:00:00.000000Z",
};

function txFor(row: OfCreationRow | null) {
  return {
    query: vi.fn(async (sql: unknown) => {
      const statement = String(sql);
      if (!statement.includes("FROM public.ordres_fabrication")) {
        return { rows: [{ phase: 10, designation: "Usinage", status: "A_FAIRE", cf_code_snapshot: "USI" }] };
      }
      // Model the actual root-only SELECT predicate: a child is present in the
      // database fixture but cannot be returned to the queue helper.
      const isRoot = row?.parent_of_id === null && (row.root_of_id === null || row.root_of_id === row.id);
      return { rows: isRoot && row ? [row] : [] };
    }),
  };
}

describe("root OF creation PDF queue", () => {
  it("queues one stable, internal-safe snapshot for a root", async () => {
    queue.mockReset(); queue.mockResolvedValue(undefined);
    const tx = txFor(root);
    await queueRootOfCreationPdf(tx as never, { ofId: 42, actorUserId: 7 });
    expect(queue).toHaveBeenCalledTimes(1);
    const input = queue.mock.calls[0]?.[1];
    expect(input).toMatchObject({ entityType: "ordre-fabrication", entityId: "42", documentKind: "OF_CREATION_SNAPSHOT", documentVersion: 1, idempotencyKey: "ordre-fabrication:42:creation:v1", sourceRevision: root.updated_at, actorUserId: 7 });
    expect(input.sourceSnapshot).toMatchObject({ type: "INTERNAL_CREATION_SNAPSHOT", reference: "OF-00042" });
    expect(JSON.stringify(input.sourceSnapshot)).not.toContain("technical_snapshot\"");
  });

  it("excludes a child OF before it can enqueue", async () => {
    queue.mockReset();
    const child: OfCreationRow = {
      ...root,
      id: "43",
      numero: "OF-00043",
      root_of_id: "42",
      parent_of_id: "42",
      generation_level: 1,
    };
    const tx = txFor(child);
    await queueRootOfCreationPdf(tx as never, { ofId: 43, actorUserId: 7 });
    expect(queue).not.toHaveBeenCalled();
    expect(tx.query).toHaveBeenCalledWith(
      expect.stringContaining("o.parent_of_id IS NULL"),
      [43],
    );
  });

  it("propagates queue failures so the caller transaction rolls back", async () => {
    queue.mockReset(); queue.mockRejectedValueOnce(new Error("outbox unavailable"));
    await expect(queueRootOfCreationPdf(txFor(root) as never, { ofId: 42, actorUserId: 7 })).rejects.toThrow("outbox unavailable");
  });
});
