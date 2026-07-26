import PDFDocument from "pdfkit"

import type { AsBuiltPreview } from "../types/asbuilt.types"

function formatDateFR(iso: string | null | undefined): string {
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

function n(value: number | null | undefined, unit?: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-"
  const formatted = Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
  return unit ? `${formatted} ${unit}` : formatted
}

async function renderPdfToBuffer(args: { creationDate: Date; render: (doc: PDFKit.PDFDocument) => void }): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margin: 40, info: { CreationDate: args.creationDate } })
  const chunks: Buffer[] = []
  doc.on("data", (c) => chunks.push(c as Buffer))
  args.render(doc)
  doc.end()

  await new Promise<void>((resolve, reject) => {
    doc.on("end", () => resolve())
    doc.on("error", (err) => reject(err))
  })

  return Buffer.concat(chunks)
}

function drawKeyValue(doc: PDFKit.PDFDocument, key: string, value: string) {
  doc.font("Helvetica-Bold").text(key, { continued: true })
  doc.font("Helvetica").text(` ${value}`)
}

function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.7)
  doc.fontSize(12).font("Helvetica-Bold").text(title)
  doc.fontSize(10).font("Helvetica")
}

/**
 * Rendu du dossier as-built (#142).
 *
 * Le PDF porte désormais tout ce qu'exige un dossier de conformité opposable :
 * version, date de génération, date de référence (`as_of`), périmètre, auteur
 * autorisé, empreintes des preuves, ET la liste explicite de ce qui manque.
 * L'empreinte du PDF lui-même n'est pas imprimée dans le PDF (elle est
 * calculée sur le fichier fini et conservée en base) : un document ne peut pas
 * contenir son propre hachage.
 */
export async function svcRenderAsbuiltPdf(args: {
  preview: AsBuiltPreview
  version: number
  generatedAt: Date
  signataireLabel: string
  commentaire: string | null
}): Promise<Buffer> {
  const p = args.preview
  const e = p.enrichment

  return renderPdfToBuffer({
    creationDate: args.generatedAt,
    render: (doc) => {
      doc.fontSize(18).font("Helvetica-Bold").text("Dossier de lot (as-built)")
      doc.moveDown(0.6)

      doc.fontSize(10).font("Helvetica")
      drawKeyValue(doc, "Lot :", p.lot.lot_code)
      drawKeyValue(doc, "Article :", `${p.lot.article_code} - ${p.lot.article_designation}`)
      if (p.lot.supplier_lot_code) drawKeyValue(doc, "Lot fournisseur :", p.lot.supplier_lot_code)
      drawKeyValue(doc, "Statut qualite du lot :", e?.lot_status.current ?? "-")
      drawKeyValue(doc, "Version du dossier :", String(args.version))
      drawKeyValue(doc, "Genere le :", formatDateFR(args.generatedAt.toISOString()))
      drawKeyValue(doc, "Date de reference (as of) :", args.generatedAt.toISOString())
      drawKeyValue(doc, "Auteur autorise :", args.signataireLabel)
      drawKeyValue(
        doc,
        "Perimetre :",
        `${p.ofs.length} OF, ${p.bon_livraisons.length} BL, ${e?.controls.length ?? 0} controle(s)`
      )
      if (p.personal_data_masked) {
        drawKeyValue(doc, "Donnees personnelles :", "operateurs pseudonymises (RGPD)")
      }
      if (args.commentaire && args.commentaire.trim()) {
        drawKeyValue(doc, "Commentaire :", args.commentaire.trim())
      }

      /* Avertissements en TÊTE : un dossier qui tait ses lacunes est un faux. */
      const warnings = p.coverage_warnings ?? []
      if (warnings.length) {
        section(doc, "Avertissements de couverture")
        for (const w of warnings) {
          doc.fillColor(w.level === "danger" ? "#b91c1c" : "#92400e")
          doc.text(`- [${w.level.toUpperCase()}] ${w.message}`)
        }
        doc.fillColor("#111111")
      } else {
        section(doc, "Avertissements de couverture")
        doc.text("- Aucune lacune detectee sur le perimetre analyse.")
      }

      section(doc, "Synthese")
      doc.text(`OF lie(s): ${p.ofs.length}`)
      doc.text(`Lots matiere consommes: ${e?.consumed_lots.length ?? 0}`)
      doc.text(`Operations: ${e?.operations.length ?? 0}`)
      doc.text(`Receptions de production: ${e?.production_receipts.length ?? 0}`)
      doc.text(`Mouvements de stock: ${e?.stock_movements.length ?? 0}`)
      doc.text(`Controles: ${e?.controls.length ?? 0} / mesures: ${e?.measurements.length ?? 0}`)
      doc.text(`Allocations de livraison: ${e?.allocations.length ?? 0}`)
      doc.text(
        `Non-conformites: ${p.non_conformities.length} (ouvertes: ${p.checks.open_non_conformities}, en retard: ${p.checks.overdue_non_conformities})`
      )

      if (e?.technical_versions.length) {
        section(doc, "Definition technique figee")
        for (const v of e.technical_versions.slice(0, 30)) {
          doc.text(
            `- OF ${v.of_numero} : indice ${v.indice ?? "-"}, plan ${v.plan_reference ?? "-"}, ` +
              `empreinte ${v.snapshot_sha256 ? v.snapshot_sha256.slice(0, 16) + "..." : "MANQUANTE"}`
          )
        }
      }

      if (e?.consumed_lots.length) {
        section(doc, "Lots matiere reellement consommes")
        for (const c of e.consumed_lots.slice(0, 60)) {
          doc.text(
            `- ${c.article_code} lot ${c.lot_code}` +
              (c.supplier_lot_code ? ` (fournisseur ${c.supplier_lot_code})` : "") +
              ` : ${n(c.qty, c.unit)} sur OF ${c.of_numero} le ${formatDateFR(c.effective_at)}` +
              (c.status === "COMPENSATED" ? " [COMPENSE]" : "")
          )
        }
      }

      if (p.ofs.length) {
        section(doc, "Ordres de fabrication")
        for (const of of p.ofs.slice(0, 30)) {
          doc.text(`- OF ${of.numero} (${of.statut}) - Piece: ${of.piece_code}`)
        }
      }

      if (e?.operations.length) {
        section(doc, "Operations et machines")
        for (const op of e.operations.slice(0, 60)) {
          const machine = op.machine_code ? `${op.machine_code}` : "-"
          const operators = op.operators.length ? op.operators.join(", ") : "-"
          doc.text(
            `- OF ${op.of_numero} PH${String(op.phase ?? 0).padStart(2, "0")} ${op.designation ?? ""} ` +
              `| machine ${machine} | ${op.clocking_count} pointage(s) | ${operators} | ` +
              `realise ${n(op.real_minutes)} min (prevu ${n(op.planned_minutes)})`
          )
        }
      }

      if (e?.production_receipts.length) {
        section(doc, "Receptions de production")
        for (const r of e.production_receipts.slice(0, 30)) {
          doc.text(
            `- OF ${r.of_numero} le ${formatDateFR(r.created_at)} : ` +
              `OK ${n(r.qty_ok)}, rebut ${n(r.qty_scrap)}, retouche ${n(r.qty_rework)} [${r.quality_status ?? "-"}]`
          )
        }
      }

      if (e?.stock_movements.length) {
        section(doc, "Mouvements de stock")
        for (const m of e.stock_movements.slice(0, 50)) {
          doc.text(
            `- ${m.movement_type} ${m.movement_no ?? m.movement_id.slice(0, 8)} (${m.status}) ` +
              `${n(m.qty, m.unit)} le ${formatDateFR(m.effective_at)}` +
              (m.reversal_of_id ? " [COMPENSATION]" : "")
          )
        }
      }

      if (e?.controls.length) {
        section(doc, "Controles qualite")
        for (const c of e.controls.slice(0, 40)) {
          doc.text(
            `- ${c.reference ?? c.control_id.slice(0, 8)} (${c.control_type ?? "-"}) le ${formatDateFR(c.control_date)} : ` +
              `verdict ${c.verdict ?? c.verdict_computed ?? "-"} | ` +
              `controle ${n(c.qty_controlled, c.unit)}, conforme ${n(c.qty_conforming, c.unit)} | ` +
              `plan v${c.plan_version ?? "-"} empreinte ${c.plan_snapshot_sha256 ? c.plan_snapshot_sha256.slice(0, 16) + "..." : "MANQUANTE"}`
          )
        }
      }

      if (e?.measurements.length) {
        section(doc, "Mesures, instruments et certificats")
        for (const m of e.measurements.slice(0, 80)) {
          const tol =
            m.tolerance_min !== null || m.tolerance_max !== null
              ? ` [${n(m.tolerance_min)} ; ${n(m.tolerance_max)}]`
              : ""
          const instrument = m.instrument_code
            ? `${m.instrument_code}`
            : "SANS INSTRUMENT DECLARE"
          const cert =
            m.instrument_id === null
              ? ""
              : m.certificate_valid_at_measure
                ? ` | certificat ${m.certificate_number ?? m.certificate_id?.slice(0, 8) ?? "-"} valide`
                : " | AUCUN CERTIFICAT CONFORME VALIDE A LA DATE"
          doc.text(
            `- ${m.characteristic} : ${n(m.measured_value, m.unit)}${tol} -> ${m.result ?? "-"} | ` +
              `${instrument}${cert} | ${formatDateFR(m.measured_at)}`
          )
        }
      }

      if (e?.release_decisions.length) {
        section(doc, "Decisions de liberation")
        for (const d of e.release_decisions.slice(0, 30)) {
          doc.text(
            `- ${d.decision ?? "-"} (${d.verdict ?? "-"}) ${n(d.qty, d.unit)} le ${formatDateFR(d.decided_at)}` +
              (d.derogation_code ? ` | derogation ${d.derogation_code}` : "")
          )
        }
      }

      if (e?.derogations.length) {
        section(doc, "Derogations")
        for (const d of e.derogations.slice(0, 30)) {
          doc.text(
            `- ${d.code} (${d.status}${d.derogation_type ? `, ${d.derogation_type}` : ""}) : ` +
              `${n(d.consumed_qty, d.unit)} / ${n(d.max_qty, d.unit)}` +
              (d.valid_to ? `, valide jusqu'au ${formatDateFR(d.valid_to)}` : "")
          )
        }
      }

      if (p.non_conformities.length) {
        section(doc, "Non-conformites")
        for (const nc of p.non_conformities.slice(0, 50)) {
          const due = nc.due_date ? `, echeance: ${formatDateFR(nc.due_date)}` : ""
          doc.text(`- NC ${nc.reference} (${nc.status}, ${nc.severity})${due}`)
        }
      }

      if (e?.allocations.length) {
        section(doc, "Allocations de livraison")
        for (const a of e.allocations.slice(0, 50)) {
          doc.text(
            `- BL ${a.bon_livraison_numero} : ${n(a.qty, a.unit)} (${a.designation ?? "-"})` +
              (a.stock_movement_line_id ? "" : " [SANS MOUVEMENT DE SORTIE]")
          )
        }
      }

      if (p.bon_livraisons.length) {
        section(doc, "Bons de livraison")
        for (const bl of p.bon_livraisons.slice(0, 30)) {
          const sig = bl.reception_date_signature
            ? `, reception signee: ${formatDateFR(bl.reception_date_signature)}`
            : ""
          doc.text(`- BL ${bl.numero} (${bl.statut})${sig}`)
        }
      }

      if (e?.delivery_proofs.length) {
        section(doc, "Preuves de livraison")
        for (const pr of e.delivery_proofs.slice(0, 30)) {
          doc.text(
            `- BL ${pr.bon_livraison_numero} : ${pr.proof_type ?? "-"} le ${formatDateFR(pr.delivered_at)}` +
              (pr.received_by_name ? ` (recu par ${pr.received_by_name})` : "")
          )
        }
      }

      if (p.pack_versions.length) {
        section(doc, "Versions precedentes du dossier")
        for (const v of p.pack_versions.slice(0, 20)) {
          doc.text(
            `- v${v.version} (${v.status}) generee le ${formatDateFR(v.generated_at)} par ${v.generated_by?.label ?? "-"}`
          )
        }
      }

      doc.moveDown(1)
      doc
        .fontSize(8)
        .fillColor("#6b7280")
        .text(
          "Document genere automatiquement par CERP. Les elements marques MANQUANTE ou SANS ... signalent une lacune de donnees reelle, non une erreur de generation. L'empreinte SHA-256 de ce fichier est conservee en base et permet d'en verifier l'integrite."
        )
      doc.fillColor("#111111")
    },
  })
}
