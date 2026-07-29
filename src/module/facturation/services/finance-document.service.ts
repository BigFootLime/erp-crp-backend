import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import type {
  FinanceDocumentArtifact,
  FinanceDocumentSnapshot,
} from "../repository/facture-workflow.repository";

import { renderFinanceDocument } from "./finance-document-render";

/**
 * Exemplaire legal immuable de la facture.
 *
 * Le rendu vit dans `finance-document-render.ts`, partage avec l'avoir et avec les brouillons :
 * trois chemins dessinaient auparavant leur propre mise en page, dont deux pour la seule
 * facture. Ce service ne s'occupe plus que de l'ecriture du fichier et de son empreinte.
 *
 * `flag: "wx"` est deliberé : un exemplaire legal ne s'ecrase jamais.
 */
export async function writeImmutableFactureDocument(
  snapshot: FinanceDocumentSnapshot
): Promise<FinanceDocumentArtifact> {
  const documentId = crypto.randomUUID();
  const safeNumber = snapshot.legal_number.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const fileName = `Facture_${safeNumber}_v1.pdf`;
  const storageRoot = ensureDocumentStoragePath();
  const filePath = path.join(storageRoot, `${documentId}.pdf`);

  const pdf = await renderFinanceDocument({
    kind: "FACTURE",
    number: snapshot.legal_number,
    draft: false,
    issueDate: snapshot.issue_date,
    currency: snapshot.currency,
    issuer: snapshot.issuer_snapshot,
    client: snapshot.client_snapshot,
    lines: snapshot.lines.map((line) => ({
      designation: line.designation,
      codePiece: line.code_piece,
      quantity: line.quantity,
      unit: line.unit,
      unitPriceExTax: line.unit_price_ex_tax,
      discountPercent: line.discount_percent,
      taxRatePercent: line.tax_rate_percent,
      totalExTax: line.total_ex_tax,
      taxAmount: line.tax_amount,
      totalInclTax: line.total_incl_tax,
    })),
    totals: {
      subtotalExTax: snapshot.totals.subtotal_ex_tax,
      globalDiscountPercent: snapshot.totals.global_discount_percent,
      globalDiscountAmount: snapshot.totals.global_discount_amount,
      totalExTax: snapshot.totals.total_ex_tax,
      totalTax: snapshot.totals.total_tax,
      totalInclTax: snapshot.totals.total_incl_tax,
    },
    dueDates: snapshot.due_dates.map((due) => ({
      dueDate: due.due_date,
      label: due.label,
      amount: due.amount,
    })),
    // `internal_comment` reste dans l'ERP : seul le texte destine au client est imprime.
    customerText: snapshot.customer_text,
    snapshotUuid: snapshot.uuid,
    draftReference: snapshot.draft_reference,
  });

  await fs.writeFile(filePath, pdf, { flag: "wx" });

  return {
    documentId,
    fileName,
    checksumSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    fileSizeBytes: pdf.byteLength,
    cleanup: async () => {
      await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
