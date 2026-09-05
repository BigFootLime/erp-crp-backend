import PDFDocument from "pdfkit";

export type SelfInspectionSnapshot = {
  of: { id: number; numero: string; quantite_lancee: number };
  version: { indice: string };
  plan: { code: string; version: number; label: string };
  characteristics: Array<Record<string, unknown>>;
  source_hash: string;
};

/** A blank inspection form, never an inspection result or a conformity certificate. */
export async function renderSelfInspectionPdf(
  snapshot: SelfInspectionSnapshot,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 40,
      info: { Title: `Autocontrôle ${snapshot.of.numero}` },
    });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(19).text("Fiche d’autocontrôle");
    doc
      .moveDown(0.4)
      .fontSize(11)
      .text(
        `${snapshot.of.numero} · Indice ${snapshot.version.indice} · Quantité ${snapshot.of.quantite_lancee}`,
      );
    doc.text(
      `${snapshot.plan.code} / v${snapshot.plan.version} — ${snapshot.plan.label}`,
    );
    doc
      .moveDown()
      .fontSize(10)
      .text(
        "À renseigner pendant la fabrication. Aucune mesure ni conformité n’est préremplie.",
      );
    doc
      .moveDown()
      .text(
        "Opérateur : __________________  Date : ______________  Lot : __________________",
      );
    for (const [index, c] of snapshot.characteristics.entries()) {
      if (doc.y > 690) doc.addPage();
      doc
        .moveDown()
        .font("Helvetica-Bold")
        .text(
          `${index + 1}. ${String(c.label ?? c.characteristic_key ?? "Contrôle")}`,
        );
      doc
        .font("Helvetica")
        .text(
          `Nominal : ${String(c.nominal ?? "—")} ${String(c.unit ?? "")} · Tol. inf. : ${String(c.tolerance_min ?? "—")} · Tol. sup. : ${String(c.tolerance_max ?? "—")}`,
        );
      if (c.acceptance_rule) doc.text(`Critère : ${String(c.acceptance_rule)}`);
      if (c.method) doc.text(`Méthode : ${String(c.method)}`);
      doc.text(
        "Échantillon / mesure : ____________________  Instrument : ____________________",
      );
      doc.text(
        "Résultat : __________________  Observation : ______________________________",
      );
    }
    if (doc.y > 705) doc.addPage();
    doc
      .moveDown()
      .fontSize(7)
      .text(`Définition : ${snapshot.source_hash}`, { lineBreak: true });
    doc.end();
  });
}
