import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ensureDocumentStoragePath } from "../../../utils/cerpStorage";
import type {
  AvoirDocumentArtifact,
  AvoirDocumentSnapshot,
} from "../repository/avoir-workflow.repository";

import { renderFinanceDocument } from "./finance-document-render";

/**
 * Exemplaire legal immuable de l'avoir.
 *
 * Meme rendu que la facture (`finance-document-render.ts`). La version precedente n'avait pas
 * de table : les lignes etaient ecrites en paragraphes libres, et la date d'emission sortait au
 * format ISO brut sur un document adresse au client.
 */
export async function writeImmutableAvoirDocument(
  snapshot: AvoirDocumentSnapshot
): Promise<AvoirDocumentArtifact> {
  const documentId = crypto.randomUUID();
  const safeNumber = snapshot.legal_number.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const fileName = `Avoir_${safeNumber}_v1.pdf`;
  const filePath = path.join(ensureDocumentStoragePath(), `${documentId}.pdf`);

  const pdf = await renderFinanceDocument({
    kind: "AVOIR",
    number: snapshot.legal_number,
    draft: false,
    issueDate: snapshot.issue_date,
    currency: snapshot.currency,
    issuer: snapshot.issuer_snapshot,
    client: snapshot.client_snapshot,
    // Un avoir credite : c'est la quantite retenue qui fait foi, pas celle facturee a l'origine.
    lines: snapshot.lines.map((line) => ({
      designation: line.designation,
      codePiece: line.code_piece,
      quantity: line.quantity_selected,
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
    dueDates: [],
    correctedInvoice: snapshot.facture_number,
    reasonCode: snapshot.reason_code,
    reason: snapshot.reason,
    snapshotUuid: snapshot.uuid,
    draftReference: snapshot.draft_reference,
  });

  await fs.writeFile(filePath, pdf, { flag: "wx" });

  return {
    documentId,
    fileName,
    checksumSha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    fileSizeBytes: pdf.byteLength,
    pdfBytes: Buffer.from(pdf),
    cleanup: async () => {
      await fs.unlink(filePath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    },
  };
}
