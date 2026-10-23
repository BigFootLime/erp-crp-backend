import { renderCerpDocument } from "../../../shared/pdf/cerp-document";
import { renderWorkshopBoxes, renderWorkshopTable, renderWorkshopWritingArea } from "../../../shared/pdf/workshop-document-blocks";
import { formatDateFr, type OfDocumentPayload } from "../domain/of-document";

export type WorkshopSupportKind = "IMPROVEMENT" | "PREPARATION_CREATION" | "PREPARATION_INDEX";
const preparation = [
  ["Commercial", "Exigences générales client : cahier des charges, spécifications"],
  ["Commercial", "Exigences spécifiques pièce : assurance qualité, spécifications, commentaires"],
  ["Commercial", "Reprise provisoire de la gamme ; numéros de programme à vérifier"],
  ["Méthodes", "Classement du nouveau plan client"],
  ["Méthodes", "Plan de fabrication CRP"],
  ["Méthodes", "Archivage des anciens plans ; indice, date et visa"],
  ["Méthodes", "Fichiers DXF et STEP si nécessaires"],
  ["Méthodes", "Moyens de contrôle spécifiques et fiche d’autocontrôle"],
  ["Méthodes", "Programmes CN et préparation de programmation"],
  ["Méthodes", "Définition du brut et du débit"],
  ["Méthodes", "Traitements sur la gamme et le plan"],
  ["Qualité", "Stock ancien indice : dérogation, modification ou isolement"],
  ["Qualité", "Date de sortie de l’ancien indice et observations"],
  ["Qualité", "Dossier première pièce / EI et documents à fournir"],
];

/** Blank paper companions adapted from MD38-D / MD61-A. Only OF identity is
 * prefilled. No signature, inspection reading, acceptance or WIP is invented. */
export function renderWorkshopSupportPaper(payload: OfDocumentPayload, kind: WorkshopSupportKind): Promise<Buffer> {
  const improvement = kind === "IMPROVEMENT", source = improvement ? "MD61-A" : "MD38-D";
  return renderCerpDocument({
      module: "production",
    designVersion: "structured-v5", documentType: improvement ? "Informations techniques et suivi" : "Préparation de fabrication",
    name: payload.ofNumero, code: payload.revisionCode,
    status: improvement ? "Fiche à compléter" : kind === "PREPARATION_INDEX" ? "Changement d’indice" : "Création de pièce",
    generatedAt: formatDateFr(payload.generatedAt), generatedBy: payload.auteur, watermark: payload.watermark,
    title: `${improvement ? "Suivi" : "Préparation"} ${payload.ofNumero}`,
    subject: `Fiche vierge ${source} adaptée à ${payload.ofNumero}`,
    footerNote: `${payload.ofNumero} ${payload.revisionCode} | Modèle source ${source} | CERP support/1.0`,
    creationDate: new Date(payload.generatedAt),
  }, ctx => {
    renderWorkshopBoxes(ctx, [
      { title: "Client et affaires", columns: 2, fields: [
        { label: "Code client", value: payload.clientCode },
        { label: "Affaires de livraison", value: payload.affaires.map(item => item.numero).filter(Boolean).join(" / ") || "Fabrication interne" },
      ] },
      { title: "Pièce", columns: 2, fields: [
        { label: "Référence", value: payload.pieceReference }, { label: "Indice", value: payload.pieceIndice },
        { label: "Désignation", value: payload.pieceDesignation, span: 2 },
      ] },
    ], { compact: true });
    if (improvement) {
      renderWorkshopWritingArea(ctx, "Amélioration continue — prochaine fabrication", 85);
      renderWorkshopTable(ctx, { columns: [
        { key: "date", label: "Date", flex: 1 }, { key: "visa", label: "VISA", flex: 1 },
        { key: "operation", label: "Opération / programme", flex: 3 },
      ], minimumRowHeight: 32, rows: [{ cells: { date: "", visa: "", operation: "" } }] });
      renderWorkshopWritingArea(ctx, "Pièces en cours de fabrication", 42);
      renderWorkshopTable(ctx, { columns: [
        { key: "quantity", label: "Quantité constatée", flex: 1 }, { key: "material", label: "Matière / lots", flex: 2 }, { key: "visa", label: "Date / VISA", flex: 2 },
      ], minimumRowHeight: 32, rows: [{ cells: { quantity: "", material: "", visa: "" } }] });
      renderWorkshopWritingArea(ctx, "Reste à réaliser : usinage, ébavurage, traitement, finition, autre", 42);
    } else {
      renderWorkshopTable(ctx, { title: "Préparation — commentaires et visas", minimumRowHeight: 24, bodySize: 8.5, padding: 4, columns: [
        { key: "team", label: "Service", flex: 1.2 }, { key: "check", label: "Vérification", flex: 3.1 },
        { key: "comment", label: "Commentaires", flex: 2.1 }, { key: "visa", label: "VISA", flex: .7 },
      ], rows: preparation.map(([team, check]) => ({ cells: { team, check, comment: "", visa: "" } })) });
    }
  });
}
