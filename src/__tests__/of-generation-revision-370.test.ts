// Garde de non-régression : la génération d'OF doit rattacher ses opérations à une
// révision (#370).
//
// `of_operations.revision_id` est NOT NULL depuis le versioning d'OF. La génération
// d'OF — code partagé, antérieur à ce chantier — insérait ses opérations SANS ce
// champ. Résultat : toute création d'OF échouait en 23502, sur `cerp_test` comme
// sur `cerp_prod`. Le défaut était invisible aux tests existants parce qu'ils
// simulent `tx.query` et ne vérifient jamais la contrainte réelle.
//
// Ces tests inspectent le SQL RÉELLEMENT émis. C'est le seul moyen d'attraper un
// défaut de ce type sans base de données.

import { describe, expect, it, vi } from "vitest";

import { copyPieceOperationsToOf } from "../module/production/domain/of-generation";

/** Capture le SQL émis, dans l'ordre. */
function recordingTx() {
  const queries: string[] = [];
  return {
    queries,
    query: vi.fn(async (sql: string) => {
      queries.push(String(sql));
      return { rows: [], rowCount: 1 };
    }),
  };
}

const PARAMS = {
  of_id: 4242,
  piece_technique_id: "0f9b1c22-5f1a-4c6e-9d0a-6b7d2e3f4a51",
  gamme_id: null,
};

describe("#370 — la génération d'OF crée la R00 et y rattache ses opérations", () => {
  it("insère la révision R00 AVANT les opérations", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);

    const revisionIndex = tx.queries.findIndex((q) => q.includes("INSERT INTO public.of_revisions"));
    const operationsIndex = tx.queries.findIndex((q) =>
      q.includes("INSERT INTO public.of_operations")
    );

    expect(revisionIndex, "la R00 doit être insérée").toBeGreaterThanOrEqual(0);
    expect(operationsIndex, "les opérations doivent être insérées").toBeGreaterThanOrEqual(0);
    // L'ordre compte : une opération insérée avant sa révision violerait NOT NULL.
    expect(revisionIndex).toBeLessThan(operationsIndex);
  });

  it("crée la R00 en ACTIVE, au rang 0, avec une empreinte", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);
    const sql = tx.queries.find((q) => q.includes("INSERT INTO public.of_revisions")) ?? "";

    expect(sql).toContain("'R00'");
    expect(sql).toContain("'ACTIVE'");
    expect(sql).toContain("snapshot_sha256");
    expect(sql).toContain("activated_at");
  });

  it("garde la création idempotente sans dépendre d'un index total", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);
    const sql = tx.queries.find((q) => q.includes("INSERT INTO public.of_revisions")) ?? "";

    // `of_revisions_active_uq` est un index PARTIEL : `ON CONFLICT` ne peut pas
    // s'y appuyer. La garde doit donc être un `WHERE NOT EXISTS`.
    expect(sql).toContain("WHERE NOT EXISTS");
    expect(sql).not.toContain("ON CONFLICT");
  });

  it("renseigne revision_id dans l'INSERT des opérations", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);
    const sql = tx.queries.find((q) => q.includes("INSERT INTO public.of_operations")) ?? "";

    // La colonne doit être dans la liste ET dans le SELECT : une colonne déclarée
    // sans valeur correspondante décalerait toutes les autres.
    expect(sql).toContain("revision_id");
    expect(sql).toContain("statut = 'ACTIVE'");
    expect(sql).toMatch(/FROM public\.of_revisions r/);
  });

  it("résout la révision en SQL, sans aller-retour applicatif", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);
    const sql = tx.queries.find((q) => q.includes("INSERT INTO public.of_operations")) ?? "";

    // Remonter l'identifiant puis le réinjecter ouvrirait une fenêtre où l'une des
    // deux écritures pourrait manquer. La sous-requête l'évite par construction.
    expect(sql).toContain("SELECT r.id FROM public.of_revisions r");
  });

  it("conserve les colonnes de gamme normalisée figées au lancement", async () => {
    const tx = recordingTx();
    await copyPieceOperationsToOf(tx as never, PARAMS);
    const sql = tx.queries.find((q) => q.includes("INSERT INTO public.of_operations")) ?? "";

    // Le versioning ne doit pas avoir fait perdre le gel du centre de frais.
    for (const column of [
      "numero_programme",
      "machine_family_code",
      "cf_code_snapshot",
      "cf_rate_id",
      "temps_fabrication_planned",
      "hourly_rate_source",
      "hourly_rate_effective_at",
    ]) {
      expect(sql, `colonne ${column} attendue`).toContain(column);
    }
  });
});

describe("#370 — l'avancement d'un OF ne compte que la révision applicable", () => {
  it("filtre les opérations sur la révision ACTIVE dans le résumé de planning", async () => {
    // Lecture du source : ce défaut ne se voit pas à l'exécution tant qu'aucune
    // R01 n'existe, et se manifesterait alors par un avancement faux
    // (« 6 phases sur 12 » sur un OF qui n'en a que 6).
    //
    // La recherche est volontairement insensible à la mise en forme : un test qui
    // dépend d'une indentation exacte casse au premier reformatage et n'apprend
    // rien sur le fond.
    const fs = await import("node:fs/promises");
    const source = await fs.readFile("src/module/planning/repository/planning.repository.ts", "utf8");

    // La requête d'agrégat se reconnaît à ses compteurs d'avancement.
    const aggregateIndex = source.indexOf("total_ops");
    expect(aggregateIndex, "la requête d'agrégat doit exister").toBeGreaterThan(-1);

    const end = source.indexOf("[params.of_id]", aggregateIndex);
    const query = source.slice(aggregateIndex, end > -1 ? end : aggregateIndex + 2000);

    // La jointure existe…
    expect(query).toMatch(/LEFT JOIN\s+public\.of_operations\s+op/);
    // …et elle est bornée à la révision applicable, avec le repli historique.
    expect(query).toMatch(/r\.statut\s*=\s*'ACTIVE'/);
    expect(query).toMatch(/op\.revision_id\s+IS\s+NULL/);
  });
});
