/**
 * Rendu reel du bon de livraison et du certificat de conformite.
 *
 * Ces deux documents sont **figes, haches et archives** : une regression de rendu n'est pas
 * rattrapable a posteriori sur les exemplaires deja emis. Le backend n'avait aucun test de
 * PDF ; on rend donc pour de vrai et on inspecte le binaire produit.
 *
 * `CERP_PDF_PREVIEW=1` ecrit les PDF dans `outputs/pdf-preview` pour l'inspection visuelle,
 * comme le harnais du frontend.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { inflateSync } from "node:zlib"

import { describe, expect, it, vi } from "vitest"

/**
 * Instantane de l'emetteur, tel que le renvoie `fn_finance_issuer_snapshot`.
 *
 * Le service ne lit plus la seule raison sociale : un bon de livraison est un document
 * commercial et doit porter l'identite legale de son emetteur (art. R123-237 C. com.).
 * `vi.hoisted` est indispensable — `vi.mock` est remonte au-dessus des declarations.
 */
const ISSUER = vi.hoisted(() => ({
  company_name: "CROIX ROUSSE PRECISION",
  address_line_1: "530 Rue de la Dombes",
  postal_code: "01700",
  city: "MIRIBEL LES ECHETS",
  country: "France",
  phone: "04 72 00 26 25",
  legal_form: "SARL",
  share_capital: "21000.00",
  share_capital_currency: "EUR",
  rcs_city: "Bourg-en-Bresse",
  rcs_number: "380 569 012",
  siren: "380 569 012",
  siret: "380 569 012 00020",
  vat_number: "FR73 380 569 012",
  late_penalty_rate: "12.500",
  late_penalty_basis: "ANNUEL",
  recovery_indemnity: "40.00",
  early_discount_rate: "1.500",
  early_discount_basis: "MENSUEL",
  vat_on_receipts: true,
  retention_of_title:
    "Nous nous réservons la propriété des marchandises jusqu'au paiement intégral du prix par l'acheteur.",
  legal_mentions_version: 1,
  legal_mentions_effective_from: "2026-01-01",
}))

// Le service lit l'instantane de l'emetteur en base : la seule dependance a isoler.
vi.mock("../../../config/database", () => ({
  default: { query: vi.fn().mockResolvedValue({ rows: [{ party: ISSUER }] }) },
}))

import { renderBonLivraisonDocument } from "./bon-livraison-document"
import { svcRenderPackBonLivraisonPdf, svcRenderPackCofcPdf } from "./pack-pdf.service"

import type { LivraisonPackPreview } from "../types/pack.types"

const PREVIEW_ENABLED = process.env.CERP_PDF_PREVIEW === "1"
const PREVIEW_DIR = process.env.CERP_PDF_PREVIEW_DIR ?? resolve(process.cwd(), "outputs", "pdf-preview")

function keep(name: string, bytes: Buffer): void {
  if (!PREVIEW_ENABLED) return
  mkdirSync(PREVIEW_DIR, { recursive: true })
  writeFileSync(resolve(PREVIEW_DIR, `${name}.pdf`), bytes)
}

/** Nombre de pages, lu sur l'arbre de pages du PDF. */
function countPages(bytes: Buffer): number {
  const text = bytes.toString("latin1")
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]))
  if (counts.length) return Math.max(...counts)
  return [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length
}

/**
 * Texte reellement dessine, extrait des flux de contenu.
 *
 * pdfkit compresse les flux et ecrit ses chaines en hexadecimal dans des tableaux `TJ`
 * (`[<48656c6c6f> 50 <21>] TJ`). On les inflate et on les decode pour lire ce que le document
 * **affiche**, et non ce que le code croit avoir ecrit. C'est ce qui permet d'affirmer qu'un
 * UUID n'y figure pas.
 *
 * Les polices standard sont encodees en **WinAnsi**, pas en latin1 : les deux coincident sur
 * les accents francais mais divergent de `0x80` a `0x9F`, ou WinAnsi loge le tiret cadratin,
 * l'apostrophe typographique et les guillemets. Lire en latin1 ferait disparaitre ces
 * caracteres du texte extrait et laisserait croire a une perte de donnee.
 */
const WINANSI = new TextDecoder("windows-1252")

function drawnPages(bytes: Buffer): string[] {
  const decodeOperands = (operands: string): string =>
    [...operands.matchAll(/<([0-9a-fA-F\s]*)>|\(((?:\\.|[^\\)])*)\)/g)]
      .map((m) =>
        m[1] !== undefined
          ? WINANSI.decode(Buffer.from(m[1].replace(/\s+/g, ""), "hex"))
          : m[2].replace(/\\([()\\])/g, "$1")
      )
      .join("")

  const pages: string[] = []
  let cursor = 0

  for (;;) {
    const start = bytes.indexOf("stream", cursor)
    if (start < 0) break
    let from = start + "stream".length
    if (bytes[from] === 0x0d) from += 1
    if (bytes[from] === 0x0a) from += 1
    const end = bytes.indexOf("endstream", from)
    if (end < 0) break
    cursor = end + "endstream".length

    let content: string
    try {
      content = inflateSync(bytes.subarray(from, end)).toString("latin1")
    } catch {
      continue // flux non compresse ou image : sans interet ici
    }
    // Chaque page a son propre flux de contenu ; `BT` en marque le texte.
    if (!content.includes("BT")) continue

    pages.push(
      [
        ...[...content.matchAll(/\[([^\]]*)\]\s*TJ/g)].map((m) => decodeOperands(m[1])),
        ...[...content.matchAll(/(<[0-9a-fA-F\s]*>|\((?:\\.|[^\\)])*\))\s*Tj/g)].map((m) => decodeOperands(m[1])),
      ].join("\n")
    )
  }

  return pages
}

/** Texte de tout le document, pages concatenees. */
function drawnText(bytes: Buffer): string {
  return drawnPages(bytes).join("\n")
}

const USER = { id: 1, username: "kmartin", name: "Keenan", surname: "MARTIN", label: "Keenan MARTIN" }

const STAMPS = {
  created_at: "2026-07-20T08:00:00.000Z",
  updated_at: "2026-07-20T08:00:00.000Z",
  created_by: USER,
  updated_by: USER,
}

function ligne(index: number, overrides: Partial<LivraisonPackPreview["lignes"][number]> = {}) {
  return {
    id: `ligne-${index}`,
    bon_livraison_id: "bl-1",
    ordre: index,
    designation: `Corps de vanne inox 316L — usinage complet, plan 45${index}-A indice C`,
    code_piece: `PT-45${String(index).padStart(2, "0")}-A`,
    quantite: index * 10,
    unite: "pce",
    commande_ligne_id: index,
    delai_client: "2026-10-12",
    allocations: [],
    ...STAMPS,
    ...overrides,
  } as LivraisonPackPreview["lignes"][number]
}

function allocation(lotCode: string | null) {
  return {
    id: `alloc-${lotCode ?? "none"}`,
    bon_livraison_ligne_id: "ligne-1",
    article_id: "art-1",
    lot_id: lotCode ? "lot-1" : null,
    lot_code: lotCode,
    lot_status: lotCode ? "RELEASED" : null,
    magasin_id: null,
    magasin_code: null,
    emplacement_id: null,
    emplacement_code: null,
    location_id: null,
    stock_level_id: null,
    stock_batch_id: null,
    reservation_id: null,
    reservation_status: null,
    stock_movement_line_id: null,
    quantite: 10,
    unite: "pce",
    article: { code: "ART-1", designation: "Corps de vanne" },
    lot: lotCode ? { lot_code: lotCode } : null,
    ...STAMPS,
  } as LivraisonPackPreview["lignes"][number]["allocations"][number]
}

/** Identifiant technique du client : il ne doit apparaitre sur aucun des deux documents. */
const CLIENT_UUID = "8f1c2b4e-7d3a-4f56-9c21-0ab5d6e7f890"

function preview(overrides: Partial<LivraisonPackPreview> = {}): LivraisonPackPreview {
  const base: LivraisonPackPreview = {
    bon_livraison: {
      id: "bl-1",
      numero: "BL-2026-0142",
      statut: "SHIPPED",
      client: { client_id: CLIENT_UUID, company_name: "ABB FRANCE" },
      commande: { id: 42, numero: "CMD-2026-0142" },
      affaire: { id: 7, reference: "AFF-2026-0031" },
      adresse_livraison: {
        id: "adr-1",
        name: "ABB FRANCE",
        street: "ZA LA BOISSE",
        house_number: "12",
        postal_code: "01125",
        city: "MONTLUEL CEDEX",
        country: "France",
        label: "ABB FRANCE\n12 ZA LA BOISSE\n01125 MONTLUEL CEDEX\nFrance",
      },
      date_creation: "2026-07-20",
      date_expedition: "2026-07-22",
      date_livraison: null,
      transporteur: "GEODIS",
      tracking_number: "GD-4471-8823-01",
      commentaire_interne: "Palette filmee, ne pas gerber.",
      commentaire_client: "Livraison sur rendez-vous aupres du magasin. Bons a referencer avec le numero de commande.",
      reception_nom_signataire: null,
      reception_date_signature: null,
      row_version: 3,
      ...STAMPS,
    },
    lignes: [
      ligne(1, { allocations: [allocation("LOT-2026-0001"), allocation("LOT-2026-0002")] }),
      ligne(2, { designation: "Bague de guidage bronze — tournage et rectification", allocations: [allocation("LOT-2026-0003")] }),
    ],
    stock_movements: [
      {
        id: "mv-1",
        movement_no: "MV-2026-0771",
        movement_type: "OUT",
        status: "POSTED",
        effective_at: "2026-07-22T09:00:00.000Z",
        posted_at: "2026-07-22T09:05:00.000Z",
      },
    ],
    documents_attached: [],
    documents_generated: [],
    pack_versions: [],
    checks: { allocations_ok: true, shipped_or_ready: true, stock_link_ok: true, missing: [] },
  }

  return { ...base, ...overrides }
}

describe("bon de livraison PDF — rendu reel", () => {
  it("scenario 1 (BL expedie, 2 lignes) : une page, pagination complete", async () => {
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    keep("50-bl-expedie", bytes)

    expect(bytes.byteLength).toBeGreaterThan(1000)
    expect(countPages(bytes)).toBe(1)

    const text = drawnText(bytes)
    expect(text).toContain("BL-2026-0142")
    expect(text).toContain("Page 1 / 1")
  }, 60_000)

  it("n'imprime jamais l'identifiant technique du client", async () => {
    // Regression : l'ancienne version ecrivait `ID: <uuid>` sous la raison sociale, sur un
    // document envoye au client.
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    const text = drawnText(bytes)
    expect(text).not.toContain(CLIENT_UUID)
    expect(text).not.toContain(CLIENT_UUID.slice(0, 8))
    expect(text).toContain("ABB FRANCE")
  }, 60_000)

  it("conserve les donnees metier de l'ancienne version : delai client et lots", async () => {
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    const text = drawnText(bytes)
    expect(text).toContain("12/10/2026")
    expect(text).toContain("LOT-2026-0001")
    expect(text).toContain("LOT-2026-0003")
    expect(text).toContain("GD-4471-8823-01")
  }, 60_000)

  it("imprime le commentaire destine au client, que l'ancienne version perdait", async () => {
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    expect(drawnText(bytes)).toContain("Livraison sur rendez-vous")
  }, 60_000)

  it("n'expose pas le commentaire interne", async () => {
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    expect(drawnText(bytes)).not.toContain("ne pas gerber")
  }, 60_000)

  it("scenario 2 (BL non expedie, sans adresse ni transporteur) : reste lisible", async () => {
    const p = preview()
    const bytes = await svcRenderPackBonLivraisonPdf({
      preview: {
        ...p,
        bon_livraison: {
          ...p.bon_livraison,
          numero: "BL-2026-0200",
          statut: "READY",
          date_expedition: null,
          transporteur: null,
          tracking_number: null,
          adresse_livraison: null,
          commentaire_client: null,
        },
        lignes: [ligne(1, { code_piece: null, unite: null, delai_client: null })],
      },
      version: 2,
    })
    keep("51-bl-a-expedier", bytes)

    expect(countPages(bytes)).toBe(1)
    const text = drawnText(bytes)
    expect(text).toContain("Version 2")
    // Une donnee absente est nommee, jamais laissee vide.
    expect(text).toMatch(/Non renseign/)
  }, 60_000)

  it("scenario 3 (40 lignes) : pagine, reemet l'en-tete de table et garde le cadre entier", async () => {
    const p = preview()
    const bytes = await svcRenderPackBonLivraisonPdf({
      preview: {
        ...p,
        lignes: Array.from({ length: 40 }, (_, index) => ligne(index + 1, { allocations: [allocation(`LOT-${index + 1}`)] })),
      },
      version: 3,
    })
    keep("52-bl-volume", bytes)

    const pages = drawnPages(bytes)
    expect(countPages(bytes)).toBe(pages.length)
    expect(pages.length).toBeGreaterThan(1)

    // Toute page portant des lignes reemet l'en-tete de colonnes : une page detachee reste
    // lisible seule. Une page sans ligne (ici la derniere, qui ne porte que la reception)
    // n'a evidemment pas a en porter.
    for (const page of pages) {
      if (/PT-45\d\d-A/.test(page)) expect(page).toContain("CODE PIÈCE")
    }
    expect(pages.filter((page) => page.includes("CODE PIÈCE")).length).toBeGreaterThan(1)

    // Chaque page se nomme et se situe.
    pages.forEach((page, index) => {
      expect(page).toContain(`Page ${index + 1} / ${pages.length}`)
      if (index > 0) expect(page).toContain("BL-2026-0142")
    })

    // Le cadre de reception n'est jamais coupe entre deux pages.
    const receptionPages = pages.filter((page) => page.includes("RÉCEPTION"))
    expect(receptionPages).toHaveLength(1)
    for (const label of ["Nom et qualité", "Date", "Signature"]) {
      expect(receptionPages[0]).toContain(label)
    }
  }, 90_000)

  it("la generation simple et le pack fige produisent le meme document", async () => {
    // Les deux chemins (`POST /livraisons/:id/pdf` et le pack) dessinaient chacun leur propre
    // mise en page : le client pouvait recevoir deux bons d'aspect different pour la meme
    // expedition. Ils partagent desormais un rendu unique — a donnee egale, binaire egal.
    const p = preview()
    const viaPack = await svcRenderPackBonLivraisonPdf({ preview: p, version: 1 })
    const viaSimple = await renderBonLivraisonDocument({
      header: p.bon_livraison,
      lignes: p.lignes,
      version: 1,
      company: "CROIX ROUSSE PRECISION",
      issuer: ISSUER,
    })
    expect(viaSimple.equals(viaPack)).toBe(true)
  }, 60_000)

  it("porte l'identite legale et les mentions obligatoires de l'emetteur", async () => {
    // Un bon de livraison est un document commercial : il doit porter l'identite legale de
    // son emetteur au meme titre qu'une facture. Il ne portait qu'une raison sociale.
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    keep("57-bl-mentions-legales", bytes)

    const text = drawnText(bytes)
    expect(text).toContain("SARL au capital de 21 000,00 €")
    expect(text).toContain("RCS Bourg-en-Bresse 380 569 012")
    expect(text).toContain("SIRET 380 569 012 00020")
    expect(text).toContain("TVA FR73 380 569 012")
    expect(text).toContain("Pénalités de retard : 12,5 % l'an")
    expect(text).toContain("40,00 € par facture")
    expect(text).toContain("Escompte pour paiement anticipé : 1,5 % par mois")
    // La reserve de propriete a sa portee la plus forte au moment de la livraison.
    expect(text).toContain("Nous nous réservons la propriété des marchandises")
  }, 60_000)

  it("les mentions ne coutent aucune page et ne repoussent pas le cadre de réception", async () => {
    // Les mentions vivent dans la bande de pied, pas dans le flux : placees a la suite du
    // contenu, elles poussaient ce bon de deux lignes sur une seconde page qui ne portait
    // qu'elles. Le cadre de reception reste entier sur la premiere page.
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    expect(countPages(bytes)).toBe(1)

    const pages = drawnPages(bytes)
    expect(pages).toHaveLength(1)
    expect(pages[0]).toContain("RÉCEPTION")
    expect(pages[0]).toContain("Pénalités de retard")
  }, 60_000)

  it("répète l'identité légale et les mentions sur chaque page", async () => {
    // Une page detachee doit rester rattachable a son emetteur et rester opposable : la
    // mention obligatoire figure donc sur toutes les pages, pas seulement la derniere.
    const p = preview()
    const bytes = await svcRenderPackBonLivraisonPdf({
      preview: {
        ...p,
        lignes: Array.from({ length: 40 }, (_, index) => ({
          ...p.lignes[0]!,
          ordre: index + 1,
          designation: `Composant usiné référence ${index + 1} — plan 46${index}-A indice B`,
        })),
      },
      version: 1,
    })

    const pages = drawnPages(bytes)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(page).toContain("SIRET 380 569 012 00020")
      expect(page).toContain("Pénalités de retard")
    }
  }, 90_000)

  it("scenario 4 (aucune ligne) : le document le dit au lieu d'afficher une table vide", async () => {
    const p = preview()
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: { ...p, lignes: [] }, version: 4 })
    keep("53-bl-sans-ligne", bytes)

    expect(countPages(bytes)).toBe(1)
    expect(drawnText(bytes)).toContain("Aucune ligne sur ce bon de livraison")
  }, 60_000)

  it("les accents francais survivent a l'encodage WinAnsi", async () => {
    // L'ancienne version ecrivait « Numero », « Designation », « Reception ». WinAnsi couvre
    // les accents francais : les supprimer etait une precaution inutile.
    const bytes = await svcRenderPackBonLivraisonPdf({ preview: preview(), version: 1 })
    const text = drawnText(bytes)
    expect(text).toContain("DÉSIGNATION")
    expect(text).toContain("DÉLAI CLIENT")
    expect(text).toContain("Expédié")
    expect(text).toContain("RÉCEPTION")
    expect(text).toContain("Généré le")
    // Le tiret cadratin sert de valeur vide dans la table : s'il disparaissait, une cellule
    // non renseignee deviendrait indistinguable d'une cellule oubliee.
    expect(text).toContain("316L — usinage complet")
  }, 60_000)
})

describe("certificat de conformite PDF — rendu reel", () => {
  const COFC = {
    version: 1,
    signataireLabel: "Keenan MARTIN — Responsable qualite",
    commentairePack: null as string | null,
    includeDocuments: false,
  }

  it("scenario 5 (certificat nominal) : une page, tracabilite portee", async () => {
    const bytes = await svcRenderPackCofcPdf({ preview: preview(), ...COFC })
    keep("54-cofc-nominal", bytes)

    expect(countPages(bytes)).toBe(1)
    const text = drawnText(bytes)
    expect(text).toContain("BL-2026-0142")
    expect(text).toContain("MV-2026-0771")
    expect(text).toContain("LOT-2026-0001")
    expect(text).toContain("Page 1 / 1")

    // Le vocabulaire interne des mouvements est traduit : un client ne lit pas `OUT`/`POSTED`.
    expect(text).toContain("Sortie")
    expect(text).toContain("Comptabilisé")
    expect(text).not.toMatch(/\bPOSTED\b/)
  }, 60_000)

  it("laisse un code de mouvement inconnu tel quel plutot que d'inventer un libelle", async () => {
    const p = preview()
    const bytes = await svcRenderPackCofcPdf({
      preview: {
        ...p,
        stock_movements: [{ ...p.stock_movements[0], movement_type: "FUTUR_TYPE" as never }],
      },
      ...COFC,
    })
    expect(drawnText(bytes)).toContain("FUTUR_TYPE")
  }, 60_000)

  it("n'imprime jamais l'identifiant technique du client", async () => {
    const bytes = await svcRenderPackCofcPdf({ preview: preview(), ...COFC })
    expect(drawnText(bytes)).not.toContain(CLIENT_UUID)
  }, 60_000)

  it("scenario 6 (commentaire + documents joints) : les deux blocs apparaissent", async () => {
    const p = preview({
      documents_attached: [
        {
          bon_livraison_document_id: "d-1",
          document_id: "doc-1",
          document_name: "Rapport de controle dimensionnel.pdf",
        },
      ] as unknown as LivraisonPackPreview["documents_attached"],
    })
    const bytes = await svcRenderPackCofcPdf({
      preview: p,
      ...COFC,
      version: 2,
      commentairePack: "Controle dimensionnel realise sur 100 % du lot, rapport joint.",
      includeDocuments: true,
    })
    keep("55-cofc-documents", bytes)

    const text = drawnText(bytes)
    expect(text).toContain("Rapport de controle dimensionnel.pdf")
    expect(text).toContain("100 %")
  }, 60_000)

  it("scenario 7 (sans mouvement de stock) : la section disparait au lieu de mentir", async () => {
    const bytes = await svcRenderPackCofcPdf({ preview: preview({ stock_movements: [] }), ...COFC, version: 3 })
    keep("56-cofc-sans-mouvement", bytes)

    const text = drawnText(bytes)
    expect(text).not.toContain("MOUVEMENTS")
    expect(text).toContain("Conforme")
  }, 60_000)
})
