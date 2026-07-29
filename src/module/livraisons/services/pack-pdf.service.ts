import { readIssuerParty } from "../../../shared/documents/issuer-identity.repository"
import { CONTENT_WIDTH, renderCerpDocument, type CerpLineRow } from "../../../shared/pdf/cerp-document"
import { issuerIdentityLine, issuerLegalMentions, pickMention } from "../../../shared/pdf/legal-mentions"

import { clean, formatDateFR, lotCodesOf, renderBonLivraisonDocument, toUtcMidnightFromIso } from "./bon-livraison-document"

import type { LivraisonPackPreview } from "../types/pack.types"

/**
 * Pack d'expedition : bon de livraison et certificat de conformite.
 *
 * Rendus sur le socle `shared/pdf/cerp-document`, qui porte cote serveur la grammaire arretee
 * par ADR-0039 et ADR-0040 : logo officiel, accent unique, bandeau d'identifiants, sections
 * titrees, cartes d'adresse, table paginee, pied de page « Page X / Y ».
 *
 * Ces deux documents **partent chez le client** et sont **figes** : le pack les hache
 * (SHA-256), les archive dans la GED et permet de les revoquer. Ils ne portent donc que de la
 * donnee opposable, et aucun vocabulaire interne.
 */

// L'emetteur n'est plus reduit a sa raison sociale : ces documents partent chez le client,
// ils doivent porter l'identite legale complete (art. R123-237 C. com.).

/**
 * Vocabulaire interne des mouvements de stock, traduit pour un lecteur externe.
 *
 * Un certificat qui part chez le client ne doit pas afficher `OUT` ni `POSTED`. Un code
 * inconnu est rendu tel quel : mieux vaut un libelle brut qu'une traduction inventee.
 */
const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  IN: "Entrée",
  OUT: "Sortie",
  TRANSFER: "Transfert",
  ADJUST: "Ajustement",
  ADJUSTMENT: "Ajustement",
  RESERVE: "Réservation",
  UNRESERVE: "Levée de réservation",
  DEPRECIATE: "Dépréciation",
  SCRAP: "Rebut",
}

const MOVEMENT_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Brouillon",
  POSTED: "Comptabilisé",
  CANCELLED: "Annulé",
}

function labelOf(dictionary: Record<string, string>, code: string | null | undefined): string {
  const raw = clean(code)
  if (!raw) return "—"
  return dictionary[raw.toUpperCase()] ?? raw
}

export async function svcRenderPackBonLivraisonPdf(args: { preview: LivraisonPackPreview; version: number }): Promise<Buffer> {
  const bl = args.preview.bon_livraison
  const issuer = await readIssuerParty({ at: bl.date_expedition ?? bl.date_creation })
  return renderBonLivraisonDocument({
    header: bl,
    lignes: args.preview.lignes,
    version: args.version,
    company: pickMention(issuer, "company_name"),
    issuer,
  })
}

export async function svcRenderPackCofcPdf(args: {
  preview: LivraisonPackPreview
  version: number
  signataireLabel: string
  commentairePack: string | null
  includeDocuments: boolean
}): Promise<Buffer> {
  const p = args.preview
  const bl = p.bon_livraison
  const issuer = await readIssuerParty({ at: bl.date_expedition ?? bl.date_creation })
  const company = pickMention(issuer, "company_name")
  const clientName = clean(bl.client.company_name) ?? "Client"

  const rows: CerpLineRow[] = p.lignes.map((line) => {
    const lots = lotCodesOf(line.allocations)
    return {
      cells: {
        designation: line.designation,
        code_piece: clean(line.code_piece) ?? "—",
        quantite: String(line.quantite ?? 0),
        lots: lots.length ? lots.join(", ") : "—",
      },
      metaColumn: "designation",
      meta: null,
    }
  })

  return renderCerpDocument(
    {
      documentType: "Certificat de conformité",
      name: bl.numero,
      code: `Version ${args.version}`,
      subtitle: clientName,
      status: "Conforme",
      monogramName: clientName,
      generatedAt: formatDateFR(bl.date_expedition ?? bl.date_creation),
      generatedBy: clean(args.signataireLabel),
      title: `Certificat de conformité ${bl.numero}`,
      subject: "Certificat de conformité CERP",
      legalIdentity: issuerIdentityLine(issuer),
      legalMentions: issuerLegalMentions(issuer),
      creationDate: toUtcMidnightFromIso(bl.date_expedition ?? bl.date_creation),
    },
    (ctx) => {
      ctx.legalStrip([
        { label: "Bon de livraison", value: bl.numero },
        { label: "Date", value: formatDateFR(bl.date_expedition ?? bl.date_creation) },
        { label: "Commande", value: clean(bl.commande?.numero) },
        { label: "Affaire", value: clean(bl.affaire?.reference) },
      ])

      ctx.section("Attestation", { cohesion: 70 })
      ctx.notes(
        `${company ?? "Croix Rousse Precision"} certifie que les pièces livrées au titre du bon de livraison ` +
          `${bl.numero} sont conformes aux exigences contractuelles et aux contrôles réalisés.`
      )

      if (clean(args.commentairePack)) {
        ctx.section("Observations")
        ctx.notes(args.commentairePack as string)
      }

      ctx.section("Pièces et lots expédiés", { cohesion: 104 })
      ctx.linesTable({
        columns: [
          { key: "designation", label: "Désignation", flex: 5 },
          { key: "code_piece", label: "Code pièce", flex: 1.8 },
          { key: "quantite", label: "Quantité", flex: 1.2, align: "right" },
          { key: "lots", label: "Lots expédiés", flex: 3 },
        ],
        rows,
        emptyLabel: "Aucune pièce sur ce certificat.",
      })

      // La tracabilite est ce qui rend le certificat opposable : elle reste au document.
      if (p.stock_movements.length) {
        ctx.section("Traçabilité des mouvements")
        ctx.linesTable({
          columns: [
            { key: "movement", label: "Mouvement", flex: 3 },
            { key: "type", label: "Type", flex: 3 },
            { key: "statut", label: "Statut", flex: 2.5 },
            { key: "date", label: "Date", flex: 2 },
          ],
          rows: p.stock_movements.map((movement) => ({
            // Le numero de mouvement est ce qui permet de remonter la piste : c'est lui qu'on
            // met en avant, pas son type.
            metaColumn: "movement",
            cells: {
              movement: clean(movement.movement_no) ?? movement.id,
              type: labelOf(MOVEMENT_TYPE_LABELS, movement.movement_type),
              statut: labelOf(MOVEMENT_STATUS_LABELS, movement.status),
              date: formatDateFR(movement.posted_at),
            },
          })),
          emptyLabel: "Aucun mouvement de stock rattaché.",
        })
      }

      if (args.includeDocuments) {
        ctx.section("Documents joints")
        ctx.linesTable({
          columns: [{ key: "nom", label: "Document", flex: 1 }],
          rows: p.documents_attached.map((document) => ({
            cells: { nom: clean(document.document_name) ?? document.document_id },
          })),
          emptyLabel: "Aucun document joint.",
        })
      }

      ctx.section("Établi par", { cohesion: 40 })
      const half = CONTENT_WIDTH / 2 - 12
      const bottom = ctx.field("Signataire", clean(args.signataireLabel), 38, half)
      ctx.field("Date", formatDateFR(bl.date_expedition ?? bl.date_creation), 38 + half + 24, half)
      ctx.y = bottom
    }
  )
}
