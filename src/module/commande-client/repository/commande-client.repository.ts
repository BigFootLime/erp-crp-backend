import db from "../../../config/database"
import type {
  CreateCommandeInput, Commande, CommandeDocument
} from "../types/commande-client.types"
import { PoolClient } from "pg"

// Helpers d’inserts
async function insertCommande(client: PoolClient, input: CreateCommandeInput): Promise<Commande> {
  const sql = `
    INSERT INTO commandes (
      numero, designation, client_id, contact_id, destinataire_id, emetteur, code_client,
      date_commande, arc_edi, arc_date_envoi, compteur_affaire_id, type_affaire,
      mode_port_id, mode_reglement_id, commentaire, remise_globale, total_ht, total_ttc
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING *
  `
  const params = [
    input.numero,
    input.designation ?? null,
    input.client_id,
    input.contact_id ?? null,
    input.destinataire_id ?? null,
    input.emetteur ?? null,
    input.code_client ?? null,
    input.date_commande,
    input.arc_edi ?? false,
    input.arc_date_envoi ?? null,
    input.compteur_affaire_id ?? null,
    input.type_affaire ?? "fabrication",
    input.mode_port_id ?? null,
    input.mode_reglement_id ?? null,
    input.commentaire ?? null,
    input.remise_globale ?? 0,
    input.total_ht ?? 0,
    input.total_ttc ?? 0,
  ]
  const { rows } = await client.query(sql, params)
  return rows[0]
}

async function insertLignes(client: PoolClient, commande_id: string, lignes: CreateCommandeInput["lignes"]) {
  if (!lignes?.length) return
  const sql = `
    INSERT INTO commande_lignes (
      commande_id, designation, code_piece, quantite, unite, prix_unitaire_ht, remise_ligne,
      taux_tva, delai_client, delai_interne, total_ht, total_ttc, devis_numero, famille
    ) VALUES
    ${lignes.map((_,i)=>`($1, $${i*13+2}, $${i*13+3}, $${i*13+4}, $${i*13+5}, $${i*13+6},
      $${i*13+7}, $${i*13+8}, $${i*13+9}, $${i*13+10}, $${i*13+11}, $${i*13+12}, $${i*13+13}, $${i*13+14})`).join(",")}
    RETURNING id
  `
  const flat: any[] = []
  lignes.forEach(l=>{
    flat.push(
      l.designation, l.code_piece ?? null, l.quantite, l.unite ?? "u", l.prix_unitaire_ht,
      l.remise_ligne ?? 0, l.taux_tva ?? 20, l.delai_client ?? null, l.delai_interne ?? null,
      l.total_ht ?? 0, l.total_ttc ?? 0, l.devis_numero ?? null, l.famille ?? null
    )
  })
  await client.query(sql, [commande_id, ...flat])
}

async function insertEcheances(client: PoolClient, commande_id: string, echs: CreateCommandeInput["echeancier"]) {
  if (!echs?.length) return
  const sql = `
    INSERT INTO commande_echeances (commande_id, libelle, date_echeance, pourcentage, montant)
    VALUES ${echs.map((_,i)=>`($1, $${i*4+2}, $${i*4+3}, $${i*4+4}, $${i*4+5})`).join(",")}
  `
  const flat: any[] = []
  echs.forEach(e=> flat.push(e.libelle, e.date_echeance, e.pourcentage, e.montant))
  await client.query(sql, [commande_id, ...flat])
}

async function insertPieces(client: PoolClient, commande_id: string, pieces: CreateCommandeInput["pieces"]) {
  if (!pieces?.length) return
  // 10 colonnes : id, commande_id, source_piece_id, code_piece, designation, rang, parent_id, plan, coef, article_id
  const sql = `
    INSERT INTO commande_pieces (
      id, commande_id, source_piece_id, code_piece, designation, rang, parent_id, plan, coef, article_id
    ) VALUES
    ${pieces.map((_, i) =>
      `($${i*10+1}, $${i*10+2}, $${i*10+3}, $${i*10+4}, $${i*10+5}, $${i*10+6}, $${i*10+7}, $${i*10+8}, $${i*10+9}, $${i*10+10})`
    ).join(",")}
  `
  const params: any[] = []
  for (const p of pieces) {
    params.push(
      p.id,                           // ✅ id généré côté front (local)
      commande_id,                    // FK
      p.source_piece_id ?? null,
      p.code_piece ?? null,
      p.designation,
      p.rang,
      p.parent_id ?? null,
      p.plan ?? null,
      p.coef ?? 1,
      p.article_id ?? null
    )
  }
  await client.query(sql, params)
}


async function insertOperations(client: PoolClient, commande_id: string, ops: NonNullable<CreateCommandeInput["operations"]>) {
  if (!ops?.length) return
  const sql = `
    INSERT INTO commande_operations (
      commande_id, piece_id, phase, designation, poste_id, coef, tp, tf_unit, qte, taux_horaire, temps_total, cout_mo
    ) VALUES
    ${ops.map((_,i)=>`($1, $${i*11+2}, $${i*11+3}, $${i*11+4}, $${i*11+5}, $${i*11+6}, $${i*11+7}, $${i*11+8}, $${i*11+9}, $${i*11+10}, $${i*11+11}, $${i*11+12})`).join(",")}
  `
  const flat: any[] = []
  ops.forEach(o=>{
    flat.push(o.piece_id, o.phase, o.designation, o.poste_id ?? null, o.coef ?? 1, o.tp ?? 0,
      o.tf_unit ?? 0, o.qte ?? 1, o.taux_horaire ?? 0, o.temps_total ?? 0, o.cout_mo ?? 0)
  })
  await client.query(sql, [commande_id, ...flat])
}

async function insertAchats(client: PoolClient, commande_id: string, achats: NonNullable<CreateCommandeInput["achats"]>) {
  if (!achats?.length) return
  const sql = `
    INSERT INTO commande_achats (
      commande_id, piece_id, article_id, designation, fournisseur_id, qte, unite, pu_achat, tva_achat, total_achat_ht, total_achat_ttc
    ) VALUES
    ${achats.map((_,i)=>`($1, $${i*10+2}, $${i*10+3}, $${i*10+4}, $${i*10+5}, $${i*10+6}, $${i*10+7}, $${i*10+8}, $${i*10+9}, $${i*10+10}, $${i*10+11})`).join(",")}
  `
  const flat: any[] = []
  achats.forEach(a=>{
    flat.push(a.piece_id, a.article_id ?? null, a.designation, a.fournisseur_id ?? null, a.qte, a.unite ?? null,
      a.pu_achat ?? 0, a.tva_achat ?? 20, a.total_achat_ht ?? 0, a.total_achat_ttc ?? 0)
  })
  await client.query(sql, [commande_id, ...flat])
}

async function insertDocuments(client: PoolClient, commande_id: string, docs: CommandeDocument[]) {
  if (!docs?.length) return
  const sql = `
    INSERT INTO commande_documents (commande_id, filename, path, mimetype, size)
    VALUES ${docs.map((_,i)=>`($1, $${i*4+2}, $${i*4+3}, $${i*4+4}, $${i*4+5})`).join(",")}
  `
  const flat: any[] = []
  docs.forEach(d=> flat.push(d.filename, d.path, d.mimetype ?? null, d.size ?? null))
  await client.query(sql, [commande_id, ...flat])
}

// API
export async function repoCreateCommande(input: CreateCommandeInput, documents: CommandeDocument[]) {
  const client = await db.connect()
  try {
    await client.query("BEGIN")
    const commande = await insertCommande(client, input)
    await insertLignes(client, commande.id, input.lignes)
    await insertEcheances(client, commande.id, input.echeancier ?? [])
    await insertPieces(client, commande.id, input.pieces)
    await insertOperations(client, commande.id, input.operations ?? [])
    await insertAchats(client, commande.id, input.achats ?? [])
    await insertDocuments(client, commande.id, documents ?? [])
    await client.query("COMMIT")
    return commande
  } catch (e) {
    await client.query("ROLLBACK")
    throw e
  } finally {
    client.release()
  }
}

export async function repoGetCommande(id: string) {
  const { rows } = await db.query(`SELECT * FROM commandes WHERE id = $1`, [id])
  return rows[0] ?? null
}

export async function repoListCommandes() {
  const { rows } = await db.query(`SELECT * FROM commandes ORDER BY created_at DESC`)
  return rows
}

export async function repoDeleteCommande(id: string) {
  // suppresion en cascade si FK ON DELETE CASCADE configurées
  const { rowCount } = await db.query(`DELETE FROM commandes WHERE id = $1`, [id])
  return (rowCount ?? 0) > 0  
}
