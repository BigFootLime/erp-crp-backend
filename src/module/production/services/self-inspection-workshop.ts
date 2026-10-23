import { renderCerpDocument } from "../../../shared/pdf/cerp-document";
import { renderWorkshopBoxes, renderWorkshopTable, renderWorkshopWritingArea } from "../../../shared/pdf/workshop-document-blocks";
import { quantity, rate } from "../../../shared/pdf/format-fr";
import type { SelfInspectionSnapshot } from "./self-inspection-pdf";

export type SelfInspectionIdentity = {
  client_code: string | null;
  reference: string | null;
  designation: string | null;
  affairs: string[];
  scope?: "CUSTOMER" | "ASSEMBLY" | "INTERNAL";
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function decimal(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value);
  // A malformed historic value is retained verbatim; never invent a tolerance.
  return /^-?\d+(?:[.,]\d+)?$/.test(raw) ? quantity(raw) : raw;
}

export function inspectionRequirement(c: Record<string, unknown>): string {
  const parts = [text(c.label) || text(c.characteristic_key) || "Contrôle"];
  const unit = text(c.unit);
  const nominal = decimal(c.nominal);
  if (nominal !== null) parts.push(`Nominal : ${nominal}${unit ? ` ${unit}` : ""}`);
  const lower = decimal(c.tolerance_min), upper = decimal(c.tolerance_max);
  if (lower !== null || upper !== null) parts.push(`${nominal === null ? "Limites" : "Tol."} : ${lower ?? "-"} / ${upper ?? "-"}${unit ? ` ${unit}` : ""}`);
  if (c.value_kind === "BOOLEAN" && typeof c.expected_boolean === "boolean") parts.push(`Attendu : ${c.expected_boolean ? "Oui" : "Non"}`);
  if (c.value_kind === "ENUM" && Array.isArray(c.allowed_values)) parts.push(`Valeurs admises : ${c.allowed_values.filter((v): v is string => typeof v === "string").join(" / ")}`);
  if (text(c.acceptance_rule)) parts.push(text(c.acceptance_rule));
  if (text(c.method)) parts.push(`Méthode : ${text(c.method)}`);
  return parts.join("\n");
}

export function inspectionSampling(c: Record<string, unknown>): string {
  const rule = text(c.sampling_rule);
  const value = decimal(c.sampling_value);
  if (rule === "ALL") return "100 %";
  if (rule === "PERCENT" && value !== null) return rate(value) ?? "";
  if (rule === "FIXED" && value !== null) return `${value} pièce(s)`;
  const labels: Record<string, string> = { FIRST_ARTICLE: "Première pièce", LOT: "Par lot" };
  return labels[rule] ?? rule;
}

/** Blank paper evidence: requirements are printed, measured values and visas never are. */
export async function renderSelfInspectionWorkshop(snapshot: SelfInspectionSnapshot): Promise<Buffer> {
  const identity = snapshot.identity;
  const createdAt = snapshot.generated_at ? new Date(snapshot.generated_at) : new Date();
  if (!Number.isFinite(createdAt.getTime())) throw new Error("INSPECTION_PDF_DATE_INVALID");
  return renderCerpDocument({
      module: "qualite",
    designVersion: "structured-v5",
    documentType: "Fiche d’autocontrôle",
    name: snapshot.of.numero,
    code: `${snapshot.plan.code} / v${snapshot.plan.version}`,
    status: "Fiche vierge",
    generatedAt: new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris" }).format(createdAt),
    creationDate: createdAt,
    title: `Fiche d’autocontrôle - ${snapshot.of.numero}`,
    subject: `Autocontrôle vierge - indice ${snapshot.version.indice}`,
    footerNote: `Indice ${snapshot.version.indice} | ${snapshot.plan.code} / v${snapshot.plan.version}`,
  }, (ctx) => {
    renderWorkshopBoxes(ctx, [
      { title: "Fabrication", columns: 2, fields: [
        { label: "Code client", value: identity?.client_code ?? null },
        { label: "Affaire de livraison", value: identity?.affairs.join("\n") || (identity?.scope === "INTERNAL" ? "Fabrication interne" : identity?.scope === "ASSEMBLY" ? "Sous-pièce de montage" : null) },
        { label: "Quantité lancée", value: `${quantity(snapshot.of.quantite_lancee)} pièces`, prominent: true },
        { label: "Indice", value: snapshot.version.indice, prominent: true },
      ] },
      { title: "Pièce", fields: [
        { label: "Référence", value: identity?.reference ?? null },
        { label: "Désignation", value: identity?.designation ?? null },
      ] },
    ], { compact: true });
    renderWorkshopTable(ctx, {
      title: "Relevés pendant la fabrication",
      padding: 5, bodySize: 8.5, minimumRowHeight: 56,
      columns: [
        { key: "requirement", label: "Cote / tolérances / exigence", flex: 3.7, firstLineBold: true },
        { key: "first", label: "Première pièce", flex: 1.2 },
        { key: "instrument", label: "N° instrument", flex: 1.2 },
        { key: "sampling", label: "Surveillance", flex: 1.35 },
        { key: "last", label: "Dernière pièce", flex: 1.2 },
        { key: "notes", label: "Observations", flex: 1.7 },
      ],
      rows: snapshot.characteristics.map((c) => ({
        cells: { requirement: inspectionRequirement(c), first: "", instrument: "", sampling: inspectionSampling(c), last: "", notes: "" },
        continuationLabel: `Suite - ${text(c.characteristic_key) || text(c.label) || "contrôle"}`,
      })),
      emptyLabel: "Aucune caractéristique dans le plan applicable.",
    });
    renderWorkshopTable(ctx, {
      title: "Opération et visa", padding: 5, bodySize: 9, minimumRowHeight: 42,
      columns: [
        { key: "operation", label: "N° OP", flex: 1 },
        { key: "machine", label: "Machine", flex: 2.4 },
        { key: "good", label: "Qté conforme", flex: 1.4 },
        { key: "scrap", label: "Qté rebut", flex: 1.2 },
        { key: "date", label: "Date", flex: 1.5 },
        { key: "visa", label: "Visa", flex: 1 },
      ],
      rows: [{ cells: { operation: "", machine: "", good: "", scrap: "", date: "", visa: "" } }],
    });
    renderWorkshopWritingArea(ctx, "Observations / modification de programme");
    ctx.notes("Un changement de programme impose un nouveau contrôle de première pièce. Mode papier : scan obligatoire de la fiche renseignée, rattaché à l’OF et à l’opération, sans ressaisie des mesures. La libération qualité reste distincte.");
  });
}
