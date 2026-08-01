// Snapshot d'OF — ce que le lancement fige réellement (#233 / crp-systems-web#384).
//
// Le SQL de `copyPieceOperationsToOf` n'est pas testable « à l'unité » sans base ;
// ce qui EST testable, et ce qui a réellement cassé, c'est :
//   1. la LISTE des colonnes figées — une colonne oubliée = une preuve perdue ;
//   2. l'ACCORD ARITHMÉTIQUE entre le SQL de l'OF et `computeOperationTimes`,
//      la formule autoritaire de la gamme.
// Le point 2 est vérifié en rejouant la formule SQL en JavaScript sur des jeux
// de valeurs qui font justement diverger l'ancienne implémentation.

import { describe, expect, it } from "vitest"

import { computeOperationTimes } from "../module/methodes/domain/methodes-policy"
import { copyPieceOperationsToOf, loadApplicableTechnicalSnapshot } from "../module/production/domain/of-generation"

/** Capture le SQL sans toucher à une base. */
function makeSqlSpy(rows: unknown[] = []) {
  const statements: string[] = []
  return {
    statements,
    tx: {
      query: async (sql: string) => {
        statements.push(sql)
        return { rows, rowCount: rows.length } as never
      },
    },
  }
}

const round = (value: number, decimals: number) => {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/** Transcription exacte du SQL de `copyPieceOperationsToOf`. */
function sqlPlannedTimes(tp: number, tfUnit: number, qte: number, coef: number) {
  const tempsFabrication = round(tfUnit * qte * coef, 4)
  return { temps_fabrication_planned: tempsFabrication, temps_total_planned: round(tp + tempsFabrication, 3) }
}

/** Ancienne implémentation, conservée comme témoin de non-régression. */
function legacyPlannedTotal(tp: number, tfUnit: number, qte: number, coef: number) {
  return round((tp + tfUnit * qte) * coef, 3)
}

describe("Snapshot OF — colonnes figées", () => {
  it("recopie famille, machine, programme, centre de frais et tarif retenu", async () => {
    const spy = makeSqlSpy()
    await copyPieceOperationsToOf(spy.tx, {
      of_id: 1,
      piece_technique_id: "11111111-1111-1111-1111-111111111111",
      gamme_id: "22222222-2222-2222-2222-222222222222",
    })
    const sql = spy.statements.join("\n")

    for (const column of [
      "machine_family_code",
      "numero_programme",
      "cf_code_snapshot",
      "cf_rate_id",
      "hourly_rate_source",
      "hourly_rate_effective_at",
      "temps_fabrication_planned",
    ]) {
      expect(sql, `colonne ${column} absente du snapshot`).toContain(column)
    }
  })

  it("ne perd plus la machine choisie en gamme", async () => {
    const spy = makeSqlSpy()
    await copyPieceOperationsToOf(spy.tx, {
      of_id: 1,
      piece_technique_id: "11111111-1111-1111-1111-111111111111",
      gamme_id: null,
    })
    const sql = spy.statements.join("\n")
    // La régression exacte : `NULL::uuid AS machine_id`.
    expect(sql).not.toMatch(/NULL::uuid\s+AS\s+machine_id/)
    expect(sql).toContain("pto.machine_id")
  })

  it("recopie le code lisible du centre de frais, pas seulement son identifiant", async () => {
    const spy = makeSqlSpy()
    await copyPieceOperationsToOf(spy.tx, {
      of_id: 1,
      piece_technique_id: "11111111-1111-1111-1111-111111111111",
      gamme_id: null,
    })
    const sql = spy.statements.join("\n")
    // Sans cette jointure, archiver un centre de frais rendrait le snapshot illisible.
    expect(sql).toContain("LEFT JOIN public.centres_frais cf ON cf.id = pto.cf_id")
    expect(sql).toContain("cf.code AS cf_code_snapshot")
  })
})

describe("Snapshot OF — accord des temps avec la gamme", () => {
  const cases = [
    { tp: 0, tf: 0, qte: 1, coef: 1 },
    { tp: 0.5, tf: 0.02, qte: 1, coef: 1 },
    { tp: 2, tf: 0.1, qte: 1, coef: 1 },
    // Les cas qui font diverger l'ancienne formule : coef ≠ 1 ET tp ≠ 0.
    { tp: 2, tf: 0.1, qte: 1, coef: 1.2 },
    { tp: 1.5, tf: 0.25, qte: 10, coef: 0.8 },
    { tp: 0.75, tf: 0.033, qte: 250, coef: 1.05 },
  ]

  it("le SQL de l'OF donne exactement le temps calculé par la gamme", () => {
    for (const { tp, tf, qte, coef } of cases) {
      const gamme = computeOperationTimes({
        temps_preparation: tp,
        temps_unitaire: tf,
        quantite_base: qte,
        coefficient: coef,
      })
      const of = sqlPlannedTimes(tp, tf, qte, coef)
      expect(of.temps_fabrication_planned, `temps_fabrication pour ${JSON.stringify({ tp, tf, qte, coef })}`).toBe(
        gamme.temps_fabrication,
      )
      // `temps_total_planned` est stocké en numeric(12,3) : on compare à 3 décimales.
      expect(of.temps_total_planned, `temps_final pour ${JSON.stringify({ tp, tf, qte, coef })}`).toBe(
        round(gamme.temps_final, 3),
      )
    }
  })

  it("l'ancienne formule divergeait bien dès que coef ≠ 1 et tp ≠ 0", () => {
    // Sans ce témoin, la correction pourrait être annulée sans que rien n'échoue.
    const divergent = { tp: 2, tf: 0.1, qte: 1, coef: 1.2 }
    const gamme = computeOperationTimes({
      temps_preparation: divergent.tp,
      temps_unitaire: divergent.tf,
      quantite_base: divergent.qte,
      coefficient: divergent.coef,
    })
    expect(legacyPlannedTotal(divergent.tp, divergent.tf, divergent.qte, divergent.coef)).not.toBe(
      round(gamme.temps_final, 3),
    )

    // …et restait juste quand coef = 1 : la correction ne réécrit pas l'histoire
    // des OF lancés sans coefficient.
    const neutre = { tp: 2, tf: 0.1, qte: 3, coef: 1 }
    const gammeNeutre = computeOperationTimes({
      temps_preparation: neutre.tp,
      temps_unitaire: neutre.tf,
      quantite_base: neutre.qte,
      coefficient: neutre.coef,
    })
    expect(legacyPlannedTotal(neutre.tp, neutre.tf, neutre.qte, neutre.coef)).toBe(round(gammeNeutre.temps_final, 3))
  })

  it("la quantité de base n'est jamais multipliée deux fois", () => {
    // `qte` est la quantité de BASE de la gamme. Le SQL ne doit pas la
    // remultiplier par la quantité lancée de l'OF.
    const base = sqlPlannedTimes(1, 0.5, 4, 1)
    expect(base.temps_fabrication_planned).toBe(2) // 0.5 × 4 × 1, pas 0.5 × 4 × 4.
    expect(base.temps_total_planned).toBe(3)
  })
})

describe("Snapshot JSON — preuve figée lisible", () => {
  it("embarque référentiels en clair, programme, unité de temps et coûts", async () => {
    const spy = makeSqlSpy([{ version_id: "v", gamme_id: "g", version_interne: 1, snapshot: { ok: true } }])
    await loadApplicableTechnicalSnapshot(spy.tx, "11111111-1111-1111-1111-111111111111")
    const sql = spy.statements.join("\n")

    for (const key of [
      "'machine_family_code'",
      "'machine_family_libelle'",
      "'machine_code'",
      "'numero_programme'",
      "'cf_code'",
      "'cf_rate_id'",
      "'taux_horaire_source'",
      "'unite_temps', 'HEURES_DECIMALES'",
      "'temps_fabrication'",
      "'cout_mo'",
      "'ordre'",
    ]) {
      expect(sql, `clé ${key} absente du snapshot JSON`).toContain(key)
    }
  })
})

describe("Snapshot OF — diagnostic version non applicable", () => {
  it("retourne la pièce et les versions exploitables par l'interface", async () => {
    let call = 0
    const tx = {
      query: async () => {
        call += 1
        if (call === 1) return { rows: [] } as never
        return {
          rows: [{
            piece_technique_id: "11111111-1111-1111-1111-111111111111",
            code_piece: "PT-001",
            designation: "Pièce test",
            versions: [{ id: "v1", indice: "A", statut: "EN_VALIDATION", date_effet: null, effective_now: false }],
          }],
        } as never
      },
    }

    await expect(loadApplicableTechnicalSnapshot(tx, "11111111-1111-1111-1111-111111111111")).rejects.toMatchObject({
      status: 422,
      code: "VERSION_NOT_APPLICABLE",
      details: {
        piece_technique_id: "11111111-1111-1111-1111-111111111111",
        code_piece: "PT-001",
        versions: [{ indice: "A", statut: "EN_VALIDATION", effective_now: false }],
      },
    })
  })
})
