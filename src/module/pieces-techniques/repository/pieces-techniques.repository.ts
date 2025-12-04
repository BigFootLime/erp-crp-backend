// src/module/pieces-techniques/repository/pieces-techniques.repository.ts
import db from "../../../config/database"
import type {
  PieceTechnique,
  CreatePieceTechniqueInput,
  BomLine,
  Operation,
  Achat,
} from "../types/pieces-techniques.types"

function mapPieceTechniqueRow(row: any): PieceTechnique {
  return {
    id: row.id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    client_id: row.client_id,
    created_by: row.created_by,
    updated_by: row.updated_by,
    famille_id: row.famille_id,
    name_piece: row.name_piece,
    code_piece: row.code_piece,
    designation: row.designation,
    designation_2: row.designation_2,
    prix_unitaire: Number(row.prix_unitaire),
    en_fabrication: (row.en_fabrication ?? 0) === 1,
    cycle: row.cycle,
    cycle_fabrication: row.cycle_fabrication,
    code_client: row.code_client,
    client_name: row.client_name,
    ensemble: row.ensemble,

    bom: row.bom ?? [],
    operations: row.operations ?? [],
    achats: row.achats ?? [],
  }
}

/* ------------------------------ CREATE ------------------------------ */

export async function repoCreatePieceTechnique(
  input: CreatePieceTechniqueInput
): Promise<PieceTechnique> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const insertMainSQL = `
      INSERT INTO pieces_techniques (
        client_id, created_by, updated_by,
        famille_id, name_piece, code_piece, designation, designation_2,
        prix_unitaire, en_fabrication, cycle, cycle_fabrication,
        code_client, client_name, ensemble
      )
      VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15,
      )
      RETURNING *
    `

    const mainParams = [
      input.client_id ?? null,
      input.created_by ?? null,
      input.updated_by ?? null,
      input.famille_id,
      input.name_piece,
      input.code_piece,
      input.designation,
      input.designation_2 ?? null,
      input.prix_unitaire,
      input.en_fabrication ? 1 : 0, // bool -> int
      input.cycle ?? null,
      input.cycle_fabrication ?? null,
      input.code_client ?? null,
      input.client_name ?? null,
      input.ensemble,
    ]

    const { rows: mainRows } = await client.query(insertMainSQL, mainParams)
    const pieceRow = mainRows[0]
    const pieceId = pieceRow.id as string

    const piece: PieceTechnique = {
      ...mapPieceTechniqueRow({
        ...pieceRow,
        bom: [],
        operations: [],
        achats: [],
      }),
    }

    /* ---- NOMENCLATURE ---- */
    const bom: BomLine[] = []
    for (const line of input.bom ?? []) {
      const { rows } = await client.query(
        `
        INSERT INTO pieces_techniques_nomenclature (
          parent_piece_technique_id,
          child_piece_technique_id,
          rang,
          quantite,
          repere,
          designation
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, parent_piece_technique_id, child_piece_technique_id,
                  rang, quantite, repere, designation
        `,
        [
          pieceId,
          line.child_piece_id,
          line.rang,
          line.quantite,
          line.repere ?? null,
          line.designation ?? null,
        ]
      )
      const r = rows[0]
      bom.push({
        id: r.id,
        child_piece_id: r.child_piece_technique_id,
        rang: r.rang,
        quantite: Number(r.quantite),
        repere: r.repere,
        designation: r.designation,
      })
    }
    piece.bom = bom

    /* ---- OPERATIONS ---- */
    const operations: Operation[] = []
    for (const op of input.operations ?? []) {
      const { rows } = await client.query(
        `
        INSERT INTO pieces_techniques_operations (
          piece_technique_id,
          cf_id,
          phase,
          designation,
          designation_2,
          prix,
          coef,
          tp,
          tf_unit,
          qte,
          taux_horaire,
          temps_total,
          cout_mo
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING *
        `,
        [
          pieceId,
          op.cf_id ?? null,
          op.phase,
          op.designation,
          op.designation_2 ?? null,
          op.prix,
          op.coef,
          op.tp,
          op.tf_unit,
          op.qte,
          op.taux_horaire,
          op.temps_total,
          op.cout_mo,
        ]
      )
      const r = rows[0]
      operations.push({
        id: r.id,
        phase: r.phase,
        designation: r.designation,
        designation_2: r.designation_2,
        cf_id: r.cf_id,
        prix: Number(r.prix),
        coef: Number(r.coef),
        tp: Number(r.tp),
        tf_unit: Number(r.tf_unit),
        qte: Number(r.qte),
        taux_horaire: Number(r.taux_horaire),
        temps_total: Number(r.temps_total),
        cout_mo: Number(r.cout_mo),
      })
    }
    piece.operations = operations

    /* ---- ACHATS ---- */
    const achats: Achat[] = []
    for (const a of input.achats ?? []) {
      const { rows } = await client.query(
        `
        INSERT INTO pieces_techniques_achats (
          piece_technique_id,
          phase,
          famille_piece_id,
          nom,
          fournisseur_id,
          fournisseur_nom,
          fournisseur_code,
          quantite,
          quantite_brut_mm,
          longueur_mm,
          coefficient_chute,
          quantite_pieces,
          prix_par_quantite,
          tarif,
          prix,
          unite_prix,
          pu_achat,
          tva_achat,
          total_achat_ht,
          total_achat_ttc,
          designation,
          designation_2,
          designation_3
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,
          $14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )
        RETURNING *
        `,
        [
          pieceId,
          a.phase ?? null,
          a.famille_piece_id ?? null,
          a.nom ?? null,
          a.fournisseur_id ?? null,
          a.fournisseur_nom ?? null,
          a.fournisseur_code ?? null,
          a.quantite,
          a.quantite_brut_mm ?? null,
          a.longueur_mm ?? null,
          a.coefficient_chute ?? null,
          a.quantite_pieces ?? null,
          a.prix_par_quantite ?? null,
          a.tarif ?? null,
          a.prix ?? null,
          a.unite_prix ?? null,
          a.pu_achat ?? 0,
          a.tva_achat ?? 20,
          a.total_achat_ht ?? 0,
          a.total_achat_ttc ?? 0,
          a.designation ?? null,
          a.designation_2 ?? null,
          a.designation_3 ?? null,
        ]
      )
      const r = rows[0]
      achats.push({
        id: r.id,
        phase: r.phase,
        famille_piece_id: r.famille_piece_id,
        nom: r.nom,
        fournisseur_id: r.fournisseur_id,
        fournisseur_nom: r.fournisseur_nom,
        fournisseur_code: r.fournisseur_code,
        quantite: Number(r.quantite),
        quantite_brut_mm: r.quantite_brut_mm ? Number(r.quantite_brut_mm) : null,
        longueur_mm: r.longueur_mm ? Number(r.longueur_mm) : null,
        coefficient_chute: r.coefficient_chute ? Number(r.coefficient_chute) : null,
        quantite_pieces: r.quantite_pieces ? Number(r.quantite_pieces) : null,
        prix_par_quantite: r.prix_par_quantite ? Number(r.prix_par_quantite) : null,
        tarif: r.tarif ? Number(r.tarif) : null,
        prix: r.prix ? Number(r.prix) : null,
        unite_prix: r.unite_prix,
        pu_achat: r.pu_achat ? Number(r.pu_achat) : null,
        tva_achat: r.tva_achat ? Number(r.tva_achat) : null,
        total_achat_ht: r.total_achat_ht ? Number(r.total_achat_ht) : null,
        total_achat_ttc: r.total_achat_ttc ? Number(r.total_achat_ttc) : null,
        designation: r.designation,
        designation_2: r.designation_2,
        designation_3: r.designation_3,
      })
    }
    piece.achats = achats

    await client.query("COMMIT")
    return piece
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}

/* ------------------------------ LIST / GET ------------------------------ */

export async function repoListPieceTechniques(): Promise<PieceTechnique[]> {
  const sql = `
    SELECT
      p.*,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', n.id,
            'child_piece_technique_id', n.child_piece_technique_id,
            'rang', n.rang,
            'quantite', n.quantite,
            'repere', n.repere,
            'designation', n.designation
          )
        ) FILTER (WHERE n.id IS NOT NULL),
        '[]'
      ) AS bom,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', o.id,
            'phase', o.phase,
            'designation', o.designation,
            'designation_2', o.designation_2,
            'cf_id', o.cf_id,
            'prix', o.prix,
            'coef', o.coef,
            'tp', o.tp,
            'tf_unit', o.tf_unit,
            'qte', o.qte,
            'taux_horaire', o.taux_horaire,
            'temps_total', o.temps_total,
            'cout_mo', o.cout_mo
          )
        ) FILTER (WHERE o.id IS NOT NULL),
        '[]'
      ) AS operations,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', a.id,
            'phase', a.phase,
            'famille_piece_id', a.famille_piece_id,
            'nom', a.nom,
            'fournisseur_id', a.fournisseur_id,
            'fournisseur_nom', a.fournisseur_nom,
            'fournisseur_code', a.fournisseur_code,
            'quantite', a.quantite,
            'quantite_brut_mm', a.quantite_brut_mm,
            'longueur_mm', a.longueur_mm,
            'coefficient_chute', a.coefficient_chute,
            'quantite_pieces', a.quantite_pieces,
            'prix_par_quantite', a.prix_par_quantite,
            'tarif', a.tarif,
            'prix', a.prix,
            'unite_prix', a.unite_prix,
            'pu_achat', a.pu_achat,
            'tva_achat', a.tva_achat,
            'total_achat_ht', a.total_achat_ht,
            'total_achat_ttc', a.total_achat_ttc,
            'designation', a.designation,
            'designation_2', a.designation_2,
            'designation_3', a.designation_3
          )
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'
      ) AS achats
    FROM pieces_techniques p
    LEFT JOIN pieces_techniques_nomenclature n ON n.parent_piece_technique_id = p.id
    LEFT JOIN pieces_techniques_operations o ON o.piece_technique_id = p.id
    LEFT JOIN pieces_techniques_achats a ON a.piece_technique_id = p.id
    GROUP BY p.id
    ORDER BY p.created_at DESC
  `

  const { rows } = await db.query(sql)
  return rows.map(mapPieceTechniqueRow)
}

export async function repoGetPieceTechnique(id: string): Promise<PieceTechnique | null> {
  const sql = `
    SELECT
      p.*,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', n.id,
            'child_piece_technique_id', n.child_piece_technique_id,
            'rang', n.rang,
            'quantite', n.quantite,
            'repere', n.repere,
            'designation', n.designation
          )
        ) FILTER (WHERE n.id IS NOT NULL),
        '[]'
      ) AS bom,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', o.id,
            'phase', o.phase,
            'designation', o.designation,
            'designation_2', o.designation_2,
            'cf_id', o.cf_id,
            'prix', o.prix,
            'coef', o.coef,
            'tp', o.tp,
            'tf_unit', o.tf_unit,
            'qte', o.qte,
            'taux_horaire', o.taux_horaire,
            'temps_total', o.temps_total,
            'cout_mo', o.cout_mo
          )
        ) FILTER (WHERE o.id IS NOT NULL),
        '[]'
      ) AS operations,
      COALESCE(
        json_agg(
          DISTINCT jsonb_build_object(
            'id', a.id,
            'phase', a.phase,
            'famille_piece_id', a.famille_piece_id,
            'nom', a.nom,
            'fournisseur_id', a.fournisseur_id,
            'fournisseur_nom', a.fournisseur_nom,
            'fournisseur_code', a.fournisseur_code,
            'quantite', a.quantite,
            'quantite_brut_mm', a.quantite_brut_mm,
            'longueur_mm', a.longueur_mm,
            'coefficient_chute', a.coefficient_chute,
            'quantite_pieces', a.quantite_pieces,
            'prix_par_quantite', a.prix_par_quantite,
            'tarif', a.tarif,
            'prix', a.prix,
            'unite_prix', a.unite_prix,
            'pu_achat', a.pu_achat,
            'tva_achat', a.tva_achat,
            'total_achat_ht', a.total_achat_ht,
            'total_achat_ttc', a.total_achat_ttc,
            'designation', a.designation,
            'designation_2', a.designation_2,
            'designation_3', a.designation_3
          )
        ) FILTER (WHERE a.id IS NOT NULL),
        '[]'
      ) AS achats
    FROM pieces_techniques p
    LEFT JOIN pieces_techniques_nomenclature n ON n.parent_piece_technique_id = p.id
    LEFT JOIN pieces_techniques_operations o ON o.piece_technique_id = p.id
    LEFT JOIN pieces_techniques_achats a ON a.piece_technique_id = p.id
    WHERE p.id = $1
    GROUP BY p.id
  `

  const { rows } = await db.query(sql, [id])
  if (!rows[0]) return null
  return mapPieceTechniqueRow(rows[0])
}

export async function repoDeletePieceTechnique(id: string): Promise<boolean> {
  const { rowCount } = await db.query(
    "DELETE FROM pieces_techniques WHERE id = $1",
    [id]
  )
  return (rowCount ?? 0) > 0
}

/* ------------------------------ UPDATE ------------------------------ */

export async function repoUpdatePieceTechnique(
  id: string,
  input: CreatePieceTechniqueInput
): Promise<PieceTechnique | null> {
  const client = await db.connect()
  try {
    await client.query("BEGIN")

    const sqlMain = `
      UPDATE pieces_techniques
      SET
        client_id = $2,
        created_by = $3,
        updated_by = $4,
        famille_id = $5,
        name_piece = $6,
        code_piece = $7,
        designation = $8,
        designation_2 = $9,
        prix_unitaire = $10,
        en_fabrication = $11,
        cycle = $12,
        cycle_fabrication = $13,
        code_client = $14,
        client_name = $15,
        ensemble = $16,
        updated_at = now()
      WHERE id = $17
      RETURNING *
    `

    const mainParams = [
      input.client_id ?? null,
      input.created_by ?? null,
      input.updated_by ?? null,
      input.famille_id,
      input.name_piece,
      input.code_piece,
      input.designation,
      input.designation_2 ?? null,
      input.prix_unitaire,
      input.en_fabrication ? 1 : 0,
      input.cycle ?? null,
      input.cycle_fabrication ?? null,
      input.code_client ?? null,
      input.client_name ?? null,
      input.ensemble,
      id,
    ]

    const { rows: mainRows } = await client.query(sqlMain, mainParams)
    if (!mainRows[0]) {
      await client.query("ROLLBACK")
      return null
    }

    // Supprimer les enfants
    await client.query("DELETE FROM pieces_techniques_nomenclature WHERE parent_piece_technique_id = $1", [id])
    await client.query("DELETE FROM pieces_techniques_operations WHERE piece_technique_id = $1", [id])
    await client.query("DELETE FROM pieces_techniques_achats WHERE piece_technique_id = $1", [id])

    // Réinsérer nomenclature
    for (const line of input.bom ?? []) {
      await client.query(
        `
        INSERT INTO pieces_techniques_nomenclature (
          parent_piece_technique_id,
          child_piece_technique_id,
          rang,
          quantite,
          repere,
          designation
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          id,
          line.child_piece_id,
          line.rang,
          line.quantite,
          line.repere ?? null,
          line.designation ?? null,
        ]
      )
    }

    // Réinsérer opérations
    for (const op of input.operations ?? []) {
      await client.query(
        `
        INSERT INTO pieces_techniques_operations (
          piece_technique_id,
          cf_id,
          phase,
          designation,
          designation_2,
          prix,
          coef,
          tp,
          tf_unit,
          qte,
          taux_horaire,
          temps_total,
          cout_mo
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `,
        [
          id,
          op.cf_id ?? null,
          op.phase,
          op.designation,
          op.designation_2 ?? null,
          op.prix,
          op.coef,
          op.tp,
          op.tf_unit,
          op.qte,
          op.taux_horaire,
          op.temps_total,
          op.cout_mo,
        ]
      )
    }

    // Réinsérer achats
    for (const a of input.achats ?? []) {
      await client.query(
        `
        INSERT INTO pieces_techniques_achats (
          piece_technique_id,
          phase,
          famille_piece_id,
          nom,
          fournisseur_id,
          fournisseur_nom,
          fournisseur_code,
          quantite,
          quantite_brut_mm,
          longueur_mm,
          coefficient_chute,
          quantite_pieces,
          prix_par_quantite,
          tarif,
          prix,
          unite_prix,
          pu_achat,
          tva_achat,
          total_achat_ht,
          total_achat_ttc,
          designation,
          designation_2,
          designation_3
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
        )
        `,
        [
          id,
          a.phase ?? null,
          a.famille_piece_id ?? null,
          a.nom ?? null,
          a.fournisseur_id ?? null,
          a.fournisseur_nom ?? null,
          a.fournisseur_code ?? null,
          a.quantite,
          a.quantite_brut_mm ?? null,
          a.longueur_mm ?? null,
          a.coefficient_chute ?? null,
          a.quantite_pieces ?? null,
          a.prix_par_quantite ?? null,
          a.tarif ?? null,
          a.prix ?? null,
          a.unite_prix ?? null,
          a.pu_achat ?? 0,
          a.tva_achat ?? 20,
          a.total_achat_ht ?? 0,
          a.total_achat_ttc ?? 0,
          a.designation ?? null,
          a.designation_2 ?? null,
          a.designation_3 ?? null,
        ]
      )
    }

    await client.query("COMMIT")
    // On relit avec l'agrégation pour renvoyer un objet complet
    const updated = await repoGetPieceTechnique(id)
    return updated
  } catch (err) {
    await client.query("ROLLBACK")
    throw err
  } finally {
    client.release()
  }
}
