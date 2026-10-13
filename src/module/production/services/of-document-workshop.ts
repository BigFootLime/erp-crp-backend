import type { CerpDocumentContext } from "../../../shared/pdf/cerp-document";
import { renderWorkshopBoxes, renderWorkshopTable, type WorkshopFieldBox } from "../../../shared/pdf/workshop-document-blocks";
import { formatDateFr, formatNumberFr, formatQuantity, type OfDocumentPayload } from "../domain/of-document";
import type { WorkshopDocumentTechnicalEvidence } from "../domain/of-document-technical-source";
import { formatWorkshopDuration } from "../../../shared/pdf/workshop-duration";

const number = (value: number | null | undefined) => formatQuantity(value);
const componentQuantity = (value: number | null, unit: string | null) => `${number(value)} ${unit === "pièce" && value !== 1 ? "pièces" : unit ?? ""}`;
const mm = (value: number | null) => value === null ? "Non renseigné" : `${number(value)} mm`;
const executionStates: Record<string, string> = { DONE: "Terminée", RUNNING: "En cours", IN_PROGRESS: "En cours", TODO: "À réaliser", READY: "Prête", BLOCKED: "Bloquée", CANCELLED: "Annulée" };

function materialHeader(payload: OfDocumentPayload): WorkshopFieldBox {
  const evidence = payload.technicalEvidence;
  if (evidence?.materialNotRequired) return { title: "Matière et débit", fields: [
    { label: "Matière première directe", value: "Non applicable — montage" },
    { label: "Composants", value: evidence.nomenclature?.map(item => `${item.reference ?? item.repere ?? "À compléter"} : ${componentQuantity(item.requiredQuantity, item.unit)}`).join("\n") || "Voir nomenclature" },
  ] };
  if (evidence?.materials.length) {
    const materials = evidence.materials;
    const dimensionNames: Record<string, string> = { diametre_mm: "Ø", longueur_mm: "Lg", largeur_mm: "Largeur", epaisseur_mm: "Ép." };
    const lines = (read: (material: typeof materials[number]) => string | null) => materials.map(material => read(material) ?? "À compléter").join("\n");
    return { title: "Matière et débit", columns: 2, fields: [
      { label: "Référence / désignation", span: 2, value: lines(material => [material.reference, material.designation].filter(Boolean).join("\n")) },
      { label: "Nuance / état", value: lines(material => [material.grade, material.condition].filter(Boolean).join(" / ") || null) },
      { label: "Dimensions mini", value: lines(material => Object.entries(material.dimensions).map(([key, value]) => `${dimensionNames[key] ?? key} ${number(value)} mm`).join("\n") || null) },
      { label: "Besoin total de cet OF", value: lines(material => material.requiredQuantity === null ? null : `${number(material.requiredQuantity)} ${material.unit ?? ""}`), prominent: true },
      { label: "Débit par brut", value: lines(material => material.debitPerBlank === null ? null : `${number(material.debitPerBlank)} ${material.unit ?? ""}`) },
    ] };
  }
  return { title: "Matière et débit", columns: 2, fields: [
    { label: "Référence / désignation", span: 2, value: [payload.matiere.reference, payload.matiere.designation].filter(Boolean).join("\n") || null },
    { label: "Nuance", value: payload.matiere.nuance },
    { label: "Section du brut", value: payload.decoupe.dimensions },
    { label: "Longueur du brut", value: mm(payload.decoupe.longueurBrutMm) },
    { label: "Bruts / pièces par brut", value: `${number(payload.decoupe.nombreBruts)} / ${number(payload.decoupe.piecesParBrut)}` },
    { label: "Besoin total", value: `${mm(payload.decoupe.longueurTotaleMm)} / ${payload.decoupe.unite ?? "Non renseignée"}` },
  ] };
}

function visaText(phase: OfDocumentPayload["phases"][number]): string {
  const visa = phase.visa;
  return [
    visa.operateur,
    visa.visaOperateur ? `Visa op. : ${visa.visaOperateur}` : "Visa op. :\n__________",
    visa.visaControle ? `Contrôle : ${visa.visaControle}` : "Contrôle :\n__________",
    visa.visaAt ? formatDateFr(visa.visaAt) : null,
    visa.quantiteBonne !== null ? `Bonnes au visa : ${number(visa.quantiteBonne)}` : null,
    visa.quantiteRebut !== null ? `Rebuts au visa : ${number(visa.quantiteRebut)}` : null,
    visa.motifRebut,
    visa.statut === "REFUSE" ? "VISA REFUSÉ" : null,
    visa.commentaire,
  ].filter(Boolean).join("\n");
}

/** Clear workshop zones and a wide operation column. Every instruction is retained, however many pages it needs. */
export function renderWorkshopOfDocument(ctx: CerpDocumentContext, payload: OfDocumentPayload): void {
  const commercial = payload.commercialScope ? payload.commercialScope === "CUSTOMER" : Boolean(payload.commandeNumero || payload.affaires.length);
  const q = payload.quantites;
  const arDates = [...new Set(payload.affaires.flatMap(affaire => affaire.delaiClient ? [affaire.delaiClient] : []))].sort();
  renderWorkshopBoxes(ctx, [
    {
      title: commercial ? "Commande" : "Fabrication",
      columns: 2,
      columnWeights: [3, 2],
      fields: [
        { label: "Référence commande", value: [payload.commandes?.length === 1 ? payload.commandes[0].referenceClient : null,
          payload.commandeNumero ?? (commercial ? null : "Sans commande ferme")].filter(Boolean).join("\n") || null },
        { label: arDates.length ? arDates.length > 1 ? "AR le plus proche" : "Délai client — AR" : "Délai interne", value: arDates.length
          ? `${formatDateFr(arDates[0])}${arDates.length > 1 ? "\nVoir cadence détaillée" : ""}` : payload.internalDueDate ? formatDateFr(payload.internalDueDate) : "À définir", prominent: true },
        { label: "Quantité demandée", value: commercial ? `${number(q.quantiteDemandee)} pièces` : "Sans commande ferme", prominent: commercial },
        { label: "Quantité lancée", value: payload.quantiteLancee === undefined ? null : `${number(payload.quantiteLancee)} pièces`, prominent: true },
      ],
    },
    materialHeader(payload),
  ], { compact: true });
  renderWorkshopBoxes(ctx, [
    { title: "Client et documents", columns: 2, fields: [
      { label: "Code client", value: payload.clientCode },
      { label: "Affaire de livraison", value: payload.affaires.map(affaire => affaire.numero ?? `Affaire #${affaire.affaireId}`).join("\n") || "Aucune affaire rattachée" },
      { label: "Documents à fournir", span: 2, value: payload.documentsAFournir.map(document => `- ${document}`).join("\n") || "Aucun document requis" },
    ] },
    { title: "Pièce", fields: [
      { label: "Référence / indice", value: [payload.pieceReference, payload.pieceIndice ? `Indice ${payload.pieceIndice}` : null].filter(Boolean).join(" / ") || null, prominent: true },
      { label: "Désignation", value: payload.pieceDesignation },
    ] },
  ], { compact: true });
  if ((payload.commandes?.length ?? 0) > 1) renderWorkshopTable(ctx, {
    title: "Commandes regroupées",
    columns: [{ key: "command", label: "Commande ERP", flex: 2 }, { key: "reference", label: "Référence client", flex: 3 }],
    rows: payload.commandes!.map(command => ({ cells: { command: command.numero, reference: command.referenceClient ?? "Non renseignée" } })),
  });
  if ((payload.sourceOrders?.length ?? 0) > 1) renderWorkshopTable(ctx, {
    title: "OF couverts par cette fabrication",
    columns: [{ key: "of", label: "OF source", flex: 3 }, { key: "launched", label: "Quantité", flex: 1 }, { key: "remaining", label: "Production restant à affecter", flex: 2 }],
    rows: payload.sourceOrders!.map(source => ({ cells: { of: source.number, launched: number(source.launched), remaining: number(source.remaining) } })),
  });
  if (payload.affaires.length > 2) renderWorkshopTable(ctx, {
    title: "Toutes les affaires rattachées",
    columns: [{ key: "ref", label: "Affaire", flex: 2 }, { key: "ar", label: "Délai AR", flex: 1.2 }, { key: "qty", label: "Pièces", flex: 0.8 }],
    rows: payload.affaires.map(affaire => ({ cells: { ref: affaire.numero ?? `#${affaire.affaireId}`, ar: formatDateFr(affaire.delaiClient), qty: number(affaire.quantite) } })),
  });
  ctx.section("Nomenclature", { cohesion: payload.technicalEvidence?.materials.length ? 180 : 130 });
  if (payload.technicalEvidence?.materials.length) renderWorkshopTable(ctx, {
    columns: [
      { key: "phase", label: "Phase", flex: 0.8 },
      { key: "material", label: "Matière première / exigences", flex: 3.8, firstLineBold: true },
      { key: "debit", label: "Débit par brut", flex: 1.5, align: "right" },
      { key: "need", label: "Besoin de cet OF", flex: 1.5, align: "right" },
    ],
    rows: payload.technicalEvidence.materials.map(material => ({ cells: {
      phase: material.phase === null ? "Non affectée" : String(material.phase),
      material: [material.reference, material.designation, [material.grade, material.condition].filter(Boolean).join(" / "),
        material.certificates.length ? `Certificats : ${material.certificates.join(", ")}` : null].filter(Boolean).join("\n"),
      debit: material.debitPerBlank === null ? "Non renseigné" : `${number(material.debitPerBlank)} ${material.unit ?? ""}`,
      need: material.requiredQuantity === null ? "Non renseigné" : `${number(material.requiredQuantity)} ${material.unit ?? ""}`,
    } })),
  });
  if (payload.technicalEvidence?.nomenclature?.length) renderWorkshopTable(ctx, {
    title: "Sous-pièces et composants",
    columns: [{ key: "repere", label: "Repère", flex: 1 }, { key: "article", label: "Référence / indice / désignation", flex: 4, firstLineBold: true },
      { key: "perParent", label: "Qté par ensemble", flex: 1.4 }, { key: "total", label: "Besoin de cet OF", flex: 1.5 }],
    rows: payload.technicalEvidence.nomenclature.map(component => ({ cells: {
      repere: component.repere ?? "—", article: [component.reference ?? "Référence à compléter", component.indice ? `Indice ${component.indice}` : null,
        component.designation].filter(Boolean).join("\n"),
      perParent: componentQuantity(component.quantityPerParent, component.unit),
      total: componentQuantity(component.requiredQuantity, component.unit),
    } })),
  });
  if (payload.technicalEvidence?.materials.length) {
    renderDocumentMaterialEvidence(ctx, payload.technicalEvidence);
  } else if (!payload.technicalEvidence?.materialNotRequired) {
  const details = [
    payload.decoupe.longueurUtileMm !== null ? `Longueur utile : ${mm(payload.decoupe.longueurUtileMm)}` : null,
    payload.decoupe.traitDeScieMm !== null ? `Trait de scie : ${mm(payload.decoupe.traitDeScieMm)}` : null,
    payload.decoupe.chuteMm !== null ? `Chute prévue par brut : ${mm(payload.decoupe.chuteMm)}` : null,
    payload.decoupe.masseTotaleKg !== null ? `Masse : ${formatNumberFr(payload.decoupe.masseTotaleKg, 3)} kg` : null,
    payload.decoupe.methodeCalcul,
  ].filter(Boolean).join("\n");
  if (details) ctx.notes(details);
  }
  if (payload.technicalEvidence?.purchases.length) renderWorkshopTable(ctx, {
    title: "Traitements, sous-traitance et achats",
    columns: [{ key: "phase", label: "Phase", flex: 0.8 }, { key: "designation", label: "Prestation / article", flex: 4.2, firstLineBold: true }, { key: "quantity", label: "Besoin par pièce", flex: 1.4 }],
    rows: payload.technicalEvidence.purchases.map(purchase => ({ cells: {
      phase: purchase.phase === null ? "Non affectée" : String(purchase.phase),
      designation: [purchase.reference, purchase.designation, purchase.type].filter(Boolean).join("\n"),
      quantity: purchase.quantityPerPiece === null ? "Non renseigné" : `${number(purchase.quantityPerPiece)} ${purchase.unit ?? "unité non renseignée"}`,
    } })),
  });

  // The measured first row stays with its heading. Instructions continue without a page-count cap.
  renderWorkshopTable(ctx, {
    title: "Gamme applicable - opérations",
    columns: [
      { key: "phase", label: "Phase", flex: 1.1, bold: true },
      { key: "operation", label: "Opération / machine / programme", flex: 4.1, firstLineBold: true },
      { key: "unit", label: "T/P\npar pièce", flex: 1.3, align: "right" },
      { key: "setup", label: "Réglage", flex: 1.3, align: "right" },
      { key: "load", label: "Charge\nprévue", flex: 1.45, align: "right" },
      { key: "visa", label: "Visas", flex: 1.65 },
    ],
    rows: payload.phases.map(phase => ({
      continuationLabel: `Phase ${phase.phase} - suite`,
      cells: {
        phase: String(phase.phase),
        operation: [
          phase.designation,
          phase.machine ? `Machine : ${phase.machine}` : null,
          [phase.familyLabel, phase.centre ? `Centre : ${phase.centre}` : null].filter(Boolean).join(" / ") || null,
          phase.programme ? `Programme : ${phase.programme}` : phase.programmeManquant ? "Programme à obtenir avant lancement" : null,
          phase.quantiteBase !== 1 ? `Quantité de base : ${number(phase.quantiteBase)}` : null,
          phase.coefficient !== 1 ? `Coefficient : ${number(phase.coefficient)}` : null,
          phase.execution ? `Production : ${executionStates[phase.execution.statut] ?? phase.execution.statut}\n${number(phase.execution.bonnes)} bonnes / ${number(phase.execution.rebuts)} rebuts${phase.execution.attenteControle ? ` / ${number(phase.execution.attenteControle)} en contrôle` : ""}${phase.execution.reprises ? ` / ${number(phase.execution.reprises)} reprises` : ""}` : null,
        ].filter(Boolean).join("\n"),
        unit: formatWorkshopDuration(phase.tempsUnitaireH),
        setup: phase.preparationH > 0 && phase.preparationLabel === "0 min" ? formatWorkshopDuration(phase.preparationH) : phase.preparationLabel,
        load: phase.finalLabel,
        visa: visaText(phase),
      },
    })),
    emptyLabel: "Aucune opération enregistrée dans cette révision.",
  });
  renderWorkshopBoxes(ctx, [{ title: "Temps prévus", fields: [
    { label: "Quantité prise en compte", value: payload.quantiteLancee === undefined ? "Calcul historique de la gamme" : `${number(payload.quantiteLancee)} pièces lancées` },
    { label: "Réglage / fabrication / charge totale", value: `${payload.totaux.preparationLabel} / ${payload.totaux.fabricationLabel} / ${payload.totaux.finalLabel}` },
  ] }]);
  if (commercial) renderWorkshopTable(ctx, {
    title: "Suivi de la demande client",
    columns: [{ key: "state", label: "Couverture", flex: 3 }, { key: "qty", label: "Quantité", flex: 1, align: "right" }],
    rows: [
      ["Quantité demandée", q.quantiteDemandee], ["Expédiée par BL", q.quantiteLivree], ["Stock réservé", q.stockReserve],
      ["Production attendue d'autres OF", q.couvertAutresOf], ["Production de cet OF restant à affecter", q.quantiteAffecteeCetOf], ["Reste net à couvrir", q.resteNetACouvrir],
    ].map(([state, qty]) => ({ cells: { state: String(state), qty: number(Number(qty)) } })),
  });
  if (payload.cadenceLivraison.length) renderWorkshopTable(ctx, {
    title: "Cadence de livraison",
    columns: [{ key: "date", label: "Échéance", flex: 1 }, { key: "ref", label: "Affaire", flex: 2 }, { key: "qty", label: "Pièces", flex: 1 }],
    rows: payload.cadenceLivraison.map(item => ({ cells: { date: formatDateFr(item.date), ref: item.affaireNumero ?? "Non renseignée", qty: number(item.quantite) } })),
  });
  if (payload.cadenceProduction.length || payload.derniereFabrication) ctx.notesSection("Production", [
    ...payload.cadenceProduction.map(item => `Cadence : ${formatDateFr(item.date)} - ${number(item.quantite)} pièces`),
    payload.derniereFabrication ? `Dernière fabrication : ${payload.derniereFabrication.numero ?? "Non renseignée"} - ${formatDateFr(payload.derniereFabrication.date)}` : null,
  ].filter(Boolean).join("\n"));
  if (payload.avertissements.length) ctx.notesSection("Points à vérifier", payload.avertissements.map(item => `[${item.severite}] ${item.message}`).join("\n"));
  ctx.signatureBox("Visas complémentaires sur papier", ["Nom", "Date", "Signature"]);
}

function renderDocumentMaterialEvidence(ctx: CerpDocumentContext, evidence: WorkshopDocumentTechnicalEvidence): void {
  for (const material of evidence.materials) {
    if (material.certificates.length || material.manualChecks.length) ctx.notes([
      material.certificates.length ? `Certificats requis : ${material.certificates.join(", ")}` : null,
      ...material.manualChecks,
    ].filter(Boolean).join("\n"));
  }
  if (evidence.debits.length) renderWorkshopTable(ctx, {
    title: "Sorties matière enregistrées",
    columns: [
      { key: "source", label: "Lot / barre", flex: 2.55, firstLineBold: true },
      { key: "actual", label: "Sortie stock", flex: 1.15, align: "right" },
      { key: "cut", label: "Débit", flex: 1.05, align: "right" },
      { key: "discarded", label: "Écarté", flex: 1.05, align: "right" },
      { key: "remaining", label: "Restant barre", flex: 1.15, align: "right" },
      { key: "quantity", label: "Qté déclarée", flex: 1.2, align: "right" },
    ],
    rows: evidence.debits.map(debit => ({ cells: {
      source: [debit.lot, debit.bar, `Phase ${debit.phase} - ${formatDateFr(debit.recordedAt)}`].filter(Boolean).join("\n"),
      actual: `${number(debit.actual)} ${debit.unit ?? ""}`,
      cut: `${number(debit.cut)} ${debit.unit ?? ""}`, discarded: `${number(debit.discarded)} ${debit.unit ?? ""}`,
      remaining: debit.closed ? "Soldée" : debit.remaining === null ? "Non renseigné" : `${number(debit.remaining)} mm`,
      quantity: debit.quantityGood === null ? "Non répartie par barre" : `${number(debit.quantityGood)}${debit.quantityKind === "POTENTIAL" ? "\npotentiels" : ""}`,
    } })),
  });
  if (evidence.correctionCount) ctx.notes(`${evidence.correctionCount} correction(s) de débit enregistrée(s). Le tableau présente les sorties encore valides ; l’historique complet reste dans l’OF.`);
}
