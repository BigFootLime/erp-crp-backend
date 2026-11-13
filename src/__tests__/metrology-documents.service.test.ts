import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  parent: vi.fn(),
  capability: vi.fn(),
  getDocument: vi.fn(),
  listDocuments: vi.fn(),
  uploadDocument: vi.fn(),
  downloadVersion: vi.fn(),
  getSource: vi.fn(),
  listRefs: vi.fn(),
}));

vi.mock("../config/database", () => ({ default: { query: mocks.query } }));
vi.mock("../module/ged/services/ged-parent-authorization.service", () => ({
  assertGedParentLinkWritable: (...args: unknown[]) => mocks.parent(...args),
}));
vi.mock("../module/metrologie/domain/metrology-policy", () => ({
  assertMetrologyCapability: (...args: unknown[]) => mocks.capability(...args),
}));
vi.mock("../module/ged/services/ged.service", () => ({
  getDocument: (...args: unknown[]) => mocks.getDocument(...args),
  listDocuments: (...args: unknown[]) => mocks.listDocuments(...args),
  uploadDocument: (...args: unknown[]) => mocks.uploadDocument(...args),
  downloadVersion: (...args: unknown[]) => mocks.downloadVersion(...args),
}));
vi.mock("../module/metrologie/repository/metrology-documents.repository", () => ({
  repoGetImportedEquipmentSource: (...args: unknown[]) => mocks.getSource(...args),
  repoListEquipmentDocumentRefs: (...args: unknown[]) => mocks.listRefs(...args),
}));

import {
  documentDto,
  getEquipmentDocumentContent,
  listEquipmentDocuments,
  scanMetadataSchema,
  uploadEquipmentDocument,
} from "../module/metrologie/services/metrology-documents.service";

const equipmentId = "11111111-1111-4111-8111-111111111111";
const otherEquipmentId = "22222222-2222-4222-8222-222222222222";
const documentId = "33333333-3333-4333-8333-333333333333";
const actor = { id: 19, role: "Métrologie" };

function detail(overrides: Record<string, unknown> = {}) {
  return {
    id: documentId, class_key: "METROLOGIE_SCAN", title: "scan.pdf", description: null,
    created_at: "2026-10-27T10:00:00.000Z", links: [{ entity_type: "METROLOGIE_EQUIPEMENT", entity_id: equipmentId }],
    current_version: {
      id: "44444444-4444-4444-8444-444444444444", mime_type: "application/pdf", size_bytes: 42,
      sha256: "a".repeat(64), antivirus: { status: "clean", quarantine_status: "released" }, created_by: { id: 19, label: "M. Test" },
    },
    ...overrides,
  } as any;
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.parent.mockResolvedValue({});
  mocks.capability.mockReturnValue(undefined);
});

describe("metrology document adapter", () => {
  it("accepts zero-like metadata and rejects invalid observed dates", () => {
    expect(scanMetadataSchema.parse({ kind: "OTHER", notes: "", observed_on: "" })).toMatchObject({
      kind: "OTHER", notes: "", observed_on: null,
    });
    expect(scanMetadataSchema.safeParse({ kind: "NOTICE", observed_on: "2026-02-31" }).success).toBe(false);
  });

  it("does not expose a GED file until its antivirus verdict is CLEAN", () => {
    expect(documentDto(detail({ current_version: { ...detail().current_version, antivirus: { status: "pending" } } })).has_file).toBe(false);
    expect(documentDto(detail({ current_version: { ...detail().current_version, antivirus: { status: "infected" } } })).scan_status).toBe("REJECTED");
    expect(documentDto(detail({ current_version: null })).has_file).toBe(false);
    expect(documentDto(detail({ current_version: { ...detail().current_version, antivirus: { status: "clean", quarantine_status: "quarantined" } } })).has_file).toBe(false);
    expect(documentDto(detail()).has_file).toBe(true);
  });

  it("keeps malformed legacy metadata visible as text rather than trusting it", () => {
    const dto = documentDto(detail({ description: '{"schema":"metrology-scan/1","values":{"kind":"NOTICE","observed_on":"nope"}}' }));
    expect(dto.kind).toBe("OTHER");
    expect(dto.notes).toContain("observed_on");
  });

  it("refuses a MIME/extension mismatch before GED upload", async () => {
    await expect(uploadEquipmentDocument(actor, equipmentId, { kind: "MD15_SCAN" }, {
      originalname: "proof.pdf", mimetype: "image/png",
    } as Express.Multer.File)).rejects.toMatchObject({ code: "METROLOGY_SCAN_TYPE" });
    expect(mocks.uploadDocument).not.toHaveBeenCalled();
  });

  it("links an OTHER scan to the registered canonical metrology equipment type", async () => {
    mocks.uploadDocument.mockResolvedValue(detail());
    await uploadEquipmentDocument(actor, equipmentId, { kind: "OTHER", label: "Vérification import" }, {
      originalname: "proof.pdf", mimetype: "application/pdf",
    } as Express.Multer.File);
    expect(mocks.uploadDocument).toHaveBeenCalledWith(actor, expect.objectContaining({
      class_key: "METROLOGIE_SCAN",
      link: { entity_type: "METROLOGIE_EQUIPEMENT", entity_id: equipmentId, link_role: "OTHER" },
    }), expect.anything());
  });

  it("hides a document linked to another instrument", async () => {
    mocks.getSource.mockResolvedValueOnce(null);
    mocks.getDocument.mockResolvedValue(detail({ links: [{ entity_type: "METROLOGIE_EQUIPEMENT", entity_id: otherEquipmentId }] }));
    await expect(getEquipmentDocumentContent(actor, equipmentId, documentId)).rejects.toMatchObject({
      status: 404, code: "METROLOGY_DOCUMENT_NOT_FOUND",
    });
    expect(mocks.downloadVersion).not.toHaveBeenCalled();
  });

  it("fails closed for a deleted or unknown instrument through the parent boundary", async () => {
    mocks.parent.mockRejectedValueOnce(Object.assign(new Error("hidden"), { status: 404, code: "GED_VERSION_NOT_FOUND" }));
    await expect(listEquipmentDocuments(actor, equipmentId)).rejects.toMatchObject({ status: 404 });
    expect(mocks.listDocuments).not.toHaveBeenCalled();
  });

  it("serves imported source evidence only to its actual target and only after CLEAN", async () => {
    mocks.getSource.mockResolvedValueOnce({
      id: documentId, storage_path: "metrology/source.xlsx", source_name: "source.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      sha256: "b".repeat(64), av_status: "PENDING",
    });
    await expect(getEquipmentDocumentContent(actor, equipmentId, documentId)).rejects.toMatchObject({ code: "METROLOGY_SOURCE_SCAN_REQUIRED" });
    expect(mocks.getSource).toHaveBeenCalledWith(equipmentId, documentId);

    mocks.getSource.mockResolvedValueOnce(null);
    mocks.getDocument.mockResolvedValue(detail());
    mocks.downloadVersion.mockResolvedValue({ sha256: "a".repeat(64) });
    await getEquipmentDocumentContent(actor, equipmentId, documentId);
    expect(mocks.downloadVersion).toHaveBeenCalledWith(actor, detail().current_version.id);
  });
});
