import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArticleReconfiguration } from "../validators/article-reconfiguration.validators";
import type { AuditContext } from "./stock.repository";

const mocks = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), create: vi.fn(), read: vi.fn(), snapshot: vi.fn(), audit: vi.fn(), clone: vi.fn(), finish: vi.fn(), preview: vi.fn(), update: vi.fn() }));
vi.mock("../../../config/database", () => ({ default: { connect: async () => ({ query: mocks.query, release: mocks.release }) } }));
vi.mock("./stock.repository", () => ({ repoCreateArticleTx: mocks.create, repoGetArticle: mocks.read, queueStockArticleCreationSnapshotTx: mocks.snapshot, insertAuditLog: mocks.audit, repoPreviewMaterialArticleCode: mocks.preview, repoUpdateArticle: mocks.update }));
vi.mock("../../pieces-techniques/repository/versions.repository", () => ({ repoCreateNextVersion: mocks.clone }));
vi.mock("../../surface-finish/repository/surface-finish-resolution.repository", () => ({ repoConfirmStockFinishArticle: mocks.finish }));
import { repoReconfigureArticle, replaceTechnicalArticleTx } from "./article-reconfiguration.repository";

const source = "11111111-1111-4111-8111-111111111111";
const replacement = { id: "22222222-2222-4222-8222-222222222222", designation: "Plat 95", article_category: "matiere" };
const audit = { user_id: 17 } as AuditContext;
const body = (action: ArticleReconfiguration["action"]): ArticleReconfiguration => ({
  expected_row_version: 7, action, article: { article_category: "matiere", family_code: "PL", article_matiere: { largeur_mm: 95, barre_a_decouper: true }, status: "VALIDE", stock_managed: true, lot_tracking: true, is_sold: false, is_active: true },
});
const run = (value = body("KEEP_BOTH")) => repoReconfigureArticle(source, value, audit, { role: "Directeur" }, "test-command-0001", false);
const sqls = () => mocks.query.mock.calls.map(([sql]) => String(sql));

describe("transaction de reconfiguration", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.create.mockResolvedValue(replacement); mocks.read.mockResolvedValue(replacement);
    mocks.preview.mockResolvedValue({ code: "new-code", designation: "Plat 95" });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.startsWith("SELECT row_version")) return { rows: [{ row_version: 7, code: "old-code", article_category: "matiere", is_active: true, unite: "mm" }] };
      return { rows: [], rowCount: 0 };
    });
  });
  it.each(["KEEP_BOTH", "ARCHIVE_OLD", "REPLACE_ALL"] as const)("enregistre atomiquement le choix %s", async action => {
    await expect(run(body(action))).resolves.toEqual(replacement);
    const update = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE public.articles SET row_version"));
    expect(update?.[1][2]).toBe(action === "ARCHIVE_OLD");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(sqls()).toContain("COMMIT");
    expect(sqls()).not.toContain("ROLLBACK");
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), audit, expect.objectContaining({ details: expect.objectContaining({ action, replacement_article_id: replacement.id }) }));
    expect(sqls().some(sql => sql.startsWith("UPDATE public.pieces_techniques_achats"))).toBe(action === "REPLACE_ALL");
  });
  it("refuse une fiche obsolète avant toute création", async () => {
    await expect(run({ ...body("REPLACE_ALL"), expected_row_version: 6 })).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(sqls()).toContain("ROLLBACK");
    expect(sqls()).not.toContain("COMMIT");
  });
  it("annule aussi la création si la propagation échoue", async () => {
    const implementation = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).startsWith("UPDATE public.pieces_techniques_nomenclature")) throw new Error("Conflit de lien technique");
      return implementation(...args);
    });
    await expect(run(body("REPLACE_ALL"))).rejects.toThrow("Conflit de lien technique");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(sqls()).toContain("ROLLBACK");
    expect(sqls()).not.toContain("COMMIT");
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
  it("ne convertit pas implicitement les quantités quand l'unité change", async () => {
    const implementation = mocks.query.getMockImplementation()!;
    mocks.query.mockImplementation(async (...args: unknown[]) => {
      if (String(args[0]).startsWith("SELECT unite")) return { rows: [{ unite: "u" }] };
      if (String(args[0]).startsWith("SELECT EXISTS")) return { rows: [{ present: true }] };
      return implementation(...args);
    });
    await expect(run(body("REPLACE_ALL"))).rejects.toMatchObject({ code: "ARTICLE_REPLACEMENT_UNIT_CHANGED" });
    expect(sqls()).toContain("ROLLBACK");
    expect(sqls()).not.toContain("COMMIT");
  });
  it("rejoue une validation déjà enregistrée sans toucher à l'ancien article", async () => {
    await run();
    const insert = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("INSERT INTO public.article_create_idempotence"));
    const hash = insert![1][1];
    mocks.create.mockClear(); mocks.query.mockClear();
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT article_id::text, request_hash") ? [{ article_id: replacement.id, request_hash: hash }] : [] }));
    await expect(run()).resolves.toEqual(replacement);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(sqls().some(sql => sql.startsWith("UPDATE"))).toBe(false);
  });
  it("rejette une clé réutilisée pour un autre contenu", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT article_id::text, request_hash") ? [{ article_id: replacement.id, request_hash: "another-request" }] : [] }));
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("permet de corriger les informations d'une matière sans dupliquer sa référence", async () => {
    mocks.preview.mockResolvedValue({ code: "old-code", designation: "Plat 90" });
    await run(body("REPLACE_ALL"));
    expect(mocks.update).toHaveBeenCalledWith(source, expect.objectContaining({ designation: "Plat 90", expected_row_version: 7 }), audit, false, expect.anything());
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("copie les versions applicables et ne met à jour que les brouillons résultants", async () => {
    mocks.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT v.id::text") ? [
      { id: "released", piece_technique_id: "piece-1", indice: "A", statut: "APPLICABLE" },
      { id: "draft", piece_technique_id: "piece-2", indice: "B", statut: "BROUILLON" },
    ] : [] }));
    mocks.clone.mockResolvedValue({ id: "new-draft" });
    const tx = { query: mocks.query };
    const result = await replaceTechnicalArticleTx(tx as never, source, replacement, audit);
    expect(result).toEqual({ versions: ["new-draft", "draft"], created_drafts: 1 });
    expect(mocks.clone).toHaveBeenCalledWith("piece-1", "released", expect.objectContaining({ change_level: "MINOR", indice: "A" }), audit, tx, { autoFollowDraftOrders: false });
    const purchases = mocks.query.mock.calls.find(([sql]) => String(sql).startsWith("UPDATE public.pieces_techniques_achats"));
    expect(purchases![1][3]).toEqual(["new-draft", "draft"]);
    expect(sqls()[0]).toContain("v.statut <> 'OBSOLETE'");
    expect(sqls().some(sql => /UPDATE public\.(lots|commande|ordres_fabrication|stock_movement)/.test(sql))).toBe(false);
  });
});
