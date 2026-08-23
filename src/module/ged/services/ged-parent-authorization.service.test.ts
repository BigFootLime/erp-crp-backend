import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ links: vi.fn(), exists: vi.fn(), profile: vi.fn() }));
vi.mock("../repository/ged.repository", () => ({
  repoInternalListDocumentParentLinks: mocks.links,
  repoInternalParentLinkExists: mocks.exists,
}));
vi.mock("../../access-control/services/access-control.service", () => ({ resolveAccessProfile: mocks.profile }));

import { assertGedVersionParentReadable } from "./ged-parent-authorization.service";

const documentId = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.resetAllMocks());

describe("GED parent-record download authorization", () => {
  it("requires one supported, live parent and its current module grant", async () => {
    mocks.links.mockResolvedValue([{ entity_type: "commande-client", entity_id: "42" }]);
    mocks.exists.mockResolvedValue(true);
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: "commandes-clients", allowed: true }] });

    await expect(assertGedVersionParentReadable(7, documentId)).resolves.toEqual({
      moduleKey: "commandes-clients", entityType: "COMMANDE_CLIENT", entityId: "42",
    });
    expect(mocks.exists).toHaveBeenCalledWith("COMMANDE_CLIENT", "42");
  });

  it.each([
    ["AFFAIRE", "affaires", "AFFAIRE"],
  ])("accepts the live integer identity used by %s", async (entityType, moduleKey, canonicalType) => {
    mocks.links.mockResolvedValue([{ entity_type: entityType, entity_id: "42" }]);
    mocks.exists.mockResolvedValue(true);
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: moduleKey, allowed: true }] });

    await expect(assertGedVersionParentReadable(7, documentId)).resolves.toEqual({
      moduleKey,
      entityType: canonicalType,
      entityId: "42",
    });
    expect(mocks.exists).toHaveBeenCalledWith(canonicalType, "42");
  });

  it.each(["ARTICLE", "STOCK_ARTICLE", "STOCK-ARTICLE"])("accepts the live UUID identity used by %s", async (entityType) => {
    const articleId = "22222222-2222-4222-8222-222222222222";
    mocks.links.mockResolvedValue([{ entity_type: entityType, entity_id: articleId }]);
    mocks.exists.mockResolvedValue(true);
    mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: "stock", allowed: true }] });

    await expect(assertGedVersionParentReadable(7, documentId)).resolves.toEqual({
      moduleKey: "stock",
      entityType: "STOCK_ARTICLE",
      entityId: articleId,
    });
    expect(mocks.exists).toHaveBeenCalledWith("STOCK_ARTICLE", articleId);
  });

  it.each([
    ["unlinked", []],
    ["ambiguous", [{ entity_type: "CLIENT", entity_id: "c-1" }, { entity_type: "OUTIL", entity_id: "2" }]],
    ["unsupported", [{ entity_type: "HISTORICAL_UNKNOWN", entity_id: "c-1" }]],
  ])("returns the same opaque 404 for %s parent links", async (_case, links) => {
    mocks.links.mockResolvedValue(links);
    await expect(assertGedVersionParentReadable(7, documentId)).rejects.toMatchObject({ status: 404, code: "GED_VERSION_NOT_FOUND" });
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("does not disclose a foreign/deleted parent or a cross-module IDOR", async () => {
    mocks.links.mockResolvedValue([{ entity_type: "ORDRE_FABRICATION", entity_id: "42" }]);
    mocks.exists.mockResolvedValueOnce(false);
    await expect(assertGedVersionParentReadable(7, documentId)).rejects.toMatchObject({ status: 404 });

    mocks.exists.mockResolvedValueOnce(true);
    mocks.profile.mockResolvedValueOnce({ is_superadmin: false, modules: [{ module_key: "clients", allowed: true }] });
    await expect(assertGedVersionParentReadable(7, documentId)).rejects.toMatchObject({ status: 404, code: "GED_VERSION_NOT_FOUND" });
  });

  it("fails closed when the access-control profile cannot be resolved", async () => {
    mocks.links.mockResolvedValue([{ entity_type: "CLIENT", entity_id: "c-1" }]);
    mocks.exists.mockResolvedValue(true);
    mocks.profile.mockResolvedValue(null);
    await expect(assertGedVersionParentReadable(7, documentId)).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ["integer", "COMMANDE_CLIENT", "not-a-number"],
    ["integer", "AFFAIRE", "not-a-number"],
    ["uuid", "STOCK_ARTICLE", "not-a-uuid"],
    ["uuid", "FOURNISSEUR", "not-a-uuid"],
  ])("turns a malformed persisted %s parent id into the same opaque denial", async (_kind, entity_type, entity_id) => {
    mocks.links.mockResolvedValue([{ entity_type, entity_id }]);

    await expect(assertGedVersionParentReadable(7, documentId)).rejects.toMatchObject({
      status: 404,
      code: "GED_VERSION_NOT_FOUND",
    });
    expect(mocks.exists).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });
});
