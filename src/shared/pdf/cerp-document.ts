import PDFDocument from "pdfkit"

import { CERP_LOGO_PNG, CERP_LOGO_RATIO } from "./cerp-logo"

/**
 * Socle des documents PDF sortants CERP, cote serveur.
 *
 * Porte en pdfkit la grammaire arretee par ADR-0039 et ADR-0040 pour les documents rendus dans
 * le navigateur (fiche client, fiche fournisseur, devis, commande, bon de commande). Le rendu
 * navigateur repose sur React ; pdfkit dessine imperativement : le code ne peut pas etre
 * partage, la **grammaire** l'est — geometrie, palette, en-tete, bandeau, sections, table,
 * pied de page pagine.
 *
 * Un module metier n'apporte que ses sections.
 */

/** Palette : identique a `crpDocumentPdfTokens` cote frontend. */
export const CERP_DOC_COLORS = {
  /** Rouge officiel preleve sur le logo, unique accent du document. */
  brand: "#B90101",
  ink: "#101418",
  graphite: "#3D444C",
  steel: "#6E7681",
  hairline: "#D5DAE0",
  hairlineSoft: "#E7EAEE",
  wash: "#F5F6F8",
  paper: "#FFFFFF",
} as const

const MARGIN_X = 38
const MARGIN_TOP = 34
/** Bande reservee au pied de page fixe. */
const MARGIN_BOTTOM = 54

const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
export const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2

const BODY_SIZE = 9.5
const LOGO_WIDTH = 148

/**
 * Caracteres absents de WinAnsi, seul encodage des polices standard PDF.
 *
 * pdfkit les remplace silencieusement ou leve : dans les deux cas la donnee est perdue. Un
 * signe moins typographique dans un montant, un signe de diametre dans une cotation.
 */
const WINANSI_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[−‒–‑‐]/g, "-"],
  [/⌀/g, "Ø"],
  [/≤/g, "<="],
  [/≥/g, ">="],
  [/≠/g, "!="],
  [/≈/g, "~"],
  [/[→⟶]/g, "->"],
  [/[←⟵]/g, "<-"],
  [/✓/g, "OK"],
  [/✗/g, "X"],
  [/[  ]/g, " "],
  [/​/g, ""],
  [/‌/g, ""],
  [/‍/g, ""],
  [/﻿/g, ""],
]

/** Rend une chaine sure pour les polices standard du PDF. */
export function toPdfSafeText(value: string): string {
  let out = value
  for (const [pattern, replacement] of WINANSI_SUBSTITUTIONS) out = out.replace(pattern, replacement)
  return out
}

/** Monogramme de repli : 1 a 2 lettres, jamais vide. */
export function monogramFromName(name: string | null | undefined): string {
  const cleaned = typeof name === "string" ? name.trim() : ""
  if (!cleaned) return "CL"

  const noise = new Set(["sa", "sas", "sasu", "sarl", "eurl", "sci", "snc", "gmbh", "ltd", "inc", "spa", "srl", "bv", "nv"])
  const words = cleaned
    .split(/[\s\-_/&.]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !noise.has(word.toLowerCase()))

  const source = words.length ? words : [cleaned]
  if (source.length === 1) {
    const letters = [...source[0]].filter((char) => /[\p{L}\p{N}]/u.test(char))
    return letters.length ? letters.slice(0, 2).join("").toUpperCase() : "CL"
  }

  const first = [...source[0]].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? ""
  const second = [...source[1]].find((char) => /[\p{L}\p{N}]/u.test(char)) ?? ""
  return `${first}${second}`.toUpperCase() || "CL"
}

export type CerpDocumentHeader = {
  /** Type de document, en capitales dans l'en-tete et le rappel d'identite. */
  documentType: string
  /** Titre principal : raison sociale pour une fiche, numero pour un document transactionnel. */
  name: string
  /** Code, indice ou version. `null` affiche « Non attribue ». */
  code: string | null
  /** Complement d'identite sous la ligne de code. */
  subtitle?: string | null
  status: string
  /** Etat exceptionnel mis en evidence en rouge plein. */
  flag?: string | null
  /** Nom servant au monogramme, si different du titre. */
  monogramName?: string | null
  generatedAt: string
  generatedBy?: string | null
  /** Metadonnees PDF. */
  title: string
  subject: string
  creationDate: Date
}

export type CerpLineColumn = {
  key: string
  label: string
  /** Part de largeur, comme un `flex`. */
  flex: number
  align?: "left" | "right"
}

export type CerpLineRow = {
  cells: Record<string, string>
  /** Ligne secondaire discrete sous la premiere colonne de texte. */
  meta?: string | null
  /** Colonne portant `meta` ; par defaut la premiere colonne alignee a gauche apres la 1re. */
  metaColumn?: string
}

export type CerpAddressCard = {
  caption: string
  lines: string[] | null
  accent?: boolean
  emptyLabel?: string
}

/**
 * Contexte de rendu passe au module metier. Le curseur vertical est tenu par le socle : un
 * appelant n'a pas a savoir ou commence la page ni quand elle deborde.
 */
export class CerpDocumentContext {
  readonly doc: PDFKit.PDFDocument
  private cursor: number

  constructor(doc: PDFKit.PDFDocument, startY: number) {
    this.doc = doc
    this.cursor = startY
  }

  get y(): number {
    return this.cursor
  }

  set y(value: number) {
    this.cursor = value
  }

  private get bottomLimit(): number {
    return PAGE_HEIGHT - MARGIN_BOTTOM
  }

  /** Ouvre une page si `height` ne tient pas dans ce qui reste. */
  ensureSpace(height: number): void {
    if (this.cursor + height <= this.bottomLimit) return
    this.doc.addPage()
    this.cursor = MARGIN_TOP
  }

  text(value: string, x: number, y: number, options: PDFKit.Mixins.TextOptions = {}): void {
    this.doc.text(toPdfSafeText(value), x, y, { lineBreak: false, ...options })
  }

  private rule(y: number, color: string, width = 0.8): void {
    this.doc.save()
    this.doc.lineWidth(width).strokeColor(color)
    this.doc.moveTo(MARGIN_X, y).lineTo(MARGIN_X + CONTENT_WIDTH, y).stroke()
    this.doc.restore()
  }

  /** Bandeau d'identifiants : ce qu'un lecteur cherche en premier. */
  legalStrip(cells: Array<{ label: string; value: string | null }>, options: { compact?: boolean } = {}): void {
    if (!cells.length) return
    const paddingV = 9
    const paddingH = 12
    const cellWidth = (CONTENT_WIDTH - paddingH * 2) / cells.length

    const valueHeights = cells.map((cell) =>
      this.doc.fontSize(BODY_SIZE).font("Helvetica-Bold").heightOfString(toPdfSafeText(cell.value ?? "Non renseigné"), {
        width: cellWidth - 12,
      })
    )
    const height = paddingV * 2 + 9 + Math.max(...valueHeights)

    if (!options.compact) this.cursor += 16
    this.ensureSpace(height)

    this.doc.save()
    this.doc.rect(MARGIN_X, this.cursor, CONTENT_WIDTH, height).fill(CERP_DOC_COLORS.wash)
    this.doc.restore()
    this.rule(this.cursor, CERP_DOC_COLORS.hairline)
    this.rule(this.cursor + height, CERP_DOC_COLORS.hairline)

    cells.forEach((cell, index) => {
      const x = MARGIN_X + paddingH + cellWidth * index
      if (index > 0) {
        this.doc.save()
        this.doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
        this.doc.moveTo(x - 6, this.cursor + 6).lineTo(x - 6, this.cursor + height - 6).stroke()
        this.doc.restore()
      }

      this.doc.font("Helvetica").fontSize(6.9).fillColor(CERP_DOC_COLORS.steel)
      this.text(cell.label.toUpperCase(), x, this.cursor + paddingV, { width: cellWidth - 12, characterSpacing: 0.75 })

      const filled = Boolean(cell.value && cell.value.trim())
      this.doc
        .font(filled ? "Helvetica-Bold" : "Helvetica")
        .fontSize(BODY_SIZE)
        .fillColor(filled ? CERP_DOC_COLORS.ink : CERP_DOC_COLORS.steel)
      this.doc.text(toPdfSafeText(filled ? (cell.value as string) : "Non renseigné"), x, this.cursor + paddingV + 11, {
        width: cellWidth - 12,
      })
    })

    this.cursor += height
    this.doc.fillColor(CERP_DOC_COLORS.ink)
  }

  /** Titre de section : capitales espacees suivies d'un filet. */
  section(title: string, options: { cohesion?: number } = {}): void {
    const cohesion = options.cohesion ?? 52
    this.cursor += 17
    this.ensureSpace(20 + cohesion)

    this.doc.font("Helvetica-Bold").fontSize(8.5).fillColor(CERP_DOC_COLORS.ink)
    const label = toPdfSafeText(title.toUpperCase())
    const width = this.doc.widthOfString(label, { characterSpacing: 1.3 })
    this.doc.text(label, MARGIN_X, this.cursor, { lineBreak: false, characterSpacing: 1.3 })

    this.doc.save()
    this.doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
    this.doc
      .moveTo(MARGIN_X + width + 10, this.cursor + 5)
      .lineTo(MARGIN_X + CONTENT_WIDTH, this.cursor + 5)
      .stroke()
    this.doc.restore()

    this.cursor += 20
  }

  /** Cartes d'adresse : la premiere est mise en avant par un filet rouge, les autres en contour. */
  addressCards(cards: CerpAddressCard[]): void {
    if (!cards.length) return
    const gap = 14
    const cardWidth = (CONTENT_WIDTH - gap * (cards.length - 1)) / cards.length
    const inner = cardWidth - 22

    const heights = cards.map((card) => {
      const lines = card.lines?.length ? card.lines : [card.emptyLabel ?? "Non renseignée"]
      return lines.reduce((sum, line, index) => {
        this.doc.font(index === 0 && card.lines?.length ? "Helvetica-Bold" : "Helvetica").fontSize(BODY_SIZE)
        return sum + this.doc.heightOfString(toPdfSafeText(line), { width: inner })
      }, 0)
    })
    const height = Math.max(78, 11 + 5 + 11 + Math.max(...heights) + 11)

    this.ensureSpace(height)
    const top = this.cursor

    cards.forEach((card, index) => {
      const x = MARGIN_X + (cardWidth + gap) * index
      const accent = card.accent ?? index === 0

      this.doc.save()
      if (accent) {
        this.doc.rect(x, top, cardWidth, height).fill(CERP_DOC_COLORS.wash)
        this.doc.rect(x, top, 1.6, height).fill(CERP_DOC_COLORS.brand)
      } else {
        this.doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
        this.doc.rect(x, top, cardWidth, height).stroke()
      }
      this.doc.restore()

      this.doc
        .font("Helvetica-Bold")
        .fontSize(6.9)
        .fillColor(accent ? CERP_DOC_COLORS.brand : CERP_DOC_COLORS.steel)
      this.text(card.caption.toUpperCase(), x + 11, top + 11, { width: inner, characterSpacing: 0.9 })

      let lineY = top + 11 + 16
      const lines = card.lines?.length ? card.lines : [card.emptyLabel ?? "Non renseignée"]
      lines.forEach((line, lineIndex) => {
        const isFirst = lineIndex === 0 && Boolean(card.lines?.length)
        this.doc
          .font(isFirst ? "Helvetica-Bold" : "Helvetica")
          .fontSize(BODY_SIZE)
          .fillColor(card.lines?.length ? CERP_DOC_COLORS.ink : CERP_DOC_COLORS.steel)
        this.doc.text(toPdfSafeText(line), x + 11, lineY, { width: inner })
        lineY = this.doc.y
      })
    })

    this.cursor = top + height
    this.doc.fillColor(CERP_DOC_COLORS.ink)
  }

  /**
   * Table de lignes. L'en-tete de colonnes est reemis sur chaque page traversee, et une ligne
   * n'est jamais coupee en deux.
   */
  linesTable(args: { columns: CerpLineColumn[]; rows: CerpLineRow[]; emptyLabel: string }): void {
    const { columns, rows, emptyLabel } = args

    if (!rows.length) {
      this.ensureSpace(16)
      this.doc.font("Helvetica").fontSize(BODY_SIZE).fillColor(CERP_DOC_COLORS.steel)
      this.doc.text(toPdfSafeText(emptyLabel), MARGIN_X, this.cursor, { width: CONTENT_WIDTH })
      this.cursor = this.doc.y
      this.doc.fillColor(CERP_DOC_COLORS.ink)
      return
    }

    const flexTotal = columns.reduce((sum, column) => sum + column.flex, 0)
    const widthOf = (column: CerpLineColumn) => (CONTENT_WIDTH * column.flex) / flexTotal - 8
    const xOf = (index: number) =>
      MARGIN_X + columns.slice(0, index).reduce((sum, column) => sum + (CONTENT_WIDTH * column.flex) / flexTotal, 0)

    const drawHead = () => {
      this.doc.font("Helvetica").fontSize(6.9).fillColor(CERP_DOC_COLORS.steel)
      columns.forEach((column, index) => {
        this.text(column.label.toUpperCase(), xOf(index), this.cursor, {
          width: widthOf(column),
          align: column.align ?? "left",
          characterSpacing: 0.75,
        })
      })
      this.rule(this.cursor + 11, CERP_DOC_COLORS.ink)
      this.cursor += 16
    }

    this.ensureSpace(46)
    drawHead()

    const metaColumn =
      rows.find((row) => row.metaColumn)?.metaColumn ??
      columns.find((column, index) => index > 0 && (column.align ?? "left") === "left")?.key ??
      columns[0].key

    for (const row of rows) {
      const heights = columns.map((column) => {
        this.doc.font(column.key === metaColumn ? "Helvetica-Bold" : "Helvetica").fontSize(BODY_SIZE)
        return this.doc.heightOfString(toPdfSafeText(row.cells[column.key] ?? ""), { width: widthOf(column) })
      })
      let rowHeight = Math.max(12, ...heights)
      if (row.meta) {
        const metaWidth = widthOf(columns.find((column) => column.key === metaColumn) ?? columns[0])
        this.doc.font("Helvetica").fontSize(7.6)
        rowHeight += 1 + this.doc.heightOfString(toPdfSafeText(row.meta), { width: metaWidth })
      }

      if (this.cursor + rowHeight + 12 > PAGE_HEIGHT - MARGIN_BOTTOM) {
        this.doc.addPage()
        this.cursor = MARGIN_TOP
        drawHead()
      }

      const top = this.cursor + 6
      columns.forEach((column, index) => {
        const isMeta = column.key === metaColumn
        this.doc
          .font(isMeta ? "Helvetica-Bold" : "Helvetica")
          .fontSize(BODY_SIZE)
          .fillColor(row.cells[column.key]?.trim() ? CERP_DOC_COLORS.ink : CERP_DOC_COLORS.steel)
        this.doc.text(toPdfSafeText(row.cells[column.key] ?? "—"), xOf(index), top, {
          width: widthOf(column),
          align: column.align ?? "left",
        })
      })

      let bottom = top + Math.max(12, ...heights)
      if (row.meta) {
        const metaIndex = columns.findIndex((column) => column.key === metaColumn)
        this.doc.font("Helvetica").fontSize(7.6).fillColor(CERP_DOC_COLORS.steel)
        this.doc.text(toPdfSafeText(row.meta), xOf(metaIndex < 0 ? 0 : metaIndex), bottom + 1, {
          width: widthOf(columns[metaIndex < 0 ? 0 : metaIndex]),
        })
        bottom = this.doc.y
      }

      this.cursor = bottom + 6
      this.rule(this.cursor, CERP_DOC_COLORS.hairlineSoft, 0.6)
    }

    this.doc.fillColor(CERP_DOC_COLORS.ink)
  }

  /** Paragraphe sur fond gris, pour un texte long. */
  notes(text: string): void {
    const inner = CONTENT_WIDTH - 26
    this.doc.font("Helvetica").fontSize(9.2)
    const height = this.doc.heightOfString(toPdfSafeText(text), { width: inner }) + 22

    this.ensureSpace(Math.min(height, 120))
    this.doc.save()
    this.doc.rect(MARGIN_X, this.cursor, CONTENT_WIDTH, height).fill(CERP_DOC_COLORS.wash)
    this.doc.restore()

    this.doc.fillColor(CERP_DOC_COLORS.ink)
    this.doc.text(toPdfSafeText(text), MARGIN_X + 13, this.cursor + 11, { width: inner })
    this.cursor += height
  }

  /** Paire libelle / valeur, alignee sur la grille des champs. */
  field(label: string, value: string | null, x: number, width: number): number {
    this.doc.font("Helvetica").fontSize(6.9).fillColor(CERP_DOC_COLORS.steel)
    this.text(label.toUpperCase(), x, this.cursor, { width, characterSpacing: 0.75 })

    const filled = Boolean(value && value.trim())
    this.doc
      .font(filled ? "Helvetica-Bold" : "Helvetica")
      .fontSize(BODY_SIZE)
      .fillColor(filled ? CERP_DOC_COLORS.ink : CERP_DOC_COLORS.steel)
    this.doc.text(toPdfSafeText(filled ? (value as string) : "Non renseigné"), x, this.cursor + 11, { width })
    return this.doc.y
  }

  /** Cadre de reception : nom, signature, date. Reste solidaire, jamais coupe. */
  signatureBox(title: string, fields: string[]): void {
    const height = 26 + fields.length * 26
    this.cursor += 14
    this.ensureSpace(height)

    this.doc.save()
    this.doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
    this.doc.rect(MARGIN_X, this.cursor, CONTENT_WIDTH, height).stroke()
    this.doc.restore()

    this.doc.font("Helvetica-Bold").fontSize(6.9).fillColor(CERP_DOC_COLORS.steel)
    this.text(title.toUpperCase(), MARGIN_X + 11, this.cursor + 10, { width: CONTENT_WIDTH - 22, characterSpacing: 0.9 })

    fields.forEach((label, index) => {
      const y = this.cursor + 30 + index * 26
      this.doc.font("Helvetica").fontSize(BODY_SIZE).fillColor(CERP_DOC_COLORS.graphite)
      this.text(label, MARGIN_X + 11, y, { width: 140 })
      this.doc.save()
      this.doc.lineWidth(0.6).strokeColor(CERP_DOC_COLORS.hairline)
      this.doc
        .moveTo(MARGIN_X + 160, y + 11)
        .lineTo(MARGIN_X + CONTENT_WIDTH - 11, y + 11)
        .stroke()
      this.doc.restore()
    })

    this.cursor += height
    this.doc.fillColor(CERP_DOC_COLORS.ink)
  }
}

function drawMasthead(doc: PDFKit.PDFDocument, header: CerpDocumentHeader): number {
  const logoHeight = LOGO_WIDTH / CERP_LOGO_RATIO
  doc.image(CERP_LOGO_PNG, MARGIN_X, MARGIN_TOP, { width: LOGO_WIDTH })

  doc.font("Helvetica-Bold").fontSize(9.5).fillColor(CERP_DOC_COLORS.brand)
  const type = toPdfSafeText(header.documentType.toUpperCase())
  const typeWidth = doc.widthOfString(type, { characterSpacing: 2.4 })
  doc.text(type, MARGIN_X + CONTENT_WIDTH - typeWidth, MARGIN_TOP + logoHeight - 12, {
    lineBreak: false,
    characterSpacing: 2.4,
  })

  // Filet bicolore : amorce rouge, puis encre. Rappel du reperage du logo.
  const ruleY = MARGIN_TOP + logoHeight + 9
  doc.save()
  doc.rect(MARGIN_X, ruleY, 66, 1.6).fill(CERP_DOC_COLORS.brand)
  doc.rect(MARGIN_X + 66, ruleY, CONTENT_WIDTH - 66, 1.6).fill(CERP_DOC_COLORS.ink)
  doc.restore()

  return ruleY + 1.6 + 15
}

function drawIdentity(doc: PDFKit.PDFDocument, header: CerpDocumentHeader, top: number): number {
  const slotWidth = 92
  const slotHeight = 58
  const mainWidth = CONTENT_WIDTH - slotWidth - 16

  doc.font("Helvetica-Bold").fontSize(20).fillColor(CERP_DOC_COLORS.ink)
  doc.text(toPdfSafeText(header.name), MARGIN_X, top, { width: mainWidth })
  let y = doc.y + 6

  doc.font("Helvetica-Bold").fontSize(10).fillColor(CERP_DOC_COLORS.ink)
  const code = toPdfSafeText(header.code ?? "Code non attribué")
  doc.text(code, MARGIN_X, y, { lineBreak: false, characterSpacing: 0.8 })
  const codeWidth = doc.widthOfString(code, { characterSpacing: 0.8 })

  doc.font("Helvetica").fontSize(10).fillColor(CERP_DOC_COLORS.hairline)
  doc.text("|", MARGIN_X + codeWidth + 7, y, { lineBreak: false })

  doc.font("Helvetica").fontSize(10).fillColor(CERP_DOC_COLORS.graphite)
  const status = toPdfSafeText(header.status)
  doc.text(status, MARGIN_X + codeWidth + 18, y, { lineBreak: false })
  const statusWidth = doc.widthOfString(status)

  if (header.flag && header.flag.trim()) {
    const flag = toPdfSafeText(header.flag.toUpperCase())
    doc.font("Helvetica-Bold").fontSize(7.5)
    const flagWidth = doc.widthOfString(flag, { characterSpacing: 1.1 })
    const flagX = MARGIN_X + codeWidth + 18 + statusWidth + 10
    doc.save()
    doc.rect(flagX, y - 1, flagWidth + 14, 14).fill(CERP_DOC_COLORS.brand)
    doc.restore()
    doc.fillColor(CERP_DOC_COLORS.paper).text(flag, flagX + 7, y + 2.5, { lineBreak: false, characterSpacing: 1.1 })
  }

  y += 16
  if (header.subtitle && header.subtitle.trim()) {
    doc.font("Helvetica").fontSize(9).fillColor(CERP_DOC_COLORS.steel)
    doc.text(toPdfSafeText(header.subtitle), MARGIN_X, y, { width: mainWidth })
    y = doc.y
  }

  // Reserve de logo : toujours dessinee, occupee par un monogramme a defaut d'image. La
  // geometrie de l'en-tete ne depend donc pas de la presence d'un logo tiers.
  const slotX = MARGIN_X + CONTENT_WIDTH - slotWidth
  doc.save()
  doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
  doc.rect(slotX, top, slotWidth, slotHeight).stroke()
  doc.restore()

  const monogram = monogramFromName(header.monogramName ?? header.name)
  doc.font("Helvetica-Bold").fontSize(20).fillColor(CERP_DOC_COLORS.steel)
  const monogramWidth = doc.widthOfString(monogram, { characterSpacing: 1.8 })
  doc.text(monogram, slotX + (slotWidth - monogramWidth) / 2, top + slotHeight / 2 - 9, {
    lineBreak: false,
    characterSpacing: 1.8,
  })

  doc.fillColor(CERP_DOC_COLORS.ink)
  return Math.max(y, top + slotHeight)
}

function drawRunningHead(doc: PDFKit.PDFDocument, header: CerpDocumentHeader): void {
  const headline = header.code ? `${header.name} — ${header.code}` : header.name

  doc.font("Helvetica-Bold").fontSize(7).fillColor(CERP_DOC_COLORS.brand)
  doc.text(toPdfSafeText(header.documentType.toUpperCase()), MARGIN_X, 13, { lineBreak: false, characterSpacing: 1.5 })

  doc.font("Helvetica").fontSize(7.5).fillColor(CERP_DOC_COLORS.steel)
  const right = toPdfSafeText(headline)
  const rightWidth = doc.widthOfString(right)
  doc.text(right, MARGIN_X + CONTENT_WIDTH - rightWidth, 13, { lineBreak: false })

  doc.save()
  doc.lineWidth(0.6).strokeColor(CERP_DOC_COLORS.hairline)
  doc.moveTo(MARGIN_X, 27).lineTo(MARGIN_X + CONTENT_WIDTH, 27).stroke()
  doc.restore()
  doc.fillColor(CERP_DOC_COLORS.ink)
}

function drawFooter(doc: PDFKit.PDFDocument, header: CerpDocumentHeader, pageNumber: number, totalPages: number): void {
  const y = PAGE_HEIGHT - 30

  doc.save()
  doc.lineWidth(0.8).strokeColor(CERP_DOC_COLORS.hairline)
  doc.moveTo(MARGIN_X, y - 6).lineTo(MARGIN_X + CONTENT_WIDTH, y - 6).stroke()
  doc.restore()

  doc.font("Helvetica").fontSize(7).fillColor(CERP_DOC_COLORS.graphite)
  doc.text("CROIX ROUSSE PRECISION", MARGIN_X, y, { lineBreak: false, characterSpacing: 0.7 })

  const author = header.generatedBy && header.generatedBy.trim() ? ` par ${header.generatedBy.trim()}` : ""
  const middle = toPdfSafeText(`Généré le ${header.generatedAt}${author}`)
  doc.fillColor(CERP_DOC_COLORS.steel)
  const middleWidth = doc.widthOfString(middle)
  doc.text(middle, MARGIN_X + (CONTENT_WIDTH - middleWidth) / 2, y, { lineBreak: false })

  doc.font("Helvetica-Bold").fillColor(CERP_DOC_COLORS.graphite)
  const page = `Page ${pageNumber} / ${totalPages}`
  const pageWidth = doc.widthOfString(page)
  doc.text(page, MARGIN_X + CONTENT_WIDTH - pageWidth, y, { lineBreak: false })

  doc.fillColor(CERP_DOC_COLORS.ink)
}

/**
 * Rend un document CERP complet et renvoie son binaire.
 *
 * `bufferPages` est indispensable : « Page X / Y » exige de connaitre le total, donc de
 * repasser sur les pages une fois le contenu ecrit.
 */
export async function renderCerpDocument(
  header: CerpDocumentHeader,
  render: (ctx: CerpDocumentContext) => void
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    bufferPages: true,
    margins: { top: MARGIN_TOP, bottom: MARGIN_BOTTOM, left: MARGIN_X, right: MARGIN_X },
    info: {
      Title: toPdfSafeText(header.title),
      Author: "Croix Rousse Precision",
      Subject: toPdfSafeText(header.subject),
      Creator: "CERP - Croix Rousse Precision",
      Producer: "CERP",
      CreationDate: header.creationDate,
    },
  })

  const chunks: Buffer[] = []
  doc.on("data", (chunk) => chunks.push(chunk as Buffer))

  const afterMasthead = drawMasthead(doc, header)
  const afterIdentity = drawIdentity(doc, header, afterMasthead)

  render(new CerpDocumentContext(doc, afterIdentity))

  const range = doc.bufferedPageRange()
  for (let index = 0; index < range.count; index += 1) {
    doc.switchToPage(range.start + index)
    if (index > 0) drawRunningHead(doc, header)
    drawFooter(doc, header, index + 1, range.count)
  }

  doc.end()
  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve())
    doc.on("error", (err) => reject(err))
  })

  return Buffer.concat(chunks)
}
