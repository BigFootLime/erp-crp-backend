import { describe, expect, it } from "vitest";

import { authoritativePdfFilename, assertAuthoritativePdfFilename } from "../shared/authoritative-documents/authoritative-document.filename";
import { repoAssertAuthoritativePdfClaim, repoClaimAuthoritativePdfWork, repoFindLatestAuthoritativePdfForEntity, repoGetAuthoritativePdf, repoListAuthoritativePdfs, repoMarkAuthoritativePdfArchived, repoMarkAuthoritativePdfFailure } from "../shared/authoritative-documents/authoritative-document.repository";
import { archiveClaimedAuthoritativePdf, AuthoritativePdfProducerRegistry, authoritativePdfGedEntityType, authoritativePdfGedPolicy, canonicalJson, officialDocumentGenerationEnvelope, queueCreationPdfArchive, sha256Text } from "../shared/authoritative-documents/authoritative-document.service";
import type { ArchiveQueueItem } from "../shared/authoritative-documents/authoritative-document.types";

function archiveItem(overrides: Partial<ArchiveQueueItem["archive"]> = {}): ArchiveQueueItem {
  return {
    outboxId: "22222222-2222-4222-8222-222222222222",
    claimToken: "33333333-3333-4333-8333-333333333333",
    archive: {
      id: "11111111-1111-4111-8111-111111111111",
      entityType: "devis",
      entityId: "1",
      documentKind: "CUSTOMER_QUOTE",
      documentVersion: 1,
      renderVersion: "renderer-v7",
      idempotencyKey: "devis:1:creation:v1",
      title: "Devis DV-2026-001",
      originalName: "DEVIS-DV-2026-001-v1.pdf",
      sourceRevision: "2026-08-23 10:00:00+00",
      sourceSnapshot: {},
      actorUserId: 1,
      createdAt: "2026-08-23T10:00:00.000Z",
      snapshotSha256: "a".repeat(64),
      pdfSha256: null,
      pdfSizeBytes: null,
      gedDocumentId: null,
      gedVersionId: null,
      archivedAt: null,
      ...overrides,
    },
  };
}

describe("authoritative PDF archive foundation (#612)", () => {
  it("uses the dedicated GED class only for explicitly allowlisted internal creation snapshots", () => {
    expect(authoritativePdfGedPolicy("CLIENT_CREATION_SNAPSHOT")).toEqual({ classKey: "CERP_SYSTEM_SNAPSHOT", linkRole: "CREATION_SNAPSHOT", eventType: "CREATION_SNAPSHOT_ARCHIVED" });
    expect(authoritativePdfGedPolicy("CUSTOMER_QUOTE")).toEqual({ classKey: "CERP_AUTHORITATIVE_PDF", linkRole: "AUTHORITATIVE_PDF", eventType: "AUTHORITATIVE_PDF_ARCHIVED" });
    expect(authoritativePdfGedPolicy("INVENTED_CREATION_SNAPSHOT").classKey).toBe("CERP_AUTHORITATIVE_PDF");
  });
  it.each([
    ["client", "CLIENT"],
    ["fournisseur", "FOURNISSEUR"],
    ["commande-client", "COMMANDE_CLIENT"],
    ["ordre-fabrication", "OF"],
    ["piece-technique", "PIECE_TECHNIQUE"],
    ["affaire", "AFFAIRE"],
    ["stock-article", "ARTICLE"],
    ["bon-livraison", "BON_LIVRAISON"],
    ["devis", "DEVIS"],
    ["commande-fournisseur", "COMMANDE_FOURNISSEUR"],
    ["facture", "FACTURE"],
    ["avoir", "AVOIR"],
  ])("maps archive entity %s to the canonical GED type %s", (archiveType, gedType) => {
    expect(authoritativePdfGedEntityType(archiveType)).toBe(gedType);
  });

  it("fails closed before queueing an entity family absent from the GED contract", async () => {
    let queried = false;
    await expect(queueCreationPdfArchive({ query: async () => { queried = true; return { rows: [] }; } }, {
      entityType: "invented-entity", entityId: "42", documentKind: "INVENTED_DOCUMENT", documentVersion: 1,
      renderVersion: "invented-v1", idempotencyKey: "invented:42:v1", title: "Invented",
      originalName: "Invented-42-v1.pdf", sourceRevision: "revision-1", sourceSnapshot: {}, actorUserId: 1,
    })).rejects.toThrow("AUTHORITATIVE_PDF_GED_ENTITY_TYPE_UNSUPPORTED");
    expect(queried).toBe(false);
  });
  it("canonicalizes a creation snapshot independently of source key order", () => {
    const left = { entity: { id: "42", lines: [{ quantity: 2, ref: "P-01" }] }, created: "2026-08-23T10:00:00Z" };
    const right = { created: "2026-08-23T10:00:00Z", entity: { lines: [{ ref: "P-01", quantity: 2 }], id: "42" } };
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(sha256Text(canonicalJson(left))).toMatch(/^[a-f0-9]{64}$/);
  });

  it("creates portable deterministic PDF filenames and rejects unsafe names", () => {
    expect(authoritativePdfFilename(["Commande client", "BC/2026:001", "épreuve"])).toBe("Commande-client-BC-2026-001-epreuve.pdf");
    expect(() => assertAuthoritativePdfFilename("../../secret.pdf")).toThrow("AUTHORITATIVE_PDF_FILENAME_INVALID");
  });

  it("rejects overlong queue identifiers before a database error can leak", async () => {
    const tx = { query: async () => ({ rows: [] }) };
    await expect(queueCreationPdfArchive(tx, {
      entityType: "devis",
      entityId: "x".repeat(161),
      documentKind: "CUSTOMER_QUOTE",
      documentVersion: 1,
      renderVersion: "creation-v1",
      idempotencyKey: "queue-input-test",
      title: "Devis",
      originalName: "DEVIS-TEST.pdf",
      sourceRevision: "2026-08-23 10:00:00+00",
      sourceSnapshot: {},
      actorUserId: 1,
    })).rejects.toThrow("AUTHORITATIVE_PDF_IDENTITY_INVALID");
  });

  it("turns a residual business-edition uniqueness race into a safe conflict", async () => {
    const duplicate = Object.assign(new Error("duplicate"), {
      code: "23505",
      constraint: "authoritative_pdf_archive_document_version_uq",
    });
    const tx = { query: async () => { throw duplicate; } };
    await expect(queueCreationPdfArchive(tx, {
      entityType: "devis",
      entityId: "42",
      documentKind: "CUSTOMER_QUOTE",
      documentVersion: 2,
      renderVersion: "devis-pdf-v1",
      idempotencyKey: "quote:42:reissue:2",
      title: "Devis",
      originalName: "DEVIS-42-v2.pdf",
      sourceRevision: "2026-08-23 10:00:00+00",
      sourceSnapshot: { id: 42 },
      actorUserId: 1,
    })).rejects.toMatchObject({ status: 409, code: "OFFICIAL_DOCUMENT_VERSION_CONFLICT" });
  });

  it("rejects an idempotency key replay whose frozen request differs", async () => {
    let calls = 0;
    const tx = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [] };
        return { rows: [{
          id: "11111111-1111-4111-8111-111111111111", entity_type: "devis", entity_id: "42", document_kind: "CUSTOMER_QUOTE",
          document_version: 1, render_version: "devis-pdf-v1", idempotency_key: "quote:42:creation:v1", title: "Devis", original_name: "DEVIS-42-v1.pdf",
          source_snapshot: { id: 42 }, source_revision: "2026-08-22 10:00:00+00", snapshot_sha256: "b".repeat(64), pdf_sha256: null,
          pdf_size_bytes: null, ged_document_id: null, ged_version_id: null, archived_at: null, created_at: "2026-08-23T10:00:00.000Z", created_by: 1,
        }] };
      },
    };
    await expect(queueCreationPdfArchive(tx, {
      entityType: "devis", entityId: "42", documentKind: "CUSTOMER_QUOTE", documentVersion: 1, renderVersion: "devis-pdf-v1",
      idempotencyKey: "quote:42:creation:v1", title: "Devis", originalName: "DEVIS-42-v1.pdf",
      sourceRevision: "2026-08-23 10:00:00+00", sourceSnapshot: { id: 42 }, actorUserId: 1,
    })).rejects.toMatchObject({ status: 409, code: "OFFICIAL_DOCUMENT_IDEMPOTENCY_CONFLICT" });
  });

  it("keeps the renderer revision stable across deliberate same-source business editions", () => {
    const first = archiveItem({ documentVersion: 1, renderVersion: "devis-pdf-v1", sourceSnapshot: { id: 42, total: "100.00" } }).archive;
    const reissue = archiveItem({ documentVersion: 2, renderVersion: "devis-pdf-v1", sourceSnapshot: { total: "100.00", id: 42 } }).archive;
    expect(canonicalJson(first.sourceSnapshot)).toBe(canonicalJson(reissue.sourceSnapshot));
    expect(first.renderVersion).toBe(reissue.renderVersion);
    expect(reissue.documentVersion).toBe(first.documentVersion + 1);
  });

  it("keys server-only renderers by entity family and document kind", () => {
    const registry = new AuthoritativePdfProducerRegistry();
    registry.register("commande-client", "CUSTOMER_ORDER_ACKNOWLEDGEMENT", async () => Buffer.from("%PDF-1.7"));
    registry.register("commande-client", "CUSTOMER_ORDER_CERTIFICATE", async () => Buffer.from("%PDF-1.7"));
    expect(registry.get("commande-client", "CUSTOMER_ORDER_ACKNOWLEDGEMENT")).not.toBeNull();
    expect(registry.get("commande-client", "CUSTOMER_ORDER_CERTIFICATE")).not.toBeNull();
    expect(registry.get("commande-client", "UNREGISTERED_KIND")).toBeNull();
    expect(() => registry.register("commande-client", "CUSTOMER_ORDER_ACKNOWLEDGEMENT", async () => Buffer.alloc(0))).toThrow("AUTHORITATIVE_PDF_PRODUCER_ALREADY_REGISTERED");
  });

  it("binds every shared archive lookup to its exact document kind", async () => {
    const calls: Array<[string, unknown[]]> = [];
    const spyTx = {
      query: async (sql: string, params: unknown[]) => {
        calls.push([sql, params]);
        return { rows: [] };
      },
    };
    await repoListAuthoritativePdfs(spyTx, "commande-client", "123", "CUSTOMER_ORDER_ACKNOWLEDGEMENT");
    await repoGetAuthoritativePdf(spyTx, "commande-client", "123", "11111111-1111-4111-8111-111111111111", "CUSTOMER_ORDER_ACKNOWLEDGEMENT");
    await repoFindLatestAuthoritativePdfForEntity(spyTx, "commande-client", "123", "CUSTOMER_ORDER_ACKNOWLEDGEMENT");
    await repoClaimAuthoritativePdfWork(spyTx, "worker-1", 8);
    expect(calls[0]?.[0]).toContain("a.document_kind = $3");
    expect(calls[0]?.[1]).toEqual(["commande-client", "123", "CUSTOMER_ORDER_ACKNOWLEDGEMENT"]);
    expect(calls[1]?.[0]).toContain("a.document_kind = $4");
    expect(calls[1]?.[1]).toEqual(["11111111-1111-4111-8111-111111111111", "commande-client", "123", "CUSTOMER_ORDER_ACKNOWLEDGEMENT"]);
    expect(calls[2]?.[0]).toContain("a.document_kind = $3");
    expect(calls[2]?.[0]).not.toContain("$3::text IS NULL");
    expect(calls[2]?.[1]).toEqual(["commande-client", "123", "CUSTOMER_ORDER_ACKNOWLEDGEMENT"]);
    for (const [sql] of calls) {
      if (sql.includes("JOIN public.authoritative_pdf_archive_outbox")) {
        expect(sql).toContain("a.id::text");
        expect(sql).toContain("a.created_by");
        expect(sql).not.toContain("SELECT id::text");
      }
    }
  });

  it("carries the exact fresh claim token from the outbox claim into the worker item", async () => {
    const claimToken = "33333333-3333-4333-8333-333333333333";
    const tx = {
      query: async () => ({ rows: [{
        outbox_id: "22222222-2222-4222-8222-222222222222", claim_token: claimToken,
        id: "11111111-1111-4111-8111-111111111111", entity_type: "devis", entity_id: "42", document_kind: "CUSTOMER_QUOTE",
        document_version: 1, render_version: "devis-pdf-v1", idempotency_key: "devis:42:creation:v1", title: "Devis", original_name: "DEVIS-42-v1.pdf",
        source_snapshot: {}, source_revision: "2026-08-23 10:00:00+00", snapshot_sha256: "a".repeat(64), pdf_sha256: null,
        pdf_size_bytes: null, ged_document_id: null, ged_version_id: null, archived_at: null, created_at: "2026-08-23T10:00:00.000Z", created_by: 1,
      }] }),
    };
    const claimed = await repoClaimAuthoritativePdfWork(tx, "worker-1", 8);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.claimToken).toBe(claimToken);
  });

  it("closes the outbox lease when an archive becomes durable", async () => {
    const calls: string[] = [];
    const tx = {
      query: async (sql: string) => {
        calls.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    await repoMarkAuthoritativePdfArchived(tx, {
      archiveId: "11111111-1111-4111-8111-111111111111",
      outboxId: "22222222-2222-4222-8222-222222222222",
      claimToken: "33333333-3333-4333-8333-333333333333",
      pdfSha256: "a".repeat(64), pdfSizeBytes: 1,
      gedDocumentId: "33333333-3333-4333-8333-333333333333",
      gedVersionId: "44444444-4444-4444-8444-444444444444",
      actorUserId: 1,
    });
    expect(calls[1]).toContain("locked_at = NULL, locked_by = NULL");
    expect(calls[1]).toContain("claim_token = $3::uuid");
  });

  it("refuses a reclaimed worker lease from completing or failing the newer claim", async () => {
    let completionCalls = 0;
    const archiveThenMissingOutbox = {
      query: async (_sql: string) => ({ rows: [], rowCount: ++completionCalls === 1 ? 1 : 0 }),
    };
    await expect(repoMarkAuthoritativePdfArchived(archiveThenMissingOutbox, {
      archiveId: "11111111-1111-4111-8111-111111111111", outboxId: "22222222-2222-4222-8222-222222222222",
      claimToken: "33333333-3333-4333-8333-333333333333", pdfSha256: "a".repeat(64), pdfSizeBytes: 1, gedDocumentId: "33333333-3333-4333-8333-333333333333",
      gedVersionId: "44444444-4444-4444-8444-444444444444", actorUserId: 1,
    })).rejects.toThrow("AUTHORITATIVE_PDF_OUTBOX_ARCHIVE_TRANSITION_FAILED");

    const outboxMissing = { query: async () => ({ rows: [], rowCount: 0 }) };
    await expect(repoMarkAuthoritativePdfFailure(outboxMissing, { outboxId: "22222222-2222-4222-8222-222222222222", claimToken: "33333333-3333-4333-8333-333333333333", message: "AUTHORITATIVE_PDF_NOT_PDF" }))
      .rejects.toThrow("AUTHORITATIVE_PDF_OUTBOX_FAILURE_TRANSITION_FAILED");

    const staleClaimQueries: string[] = [];
    await expect(repoAssertAuthoritativePdfClaim({ query: async (sql: string) => {
      staleClaimQueries.push(sql);
      return { rows: [] };
    } }, {
      archiveId: "11111111-1111-4111-8111-111111111111", outboxId: "22222222-2222-4222-8222-222222222222", claimToken: "33333333-3333-4333-8333-333333333333",
    })).rejects.toThrow("AUTHORITATIVE_PDF_CLAIM_STALE");
    expect(staleClaimQueries[0]).toContain("FOR UPDATE");
  });

  it("exposes a browser-safe envelope while a newer attempt is still pending", () => {
    const issued = archiveItem({
      pdfSha256: "b".repeat(64), pdfSizeBytes: 1234, gedDocumentId: "33333333-3333-4333-8333-333333333333",
      gedVersionId: "44444444-4444-4444-8444-444444444444", archivedAt: "2026-08-23T10:01:00.000Z",
    }).archive;
    const pending = archiveItem({
      id: "55555555-5555-4555-8555-555555555555", documentVersion: 2, renderVersion: "renderer-v8",
      createdAt: "2026-08-23T10:02:00.000Z", idempotencyKey: "devis:1:reissue:v2",
    }).archive;
    expect(officialDocumentGenerationEnvelope([
      { ...issued, state: "ARCHIVED" as const },
      { ...pending, state: "PENDING" as const },
    ], "/devis/1/official-documents")).toEqual({
      state: "PENDING",
      latest_document: expect.objectContaining({
        id: issued.id,
        version: 1,
        state: "ISSUED",
        byte_sha256: "b".repeat(64),
        byte_length: 1234,
        source_revision: "2026-08-23 10:00:00+00",
      }),
      retryable: false,
      failure_code: null,
    });
    expect(officialDocumentGenerationEnvelope([{ ...issued, state: "ARCHIVED" as const }], "/devis/1/official-documents")).toMatchObject({
      state: "READY",
      retryable: false,
      failure_code: null,
    });
    expect(officialDocumentGenerationEnvelope([], "/devis/1/official-documents")).toEqual({
      state: "NOT_GENERATED",
      latest_document: null,
      retryable: false,
      failure_code: null,
    });
  });

  it("never exposes a failed vault attempt as a stored PDF", () => {
    const failed = archiveItem({
      // Defensive contract: even inconsistent residual fields cannot make a
      // non-ARCHIVED outbox attempt look byte-complete to the browser.
      pdfSha256: "c".repeat(64),
      pdfSizeBytes: 987,
      gedDocumentId: "33333333-3333-4333-8333-333333333333",
      gedVersionId: "44444444-4444-4444-8444-444444444444",
      archivedAt: "2026-08-23T10:01:00.000Z",
    }).archive;

    expect(officialDocumentGenerationEnvelope([
      { ...failed, state: "FAILED" as const },
    ], "/devis/1/official-documents")).toEqual({
      state: "FAILED",
      latest_document: null,
      retryable: true,
      failure_code: "OFFICIAL_DOCUMENT_GENERATION_FAILED",
    });
  });

  it("orders offset-form archive timestamps by instant rather than lexicographically", () => {
    const olderIssued = archiveItem({
      id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-08-23T10:00:00+02:00",
      pdfSha256: "b".repeat(64), pdfSizeBytes: 1234, gedDocumentId: "33333333-3333-4333-8333-333333333333",
      gedVersionId: "44444444-4444-4444-8444-444444444444", archivedAt: "2026-08-23T08:01:00.000Z",
    }).archive;
    const newerPending = archiveItem({
      id: "55555555-5555-4555-8555-555555555555", createdAt: "2026-08-23T09:00:00Z",
      // Same version isolates timestamp ordering; the persistence constraint
      // prevents this shape in production.
      documentVersion: 1,
    }).archive;
    expect(officialDocumentGenerationEnvelope([
      { ...olderIssued, state: "ARCHIVED" as const },
      { ...newerPending, state: "PENDING" as const },
    ], "/devis/42/official-documents").state).toBe("PENDING");
  });

  it("rejects invalid PDFs before vault or GED writes", async () => {
    const tx = { query: async () => { throw new Error("GED_WRITE_MUST_NOT_RUN"); } };
    await expect(archiveClaimedAuthoritativePdf(tx, archiveItem(), Buffer.alloc(0))).rejects.toThrow("AUTHORITATIVE_PDF_EMPTY");
    await expect(archiveClaimedAuthoritativePdf(tx, archiveItem(), Buffer.from("not a pdf"))).rejects.toThrow("AUTHORITATIVE_PDF_NOT_PDF");
    await expect(archiveClaimedAuthoritativePdf(tx, archiveItem(), Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(52_428_800)]))).rejects.toThrow("AUTHORITATIVE_PDF_SIZE_EXCEEDED");
  });
});
