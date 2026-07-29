import { renderCerpDocument, type CerpAddressCard, type CerpLineRow } from "../../../shared/pdf/cerp-document"
import { issuerIdentityLine, issuerLegalMentions, type LegalParty } from "../../../shared/pdf/legal-mentions"

import type { BonLivraisonHeader, BonLivraisonLigne, BonLivraisonLigneAllocation } from "../types/livraisons.types"

/**
 * Rendu unique du bon de livraison.
 *
 * Deux chemins produisent ce document : la generation simple
 * (`POST /livraisons/:id/pdf`, `pdf.service.ts`) et le pack fige et hache
 * (`pack-pdf.service.ts`). Ils dessinaient chacun leur propre mise en page ; le client
 * pouvait donc recevoir deux bons de livraison d'aspect different pour la meme expedition.
 * Le rendu vit desormais ici, une seule fois.
 */

export type BonLivraisonDocumentInput = {
  header: BonLivraisonHeader
  lignes: Array<Pick<BonLivraisonLigne, "ordre" | "designation" | "code_piece" | "quantite" | "unite" | "delai_client"> & {
    allocations: Array<Pick<BonLivraisonLigneAllocation, "lot_code">>
  }>
  version: number
  /** Raison sociale de l'emetteur, lue en base. */
  company: string | null
  /**
   * Instantane de l'emetteur : identite legale et mentions obligatoires.
   *
   * Un bon de livraison est un document commercial : il doit porter l'identite legale de
   * celui qui l'emet (art. R123-237 C. com.), au meme titre qu'une facture. Il ne portait
   * jusqu'ici qu'une raison sociale.
   */
  issuer?: LegalParty
}

export function formatDateFR(iso: string | null | undefined): string {
  if (!iso) return "-"
  const raw = String(iso)
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[3]}/${m[2]}/${m[1]}`

  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return raw
  const dd = String(d.getDate()).padStart(2, "0")
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const yyyy = d.getFullYear()
  return `${dd}/${mm}/${yyyy}`
}

export function toUtcMidnightFromIso(iso: string | null | undefined): Date {
  const raw = typeof iso === "string" ? iso : ""
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) {
    const yyyy = Number(m[1])
    const mm = Number(m[2]) - 1
    const dd = Number(m[3])
    if (Number.isFinite(yyyy) && Number.isFinite(mm) && Number.isFinite(dd)) {
      return new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0))
    }
  }

  const d = new Date(raw)
  if (!Number.isNaN(d.getTime())) return d
  return new Date("1970-01-01T00:00:00.000Z")
}

export function clean(value: string | null | undefined): string | null {
  const s = typeof value === "string" ? value.trim() : ""
  return s ? s : null
}

/** Lots reellement expedies sur une ligne, dedoublonnes. */
export function lotCodesOf(allocations: Array<{ lot_code?: string | null }> | undefined): string[] {
  return Array.from(
    new Set(
      (allocations ?? [])
        .map((allocation) => clean(allocation.lot_code))
        .filter((code): code is string => Boolean(code))
    )
  )
}

/**
 * Adresse de livraison en lignes. Le referentiel ne stocke qu'un libelle libre : on le decoupe
 * sur les retours a la ligne plutot que d'inventer une structure.
 */
export function addressLines(label: string | null | undefined): string[] | null {
  const lines = (label ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines : null
}

export async function renderBonLivraisonDocument(input: BonLivraisonDocumentInput): Promise<Buffer> {
  const { header: bl, company, version } = input
  const issuer = input.issuer ?? {}
  const clientName = clean(bl.client.company_name) ?? "Client"

  // Le referentiel expose l'identifiant technique du client ; il n'a rien a faire sur un
  // document qui part chez lui. Seule la raison sociale est imprimee.
  const destinataire: CerpAddressCard[] = [
    { caption: "Destinataire", lines: [clientName], accent: true },
    {
      caption: "Adresse de livraison",
      lines: addressLines(bl.adresse_livraison?.label),
      emptyLabel: "Non renseignée",
    },
  ]
  if (company) destinataire.push({ caption: "Expéditeur", lines: [company] })

  const rows: CerpLineRow[] = input.lignes.map((line) => {
    const lots = lotCodesOf(line.allocations)
    return {
      cells: {
        ordre: String(line.ordre ?? ""),
        designation: line.designation,
        code_piece: clean(line.code_piece) ?? "—",
        quantite: String(line.quantite ?? 0),
        unite: clean(line.unite) ?? "—",
        delai: clean(line.delai_client) ? formatDateFR(line.delai_client) : "—",
      },
      metaColumn: "designation",
      meta: lots.length ? `Lot(s) expédié(s) : ${lots.join(", ")}` : null,
    }
  })

  return renderCerpDocument(
    {
      documentType: "Bon de livraison",
      name: bl.numero,
      code: `Version ${version}`,
      subtitle: clientName,
      status: clean(bl.date_expedition) ? "Expédié" : "À expédier",
      monogramName: clientName,
      generatedAt: formatDateFR(bl.date_expedition ?? bl.date_creation),
      generatedBy: null,
      title: `Bon de livraison ${bl.numero}`,
      subject: "Bon de livraison CERP",
      legalIdentity: issuerIdentityLine(issuer),
      // La reserve de propriete a ici sa portee la plus forte : c'est a la livraison que se
      // joue le transfert de possession, et la clause n'a d'effet que si l'acheteur en a eu
      // connaissance au plus tard a ce moment-la.
      legalMentions: issuerLegalMentions(issuer),
      creationDate: toUtcMidnightFromIso(bl.date_expedition ?? bl.date_creation),
    },
    (ctx) => {
      ctx.legalStrip([
        { label: "Date du bon", value: formatDateFR(bl.date_creation) },
        { label: "Date d'expédition", value: clean(bl.date_expedition) ? formatDateFR(bl.date_expedition) : null },
        { label: "Transporteur", value: clean(bl.transporteur) },
        { label: "Numéro de suivi", value: clean(bl.tracking_number) },
      ])

      ctx.section("Destinataire & expédition", { cohesion: 90 })
      ctx.addressCards(destinataire)

      // La commande et l'affaire sont ce qui rattache le bon au contrat : elles etaient
      // absentes du bon de livraison alors que le certificat les portait deja.
      const rattachement = [
        { label: "Commande", value: clean(bl.commande?.numero) },
        { label: "Affaire", value: clean(bl.affaire?.reference) },
      ].filter((cell) => cell.value)
      if (rattachement.length) ctx.legalStrip(rattachement)

      ctx.section("Pièces livrées", { cohesion: 104 })
      ctx.linesTable({
        columns: [
          { key: "ordre", label: "N°", flex: 0.55 },
          { key: "designation", label: "Désignation", flex: 4.6 },
          { key: "code_piece", label: "Code pièce", flex: 1.9 },
          { key: "quantite", label: "Quantité", flex: 1.1, align: "right" },
          { key: "unite", label: "Unité", flex: 0.9, align: "right" },
          { key: "delai", label: "Délai client", flex: 1.35, align: "right" },
        ],
        rows,
        emptyLabel: "Aucune ligne sur ce bon de livraison.",
      })

      // Le commentaire destine au client etait saisi mais jamais imprime : sur un document
      // qui part chez lui, c'etait une donnee perdue.
      if (clean(bl.commentaire_client)) {
        ctx.section("Observations")
        ctx.notes(bl.commentaire_client as string)
      }

      // Le cadre de reception est la raison d'etre du document : il doit rester entier.
      ctx.signatureBox("Réception", ["Nom et qualité", "Date", "Signature"])
    }
  )
}
