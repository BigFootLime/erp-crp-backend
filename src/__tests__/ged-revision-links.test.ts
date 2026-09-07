import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ links: vi.fn(), exists: vi.fn(), profile: vi.fn(), resolve: vi.fn(),
  lock: vi.fn(), revisions: vi.fn(), add: vi.fn(), audit: vi.fn(), candidates: vi.fn() }));
vi.mock("../module/ged/repository/ged.repository", () => ({
  repoInternalListDocumentParentLinks: mocks.links, repoInternalParentLinkExists: mocks.exists,
  repoAddLink: mocks.add, repoLogAccess: mocks.audit,
  withGedTransaction: (fn: (tx: object) => Promise<unknown>) => fn({}),
}));
vi.mock("../module/ged/repository/ged-revision-links.repository", () => ({
  repoResolveRevisionBusinessParent: mocks.resolve, repoLockRevisionDocument: mocks.lock,
  repoLockPieceRevisions: mocks.revisions, repoListReusableRevisionDocuments: mocks.candidates,
}));
vi.mock("../module/access-control/services/access-control.service", () => ({ resolveAccessProfile: mocks.profile }));
import { assertGedVersionParentReadable } from "../module/ged/services/ged-parent-authorization.service";
import { reuseRevisionDocument, listReusableRevisionDocuments } from "../module/ged/services/ged-revision-links.service";

const source = "11111111-1111-4111-8111-111111111111";
const target = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const actor = { id: 1, role: "administrateur" };
const link = (entity_id: string) => ({ entity_type: "PIECE_TECHNIQUE_VERSION", entity_id });
const body = { revision_id: target, expected_version_id: versionId, link_role: "PLAN_CLIENT" as const, reason: "Géométrie inchangée" };
function state() { return { document: { class_key: "PLAN_CLIENT", archived_at: null },
  version: { id: versionId, status: "EN_REVUE", scan_status: "clean", quarantine_status: "released" }, links: [link(source)] }; }

beforeEach(() => {
  vi.resetAllMocks();
  mocks.links.mockResolvedValue([link(source)]);
  mocks.exists.mockResolvedValue(true);
  mocks.profile.mockResolvedValue({ is_superadmin: false, modules: [{ module_key: "pieces-techniques", allowed: true }] });
  mocks.resolve.mockResolvedValue("44444444-4444-4444-8444-444444444444");
  mocks.lock.mockResolvedValue(state());
  mocks.revisions.mockResolvedValue([{ id: source, piece_id: "44444444-4444-4444-8444-444444444444", statut: "OBSOLETE" }, { id: target, piece_id: "44444444-4444-4444-8444-444444444444", statut: "APPLICABLE" }]);
  mocks.add.mockResolvedValue(true);
});

describe("GED : parent unique entre plusieurs révisions", () => {
  it("autorise les octets pour deux révisions de la même pièce et contrôle son module", async () => {
    mocks.links.mockResolvedValue([link(source), link(target)]);
    expect(await assertGedVersionParentReadable(1, "doc")).toEqual({ moduleKey: "pieces-techniques", entityType: "PIECE_TECHNIQUE", entityId: "44444444-4444-4444-8444-444444444444" });
    expect(mocks.resolve).toHaveBeenCalledWith([source, target]);
    expect(mocks.exists).toHaveBeenCalledWith("PIECE_TECHNIQUE", "44444444-4444-4444-8444-444444444444");
  });
  it.each([null, undefined])("refuse un parent manquant ou réparti entre pièces", async resolved => {
    mocks.links.mockResolvedValue([link(source), link(target)]); mocks.resolve.mockResolvedValue(resolved);
    await expect(assertGedVersionParentReadable(1, "doc")).rejects.toMatchObject({ status: 404 });
  });
  it("refuse les liens mixtes et ne tente aucun cast UUID arbitraire", async () => {
    mocks.links.mockResolvedValue([link(source), { entity_type: "OF", entity_id: "12" }]);
    await expect(assertGedVersionParentReadable(1, "doc")).rejects.toMatchObject({ status: 404 });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
  it("refuse aussi l’utilisateur hors du module pour la même pièce", async () => {
    mocks.links.mockResolvedValue([link(source), link(target)]); mocks.profile.mockResolvedValue({ modules: [] });
    await expect(assertGedVersionParentReadable(1, "doc")).rejects.toMatchObject({ status: 404 });
  });
});

describe("GED : rattachement contrôlé", () => {
  it("conserve la version en revue, les liens précédents et audite seulement le nouveau lien", async () => {
    expect(await reuseRevisionDocument(actor, "doc", body)).toEqual({ document_id: "doc", version_id: versionId, created: true });
    expect(mocks.add).toHaveBeenCalledWith({}, expect.objectContaining({ document_id: "doc", entity_id: target, created_by: 1 }));
    expect(mocks.audit).toHaveBeenCalledWith({}, expect.objectContaining({ version_id: versionId, event_type: "CHECKIN", details: expect.objectContaining({ reason: body.reason, action: "REVISION_LINK_ADDED" }) }));
    mocks.add.mockResolvedValue(false);
    expect((await reuseRevisionDocument(actor, "doc", body)).created).toBe(false);
    expect(mocks.audit).toHaveBeenCalledTimes(1);
  });
  it.each(["scan", "obsolete", "archive", "class", "version", "mixed"])("refuse une source %s et n’ajoute aucun lien", async problem => {
    const value = state();
    if (problem === "scan") value.version.scan_status = "infected";
    if (problem === "obsolete") value.version.status = "OBSOLETE";
    if (problem === "archive") Object.assign(value.document, { archived_at: "2026-09-07" });
    if (problem === "class") value.document.class_key = "FACTURE";
    if (problem === "version") value.version.id = source;
    if (problem === "mixed") value.links.push({ entity_type: "CLIENT", entity_id: "client" });
    mocks.lock.mockResolvedValue(value);
    await expect(reuseRevisionDocument(actor, "doc", body)).rejects.toThrow();
    expect(mocks.add).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["other", "missing", "obsolete"])("refuse une cible %s après verrouillage", async problem => {
    mocks.revisions.mockResolvedValue(problem === "missing" ? [] : [{ id: source, piece_id: "44444444-4444-4444-8444-444444444444", statut: "OBSOLETE" },
      { id: target, piece_id: problem === "other" ? "foreign" : "44444444-4444-4444-8444-444444444444", statut: problem === "obsolete" ? "OBSOLETE" : "APPLICABLE" }]);
    await expect(reuseRevisionDocument(actor, "doc", body)).rejects.toThrow();
    expect(mocks.add).not.toHaveBeenCalled();
  });
  it("exige les droits d’écriture GED avant de consulter la source ou les candidats", async () => {
    await expect(reuseRevisionDocument({ id: 2, role: "Atelier" }, "doc", body)).rejects.toMatchObject({ status: 403 });
    await expect(listReusableRevisionDocuments({ id: 2, role: "Atelier" }, target)).rejects.toMatchObject({ status: 403 });
    expect(mocks.lock).not.toHaveBeenCalled(); expect(mocks.candidates).not.toHaveBeenCalled();
  });
});
