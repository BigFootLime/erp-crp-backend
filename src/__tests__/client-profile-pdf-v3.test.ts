import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CERP_LOGO_PNG } from "../shared/pdf/cerp-logo";
import { buildInternalCreationSnapshot } from "../shared/authoritative-documents/internal-creation-snapshot";
import { renderClientProfilePdf } from "../module/client/services/client-profile-pdf";

const image = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../shared/pdf/ged-entity-image", () => ({ readGedEntityImageVersion: image.read }));

const logoVersion = "22222222-2222-4222-8222-222222222222";
function archive(renderVersion: string, logo = false) {
  return {
    id: "11111111-1111-4111-8111-111111111111", entityType: "client", entityId: "fixture",
    documentKind: "CLIENT_PROFILE", documentVersion: 2, renderVersion, idempotencyKey: "fixture",
    title: "Fiche client CLI-001", originalName: "fiche-client-CLI-001-v2.pdf", sourceRevision: "revision-2",
    createdAt: "2026-10-23T14:00:00Z", snapshotSha256: "a".repeat(64), pdfSha256: null,
    pdfSizeBytes: null, gedDocumentId: null, gedVersionId: null, archivedAt: null, actorUserId: 1,
    sourceSnapshot: buildInternalCreationSnapshot({
      entityLabel: "Client de précision", reference: "CLI-001", entityImageVersionId: logo ? logoVersion : undefined,
      sections: [{ title: "Coordonnées", rows: [{ label: "TVA intracommunautaire", value: "FR38105397137" }] }],
    }),
  };
}
function streams(bytes: Buffer): string {
  const output: string[] = [];
  for (const match of bytes.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { output.push(inflateSync(Buffer.from(match[1], "latin1")).toString("latin1")); } catch { /* image/font streams */ }
  }
  return output.join("\n");
}

describe("client profile PDF v3", () => {
  beforeEach(() => image.read.mockReset().mockResolvedValue(null));
  it("embeds both Inter weights and the Commerce accent in the new edition", async () => {
    const pdf = await renderClientProfilePdf({ archive: archive("client-profile-pdf-v3") });
    const body = pdf.toString("latin1");
    expect(body).toContain("Inter-Regular");
    expect(body).toContain("Inter-Bold");
    expect(body).not.toMatch(/\/BaseFont \/Helvetica/);
    expect(/0\.145098\d* 0\.388235\d* 0\.921568\d* (?:scn|rg)/.test(streams(pdf))).toBe(true);
  });
  it("keeps the historical layout while using the shared Inter document font", async () => {
    const [old, current] = await Promise.all([
      renderClientProfilePdf({ archive: archive("client-profile-pdf-v2") }),
      renderClientProfilePdf({ archive: archive("client-profile-pdf-v3") }),
    ]);
    expect(old.toString("latin1")).toContain("Inter-Regular");
    expect(current.toString("latin1")).toContain("Inter-Regular");
  });
  it("includes the exact client logo revision alongside the company logo", async () => {
    image.read.mockResolvedValue(CERP_LOGO_PNG);
    const pdf = await renderClientProfilePdf({ archive: archive("client-profile-pdf-v3", true) });
    expect(image.read).toHaveBeenCalledWith({ versionId: logoVersion, entityType: "CLIENT", entityId: "fixture" });
    expect((pdf.toString("latin1").match(/\/Subtype \/Image\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
