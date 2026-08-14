import { describe, expect, it } from "vitest";

import type { PortalDocumentRow } from "../repository/client-portal.repository";
import { portalDocumentState } from "./client-portal.service";

function documentRow(overrides: Partial<PortalDocumentRow> = {}): PortalDocumentRow {
  return {
    id: "d5ec6d7e-f2f9-42aa-b766-bf98147f42b3",
    client_id: "042",
    version_id: "2f587271-10c4-40d6-a693-7b3650636661",
    document_id: "81792fe1-4dc4-4cc3-bb3d-6ec44530e374",
    code: "GED-0001",
    title: "Certificat matière",
    version_number: 2,
    version_status: "APPLICABLE",
    current_version_id: "2f587271-10c4-40d6-a693-7b3650636661",
    document_archived_at: null,
    original_name: "certificat.pdf",
    mime_type: "application/pdf",
    size_bytes: 1024,
    sha256: "a".repeat(64),
    scan_status: "clean",
    quarantine_status: "released",
    scanned_at: "2026-08-14T10:00:00.000Z",
    expires_at: null,
    revoked_at: null,
    acknowledgement_required: true,
    acknowledged_at: null,
    published_at: "2026-08-14T11:00:00.000Z",
    ...overrides,
  };
}

describe("client portal document truthfulness", () => {
  const now = new Date("2026-08-14T12:00:00.000Z").getTime();

  it.each([
    [{}, "AVAILABLE"],
    [{ scan_status: "pending", quarantine_status: "pending" }, "PENDING_SCAN"],
    [{ scan_status: "infected", quarantine_status: "quarantined" }, "QUARANTINED"],
    [{ expires_at: "2026-08-14T11:59:59.000Z" }, "EXPIRED"],
    [{ current_version_id: "26e324db-08df-41d2-b0f5-b8a47dfa4b43" }, "REPLACED"],
    [{ version_status: "OBSOLETE" }, "REPLACED"],
    [{ scan_status: "scan_failed" }, "UNAVAILABLE"],
    [{ scan_status: null, quarantine_status: null }, "UNAVAILABLE"],
    [{ revoked_at: "2026-08-14T11:00:00.000Z" }, "REVOKED"],
  ] as const)("maps %j to %s without fabricating availability", (overrides, expected) => {
    expect(portalDocumentState(documentRow(overrides), now)).toBe(expected);
  });
});

