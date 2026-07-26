// Issue #146 — Contrat de lecture de la landing Pièces techniques.
//
// Deux promesses sont verrouillées ici :
//   1. `summary` et `list` partagent EXACTEMENT le même périmètre — c'est ce qui rend
//      légitime d'afficher le total du premier au-dessus des lignes du second ;
//   2. l'extension est strictement ADDITIVE : la liste est consommée par plus de huit
//      modules, aucun filtre existant ne change de comportement par défaut.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { repoListPieceTechniques, repoPieceTechniquesSummary } from "./pieces-techniques.repository";
import { listPiecesTechniquesQuerySchema } from "../validators/pieces-techniques.validators";

const query = vi.hoisted(() => vi.fn());
vi.mock("../../../config/database", () => ({ default: { query }, query }));

type Sql = { text: string; values: unknown[] };
function captured(): Sql[] {
  return query.mock.calls.map(([text, values]) => ({ text: String(text), values: (values ?? []) as unknown[] }));
}

/**
 * Isole la clause WHERE de la table pilote, pour comparer deux périmètres.
 * On part de `FROM pieces_techniques p` : la synthèse contient des `FILTER (WHERE …)` dans
 * sa liste de sélection, qu'un simple `indexOf("WHERE")` attraperait en premier.
 */
function whereOf(sql: string): string {
  const from = sql.indexOf("FROM pieces_techniques p");
  if (from === -1) return "";
  const index = sql.indexOf("WHERE", from);
  if (index === -1) return "";
  return sql
    .slice(index)
    .replace(/ORDER BY[\s\S]*$/, "")
    .replace(/GROUP BY[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const parse = (raw: Record<string, unknown>) => listPiecesTechniquesQuerySchema.parse(raw);

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});

/* ------------------------------------------------------------------------------------ */
/* Rétrocompatibilité                                                                     */
/* ------------------------------------------------------------------------------------ */

describe("rétrocompatibilité de la liste", () => {
  it("sans aucun filtre nouveau, la clause WHERE reste celle d'avant", async () => {
    await repoListPieceTechniques(parse({}));
    const where = whereOf(captured()[0].text);
    expect(where).toBe("WHERE p.deleted_at IS NULL");
  });

  it("aucun filtre de complétude n'a de valeur par défaut", () => {
    const parsed = parse({});
    expect(parsed.has_article).toBeUndefined();
    expect(parsed.has_gamme).toBeUndefined();
    expect(parsed.has_nomenclature).toBeUndefined();
    expect(parsed.has_applicable_version).toBeUndefined();
    expect(parsed.ensemble).toBeUndefined();
    expect(parsed.segment).toBeUndefined();
  });

  it("les filtres historiques fonctionnent à l'identique", async () => {
    await repoListPieceTechniques(parse({ client_id: "ACM", statut: "ACTIVE" }));
    const sql = captured()[0];
    expect(sql.text).toContain("p.client_id = $");
    expect(sql.text).toContain("p.statut = $");
    expect(sql.values).toContain("ACM");
    expect(sql.values).toContain("ACTIVE");
  });

  it("conserve tous les champs historiques du contrat de liste", async () => {
    await repoListPieceTechniques(parse({}));
    const dataSql = captured()[1].text;
    for (const column of [
      "code_piece",
      "designation",
      "designation_2",
      "client_id",
      "client_name",
      "famille_id",
      "statut",
      "en_fabrication",
      "prix_unitaire",
      "bom_count",
      "operations_count",
      "achats_count",
      "cout_mo_total",
      "achats_total_ht",
    ]) {
      expect(dataSql).toContain(column);
    }
  });

  it("conserve le filtre de suppression logique", async () => {
    await repoListPieceTechniques(parse({}));
    expect(captured()[0].text).toContain("p.deleted_at IS NULL");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Recherche                                                                              */
/* ------------------------------------------------------------------------------------ */

describe("recherche métier", () => {
  it("couvre la référence de plan", async () => {
    await repoListPieceTechniques(parse({ q: "PL-4521" }));
    expect(captured()[0].text).toContain("pv.plan_reference ILIKE");
  });

  it("couvre l'indice", async () => {
    await repoListPieceTechniques(parse({ q: "C" }));
    const sql = captured()[0].text;
    expect(sql).toContain("pv.indice ILIKE");
    expect(sql).toContain("pv.indice_externe_original ILIKE");
  });

  it("couvre la désignation secondaire et le client", async () => {
    await repoListPieceTechniques(parse({ q: "bride" }));
    const sql = captured()[0].text;
    expect(sql).toContain("p.designation_2 ILIKE");
    expect(sql).toContain("p.client_name ILIKE");
  });

  it("couvre la famille", async () => {
    await repoListPieceTechniques(parse({ q: "USI" }));
    expect(captured()[0].text).toContain("pf.code ILIKE");
  });

  it("conserve la recherche par code métier normalisé", async () => {
    await repoListPieceTechniques(parse({ q: "ab-12" }));
    const sql = captured()[0];
    expect(sql.text).toContain("pv.code_metier_normalise ILIKE");
    expect(sql.values).toContain("%AB12%");
  });

  it("passe le terme en paramètre lié, jamais en littéral", async () => {
    await repoListPieceTechniques(parse({ q: "O'Brien" }));
    const sql = captured()[0];
    expect(sql.values).toContain("%O'Brien%");
    expect(sql.text).not.toContain("O'Brien");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Filtres de complétude                                                                  */
/* ------------------------------------------------------------------------------------ */

describe("filtres de complétude", () => {
  it("has_article=false cherche les pièces sans article lié", async () => {
    await repoListPieceTechniques(parse({ has_article: "false" }));
    expect(captured()[0].text).toContain("NOT (p.article_id IS NOT NULL)");
  });

  it("has_article=true cherche les pièces avec article lié", async () => {
    await repoListPieceTechniques(parse({ has_article: "true" }));
    const where = whereOf(captured()[0].text);
    expect(where).toContain("(p.article_id IS NOT NULL)");
    expect(where).not.toContain("NOT (p.article_id IS NOT NULL)");
  });

  it("has_gamme=false s'appuie sur l'absence d'opération", async () => {
    await repoListPieceTechniques(parse({ has_gamme: "false" }));
    expect(captured()[0].text).toContain("pieces_techniques_operations");
  });

  it("has_nomenclature accepte nomenclature OU achats", async () => {
    await repoListPieceTechniques(parse({ has_nomenclature: "true" }));
    const sql = captured()[0].text;
    expect(sql).toContain("pieces_techniques_nomenclature");
    expect(sql).toContain("pieces_techniques_achats");
  });

  it("has_applicable_version=false cible l'absence de version APPLICABLE", async () => {
    await repoListPieceTechniques(parse({ has_applicable_version: "false" }));
    expect(captured()[0].text).toContain("v.statut = 'APPLICABLE'");
  });

  it("ensemble=true ne retient que les ensembles", async () => {
    await repoListPieceTechniques(parse({ ensemble: "true" }));
    expect(whereOf(captured()[0].text)).toContain("p.ensemble");
  });

  it("updated_within_days borne l'activité récente en paramètre lié", async () => {
    await repoListPieceTechniques(parse({ updated_within_days: "45" }));
    const sql = captured()[0];
    expect(sql.text).toContain("INTERVAL '1 day'");
    expect(sql.values).toContain(45);
  });

  it("une valeur de présence vide n'ajoute aucun filtre", async () => {
    await repoListPieceTechniques(parse({ has_article: "" }));
    expect(whereOf(captured()[0].text)).toBe("WHERE p.deleted_at IS NULL");
  });

  it("une valeur de présence inconnue n'ajoute aucun filtre", async () => {
    await repoListPieceTechniques(parse({ has_article: "peut-etre" }));
    expect(whereOf(captured()[0].text)).toBe("WHERE p.deleted_at IS NULL");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Segments                                                                               */
/* ------------------------------------------------------------------------------------ */

describe("segments serveur", () => {
  it("le segment « toutes » n'ajoute aucun filtre", async () => {
    await repoListPieceTechniques(parse({ segment: "all" }));
    expect(whereOf(captured()[0].text)).toBe("WHERE p.deleted_at IS NULL");
  });

  it("« à compléter » couvre les quatre manques bloquants", async () => {
    await repoListPieceTechniques(parse({ segment: "to_complete" }));
    const sql = captured()[0].text;
    expect(sql).toContain("v.statut = 'APPLICABLE'");
    expect(sql).toContain("pieces_techniques_operations");
    expect(sql).toContain("pieces_techniques_nomenclature");
    expect(sql).toContain("p.article_id IS NOT NULL");
  });

  it("chaque segment de manque produit une clause distincte", async () => {
    const segments = ["no_applicable_version", "no_gamme", "no_nomenclature", "no_article"] as const;
    const clauses = new Set<string>();
    for (const segment of segments) {
      query.mockReset();
      query.mockResolvedValue({ rows: [] });
      await repoListPieceTechniques(parse({ segment }));
      clauses.add(whereOf(captured()[0].text));
    }
    expect(clauses.size).toBe(segments.length);
  });

  it("le segment « ensembles » filtre bien la colonne ensemble", async () => {
    await repoListPieceTechniques(parse({ segment: "ensembles" }));
    expect(whereOf(captured()[0].text)).toContain("p.ensemble");
  });

  it("le segment « récent » borne sur 30 jours", async () => {
    await repoListPieceTechniques(parse({ segment: "recent" }));
    expect(captured()[0].text).toContain("INTERVAL '30 days'");
  });

  it("un segment inconnu est refusé par la validation", () => {
    expect(() => parse({ segment: "brouillons_du_mardi" })).toThrow();
  });

  it("un segment se combine avec les filtres existants", async () => {
    await repoListPieceTechniques(parse({ segment: "no_gamme", client_id: "ACM" }));
    const where = whereOf(captured()[0].text);
    expect(where).toContain("p.client_id = $");
    expect(where).toContain("pieces_techniques_operations");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Complétude renvoyée                                                                    */
/* ------------------------------------------------------------------------------------ */

describe("colonnes de complétude", () => {
  it("expose l'indice et la référence de plan de la version applicable", async () => {
    await repoListPieceTechniques(parse({}));
    const dataSql = captured()[1].text;
    expect(dataSql).toContain("applicable_indice");
    expect(dataSql).toContain("applicable_plan_reference");
    expect(dataSql).toContain("applicable_date_effet");
  });

  it("expose les cinq drapeaux de complétude et le verdict de liste", async () => {
    await repoListPieceTechniques(parse({}));
    const dataSql = captured()[1].text;
    for (const flag of [
      "has_applicable_version",
      "has_gamme",
      "has_structure",
      "has_article",
      "has_documents",
      "to_complete",
    ]) {
      expect(dataSql).toContain(flag);
    }
  });

  it("ne retient qu'une seule version applicable, la plus récente en date d'effet", async () => {
    await repoListPieceTechniques(parse({}));
    const dataSql = captured()[1].text;
    expect(dataSql).toContain("ORDER BY v.date_effet DESC NULLS LAST");
    expect(dataSql).toContain("LIMIT 1");
  });

  it("n'expose jamais le chemin de stockage d'un document", async () => {
    await repoListPieceTechniques(parse({}));
    expect(captured()[1].text).not.toContain("storage_path");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Synthèse                                                                               */
/* ------------------------------------------------------------------------------------ */

describe("agrégat de synthèse", () => {
  it("INVARIANT : summary applique exactement le même WHERE que la liste", async () => {
    const filters = parse({ client_id: "ACM", segment: "to_complete", q: "bride" });

    await repoListPieceTechniques(filters);
    const listWhere = whereOf(captured()[0].text);
    const listValues = captured()[0].values;

    query.mockReset();
    query.mockResolvedValue({ rows: [] });
    await repoPieceTechniquesSummary(filters);
    const summaryWhere = whereOf(captured()[0].text);
    const summaryValues = captured()[0].values;

    expect(summaryWhere).toBe(listWhere);
    expect(summaryValues).toEqual(listValues);
  });

  it("compte séparément pièces et ensembles", async () => {
    await repoPieceTechniquesSummary(parse({}));
    const sql = captured()[0].text;
    expect(sql).toContain("FILTER (WHERE p.ensemble)");
    expect(sql).toContain("FILTER (WHERE NOT p.ensemble)");
  });

  it("compte chaque manque séparément", async () => {
    await repoPieceTechniquesSummary(parse({}));
    const sql = captured()[0].text;
    for (const column of [
      "without_applicable_version",
      "without_gamme",
      "without_structure",
      "without_article",
      "without_documents",
      "to_complete",
    ]) {
      expect(sql).toContain(column);
    }
  });

  it("répartit par statut sur le même périmètre", async () => {
    await repoPieceTechniquesSummary(parse({ client_id: "ACM" }));
    const statusSql = captured()[1];
    expect(statusSql.text).toContain("GROUP BY p.statut");
    expect(statusSql.values).toContain("ACM");
  });

  it("mesure la couverture hors filtres, pour distinguer « vide » de « tout complet »", async () => {
    await repoPieceTechniquesSummary(parse({ segment: "to_complete" }));
    const coverageSql = captured()[2];
    expect(coverageSql.text).toContain("COUNT(*)::int AS total_rows");
    expect(coverageSql.values).toEqual([]);
  });

  it("déclare la source vide quand le module ne contient aucune pièce", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rows: 0 }] });
    const summary = await repoPieceTechniquesSummary(parse({}));
    expect(summary.coverage.source_empty).toBe(true);
    expect(summary.total).toBe(0);
  });

  it("ne déclare pas la source vide quand seul le filtre ne ramène rien", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rows: 142 }] });
    const summary = await repoPieceTechniquesSummary(parse({ segment: "no_gamme" }));
    expect(summary.coverage.source_empty).toBe(false);
    expect(summary.coverage.total_rows).toBe(142);
  });

  it("renvoie les filtres réellement appliqués, sans la pagination", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ total: 3 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rows: 10 }] });
    const summary = await repoPieceTechniquesSummary(parse({ client_id: "ACM", page: 3, pageSize: 50 }));
    expect(summary.filters_applied).toEqual({ client_id: "ACM" });
  });

  it("porte une date d'arrêté", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total_rows: 0 }] });
    const summary = await repoPieceTechniquesSummary(parse({}));
    expect(summary.as_of).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("convertit tous les compteurs en entiers", async () => {
    query.mockReset();
    query
      .mockResolvedValueOnce({
        rows: [
          {
            total: "12",
            ensembles: "3",
            pieces: "9",
            to_complete: "7",
            without_applicable_version: "5",
            without_gamme: "4",
            without_structure: "6",
            without_article: "2",
            without_documents: "8",
            updated_last_30_days: "1",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ statut: "ACTIVE", count: "12" }] })
      .mockResolvedValueOnce({ rows: [{ total_rows: "12" }] });
    const summary = await repoPieceTechniquesSummary(parse({}));
    expect(summary.total).toBe(12);
    expect(summary.by_statut).toEqual([{ statut: "ACTIVE", count: 12 }]);
    expect(summary.without_gamme).toBe(4);
  });
});
