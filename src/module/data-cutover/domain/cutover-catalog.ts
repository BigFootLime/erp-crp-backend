import type { CutoverDomain, CutoverField } from "../types/data-cutover.types";

const text = (key: string, label: string, required = true, group = "Identification"): CutoverField => ({ key, label, type: "text", required, group, max_length: group === "Justificatifs" ? 1000 : key === "designation" ? 400 : key === "name" ? 200 : key === "address" ? 400 : key === "email" ? 254 : 120, pattern: "^[^<>\\u0000-\\u001f]+$", ...(key === "email" ? { format: "email" as const } : key === "siret" ? { format: "siret" as const, max_length: 14 } : key === "currency" ? { format: "currency" as const, max_length: 3 } : {}) });
const number = (key: string, label: string, required = true, precision = 6): CutoverField => ({ key, label, type: "number", required, precision, group: "Quantités et montants", ...(/^(quantity|stockReserved|scrapQuantity|paidAmount|unitPrice|valuationUnitPrice)/.test(key) ? { min: key === "quantityOrdered" || key === "quantity" ? 0.000001 : 0 } : {}), max: 999999999999 });
const date = (key: string, label: string, required = true): CutoverField => ({ key, label, type: "date", required, group: "Dates" });
const select = (key: string, label: string, options: string[], required = true): CutoverField => ({ key, label, type: "select", required, options, group: "Vérifications" });
const article = () => text("articleReference", "Référence article / pièce");
const unit = (): CutoverField => ({ ...text("unit", "Unité"), format: "unit", max_length: 30, hint: "Choisir une unité du référentiel CERP. Aucune quantité n'est convertie automatiquement." });
const money = (key: string, label: string, required = true) => number(key, label, required, 2);
const customer = () => text("customerCode", "Code client d'origine");
const supplier = () => text("supplierCode", "Code fournisseur d'origine");
const evidence = (key = "evidenceReference", label = "Justificatif / référence du document") => text(key, label, true, "Justificatifs");
const link = () => [select("resolution", "Compte existant ou nouveau", ["LINK", "CREATE"]), { ...text("targetId", "Identifiant CERP rapproché", false), hint: "Obligatoire pour un rapprochement. Le code source ne vaut pas identifiant CERP." }];

export const CUTOVER_CATALOG: Array<{ key: CutoverDomain; label: string; description: string; fields: CutoverField[] }> = [
  { key: "CUSTOMER", label: "Clients", description: "Rapprocher les clients existants avant de créer une fiche.", fields: [customer(), text("name", "Raison sociale"), ...link(), text("siret", "SIRET", false), text("vatNumber", "TVA intracommunautaire", false), text("address", "Adresse", false), text("postalCode", "Code postal", false), text("city", "Ville", false), text("country", "Pays", false), text("email", "Email", false)] },
  { key: "SUPPLIER", label: "Fournisseurs", description: "Confirmer l'identité et le rapprochement fournisseur.", fields: [supplier(), text("name", "Raison sociale"), ...link(), text("siret", "SIRET", false), text("vatNumber", "TVA intracommunautaire", false), text("country", "Pays", false), text("email", "Email", false)] },
  { key: "ARTICLE", label: "Articles", description: "Conserver la référence d'origine, l'unité et les liens techniques.", fields: [article(), text("designation", "Désignation"), select("category", "Catégorie", ["matiere", "achat", "traitement", "fabrique"]), unit(), text("familyCode", "Famille CERP"), text("technicalPieceId", "Pièce technique CERP", false), { key: "lotTracked", label: "Traçabilité par lot", type: "boolean", required: true, group: "Vérifications" }, text("targetId", "Article CERP rapproché", false)] },
  { key: "TECHNICAL_PIECE", label: "Pièces techniques", description: "Un dossier incomplet reste en brouillon, sans lancement de fabrication.", fields: [article(), customer(), text("designation", "Désignation"), text("planReference", "Référence du plan"), text("externalRevision", "Indice externe", false), { key: "withoutRevision", label: "Plan explicitement sans indice", type: "boolean", required: false, group: "Vérifications" }, text("planEvidence", "Plan / document source", false, "Justificatifs"), select("technicalStatus", "État du dossier", ["DRAFT", "REVIEWED"])] },
  { key: "SALES_ORDER", label: "Affaires de livraison", description: "Confirmer le reliquat et les conditions de la commande acceptée.", fields: [customer(), text("customerOrderNumber", "Commande client"), text("affairNumber", "Affaire de livraison d'origine"), article(), number("quantityOrdered", "Quantité commandée"), number("quantityDelivered", "Déjà livré"), number("quantityCancelled", "Quantité annulée", false), number("quantityRemaining", "Reste à livrer"), number("stockReserved", "Quantité réservée", false), unit(), number("unitPrice", "Prix unitaire HT"), number("vatRate", "TVA (%)", true, 4), text("currency", "Devise"), date("plannedDueDate", "Délai confirmé"), evidence("priceEvidence", "Commande / AR confirmant le prix"), text("sourceStatus", "État indiqué dans Excel", false)] },
  { key: "INTERNAL_DEMAND", label: "Fabrication pour stock", description: "Besoin interne sans création de commande client fictive.", fields: [text("affairNumber", "Référence interne d'origine"), article(), number("quantityOrdered", "Quantité demandée"), number("quantityCompleted", "Déjà fabriqué"), number("quantityRemaining", "Reste à fabriquer"), unit(), date("orderDate", "Date source du besoin"), date("plannedDueDate", "Date souhaitée"), text("sourceStatus", "État indiqué dans Excel", false)] },
  { key: "SUPPLIER_ORDER", label: "Achats en cours", description: "Reprendre le reliquat sans refaire les réceptions déjà comprises dans le stock.", fields: [supplier(), text("supplierOrderNumber", "Commande fournisseur"), article(), number("quantityOrdered", "Quantité commandée"), number("quantityReceived", "Déjà reçu"), number("quantityCancelled", "Quantité annulée", false), number("quantityRemaining", "Reste à réceptionner"), unit(), number("unitPrice", "Prix unitaire HT"), text("currency", "Devise"), date("plannedDueDate", "Délai confirmé"), evidence("priceEvidence", "Commande confirmant le prix"), text("affairNumber", "Affaire liée", false), text("sourceStatus", "État indiqué dans Excel", false)] },
  { key: "OPENING_STOCK", label: "Stocks historiques OLD", description: "Stock repris en OLD. Les futures productions entrent en NEW après réception validée, sans dupliquer la référence article.", fields: [{ ...select("stockScope", "Origine du stock", ["OLD"]), read_only: true }, article(), text("lotReference", "Lot d'origine", false), number("quantityBook", "Quantité indiquée dans Excel", false), number("quantityCounted", "Quantité physique comptée"), number("quantityReserved", "Quantité réservée", false), unit(), text("warehouse", "Magasin"), text("location", "Emplacement"), select("qualityStatus", "État qualité", ["LIBERE", "QUARANTAINE", "BLOQUE"]), select("owner", "Propriétaire", ["CRP", "CLIENT", "FOURNISSEUR"]), text("ownerCode", "Code du propriétaire tiers", false), number("valuationUnitPrice", "Valeur unitaire d'ouverture HT", false), evidence("countEvidence", "Comptage daté / validateur"), text("certificateReference", "Certificat matière", false), text("heatNumber", "Coulée", false), text("supplierLot", "Lot fournisseur", false)] },
  { key: "WIP", label: "Fabrications commencées", description: "État confirmé par l'atelier. Une gamme prévue n'est pas une preuve d'exécution.", fields: [text("affairNumber", "Affaire / référence interne"), article(), number("quantityRemaining", "Quantité restant à terminer"), text("currentPhase", "Phase actuelle"), select("phaseState", "État de la phase", ["NOT_STARTED", "IN_PROGRESS", "PAUSED", "COMPLETED"]), number("quantityCompleted", "Quantité bonne déjà terminée"), number("scrapQuantity", "Quantité rebutée"), text("technicalRevision", "Indice utilisé"), text("workshopValidator", "Responsable ayant vérifié l'avancement"), evidence(), text("subcontractReference", "Sous-traitance en cours", false)] },
  { key: "LEGACY_DELIVERY", label: "Livraisons antérieures", description: "Une ligne par affaire du BL. Aucun nouveau mouvement de stock n'est déclenché.", fields: [text("deliveryNumber", "Numéro de BL d'origine"), text("affairNumber", "Affaire de livraison"), text("customerOrderNumber", "Commande client"), customer(), article(), number("quantity", "Quantité livrée"), unit(), date("deliveryDate", "Date de livraison"), select("billingStatus", "Facturation", ["UNBILLED", "PARTIAL", "FULLY_BILLED"]), money("unbilledAmount", "Montant HT restant à facturer", false), evidence()] },
  { key: "LEGACY_RECEIPT", label: "Réceptions antérieures", description: "Justifier le reçu non facturé sans refaire une entrée de stock.", fields: [text("receiptNumber", "BL / réception fournisseur"), text("supplierOrderNumber", "Commande fournisseur"), supplier(), article(), number("quantity", "Quantité reçue"), unit(), date("receiptDate", "Date de réception"), select("billingStatus", "Facturation", ["UNBILLED", "PARTIAL", "FULLY_BILLED"]), money("unbilledAmount", "Montant HT restant à facturer", false), evidence()] },
  ...(["OPENING_RECEIVABLE", "OPENING_PAYABLE"] as const).map((key) => ({ key, label: key === "OPENING_RECEIVABLE" ? "Impayés clients" : "Dettes fournisseurs", description: "Solde issu de la balance détaillée du comptable, rapproché du justificatif.", fields: [text("documentNumber", "Numéro du document d'origine"), select("documentKind", "Type de document", ["INVOICE", "CREDIT", "DEPOSIT_INVOICE"]), text("partnerCode", "Code client / fournisseur"), date("documentDate", "Date d'émission"), date("dueDate", "Échéance"), text("currency", "Devise"), money("originalAmount", "Montant TTC d'origine signé"), money("paymentsAllocated", "Règlements imputés signés"), money("creditsAllocated", "Avoirs imputés signés"), money("depositsAllocated", "Acomptes imputés signés"), money("openBalance", "Solde TTC restant signé"), evidence("accountingEvidence", "Balance détaillée et lettrage"), evidence("documentEvidence", "Document effectivement émis")] })),
  { key: "LEGACY_PROFORMA", label: "Proformas existantes", description: "Une proforma ne devient pas une créance fiscale. Conserver son lien avec les acomptes et règlements.", fields: [text("documentNumber", "Numéro de proforma"), customer(), date("documentDate", "Date du document"), text("currency", "Devise"), money("originalAmount", "Montant TTC demandé"), money("paidAmount", "Montant déjà payé confirmé"), text("depositInvoiceReference", "Facture d'acompte liée", false), evidence()] },
  { key: "METROLOGY", label: "Appareils de contrôle", description: "Conserver les certificats et statuts vérifiés, sans inventer d'anciens contrôles.", fields: [text("equipmentReference", "Référence équipement"), text("designation", "Désignation"), text("serialNumber", "Numéro de série", false), select("equipmentStatus", "Statut vérifié", ["ACTIVE", "QUARANTINED", "OUT_OF_SERVICE"]), date("nextCalibrationDate", "Prochaine vérification", false), text("certificateReference", "Certificat / justificatif", false)] },
];

export const catalogFor = (domain: CutoverDomain) => CUTOVER_CATALOG.find((entry) => entry.key === domain)!;
const target = (key: string, label: string, entity: NonNullable<CutoverField["lookup_entity"]>): CutoverField => ({ ...text(key, label, false, "Rapprochement CERP"), lookup_entity: entity, ...(entity === "CUSTOMER" ? {} : { format: "uuid" }), hint: "Sélectionner une fiche existante ou valider d'abord sa fiche de reprise. Ne jamais copier un ancien code comme identifiant CERP." });
// References must declare whether they are linked or created. A target ID is
// only a selected identifier; the application validates it against its context.
catalogFor("ARTICLE").fields.splice(1, 0, select("resolution", "Compte existant ou nouveau", ["LINK", "CREATE"]));
catalogFor("TECHNICAL_PIECE").fields.splice(1, 0, select("resolution", "Compte existant ou nouveau", ["LINK", "CREATE"]), target("targetId", "Pièce technique CERP rapprochée", "TECHNICAL_PIECE"));
catalogFor("CUSTOMER").fields.push(date("creationDate", "Date source ou confirmée de création", false));
catalogFor("SALES_ORDER").fields.splice(2, 0,
  date("orderDate", "Date de la commande client d'origine"),
  select("orderType", "Origine de la commande", ["UNKNOWN", "FERME", "CADRE_RELEASE"]),
  evidence("orderEvidence", "Commande / AR justifiant le type retenu"),
  text("contractReference", "Référence du contrat retrouvé", false, "Justificatifs"),
  target("contractTargetId", "Contrat CERP confirmé", "CONTRACT"));
for (const key of ["SALES_ORDER", "LEGACY_DELIVERY", "TECHNICAL_PIECE", "LEGACY_PROFORMA"] as const) catalogFor(key).fields.push(target("customerTargetId", "Client CERP confirmé", "CUSTOMER"));
for (const key of ["SUPPLIER_ORDER", "LEGACY_RECEIPT"] as const) catalogFor(key).fields.push(target("supplierTargetId", "Fournisseur CERP confirmé", "SUPPLIER"));
for (const key of ["SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND", "OPENING_STOCK", "WIP", "LEGACY_DELIVERY", "LEGACY_RECEIPT"] as const) catalogFor(key).fields.push(target("articleTargetId", "Article CERP confirmé", "ARTICLE"));
for (const key of ["WIP", "LEGACY_DELIVERY", "LEGACY_RECEIPT"] as const) catalogFor(key).fields.push(text("articleLegacyKey", "Clé source de la fiche article", false, "Rapprochement CERP"));
catalogFor("WIP").fields.push(text("affairLegacyKey", "Clé source de la commande reprise", false, "Rapprochement CERP"));
for (const key of ["OPENING_RECEIVABLE", "OPENING_PAYABLE", "LEGACY_DELIVERY", "LEGACY_RECEIPT"] as const) catalogFor(key).fields.push(text("partnerLegacyKey", "Clé source du client / fournisseur", false, "Rapprochement CERP"));
for (const key of ["OPENING_RECEIVABLE", "OPENING_PAYABLE"] as const) catalogFor(key).fields.push(target("partnerTargetId", "Client / fournisseur CERP confirmé", key === "OPENING_RECEIVABLE" ? "CUSTOMER" : "SUPPLIER"));
catalogFor("CUSTOMER").fields.push(
  { key: "deliverySameAsBilling", label: "Adresse de livraison identique à l'adresse de facturation — vérifié", type: "boolean", required: false, group: "Adresses" },
  text("deliveryAddress", "Adresse de livraison confirmée", false, "Adresses"),
  text("deliveryPostalCode", "Code postal de livraison", false, "Adresses"),
  text("deliveryCity", "Ville de livraison", false, "Adresses"),
  text("deliveryCountry", "Pays de livraison", false, "Adresses"));
catalogFor("ARTICLE").fields.push(text("technicalPieceLegacyKey", "Clé source de la pièce technique à créer", false, "Rapprochement CERP"));
catalogFor("ARTICLE").fields.push(
  select("commercialScope", "Destination commerciale", ["CLIENTS", "CRP"], false),
  target("commercialClientTargetId", "Client CERP de l'article", "CUSTOMER"),
  text("commercialCustomerCode", "Code client d'origine de l'article", false, "Rapprochement CERP"),
);
catalogFor("ARTICLE").fields.find((field) => field.key === "commercialScope")!.required_when = [{ field: "category", value: "fabrique" }];
catalogFor("SUPPLIER_ORDER").fields.push({ ...number("vatRate", "TVA (%)", true, 2), max: 100 });
catalogFor("SUPPLIER_ORDER").fields.push(date("orderDate", "Date de la commande fournisseur d'origine"));
export const CUTOVER_CONTRIBUTABLE_DOMAINS: CutoverDomain[] = ["ARTICLE", "TECHNICAL_PIECE", "SALES_ORDER", "SUPPLIER_ORDER", "INTERNAL_DEMAND", "OPENING_STOCK", "WIP", "METROLOGY"];
catalogFor("SALES_ORDER").label = "Commandes / affaires à poursuivre";
catalogFor("SALES_ORDER").description = "Préparer une nouvelle commande CERP pour le reliquat, en conservant la commande et l'affaire anciennes comme références historiques. Les livraisons passées ne sont pas rejouées.";
catalogFor("SUPPLIER_ORDER").description = "Préparer un nouvel achat CERP pour le reste à réceptionner. Les réceptions passées et les dettes restent rapprochées séparément, sans double entrée en stock.";
catalogFor("INTERNAL_DEMAND").description = "Préparer un besoin interne CERP pour le reste à fabriquer, sans commande client fictive ni nouvelle fabrication des quantités déjà réalisées.";
for (const key of ["SALES_ORDER", "INTERNAL_DEMAND", "SUPPLIER_ORDER", "WIP"] as const) {
  const field = catalogFor(key).fields.find((item) => item.key === "affairNumber");
  if (field) field.hint = "Référence historique. Les nouveaux numéros de commande et d'affaire sont attribués par CERP lors de leur création ; ne pas recopier un ancien compteur.";
}
catalogFor("OPENING_STOCK").fields.splice(1, 0, { ...select("stockKind", "Nature du stock historique", ["PF", "MP"]), read_only: true });
catalogFor("OPENING_STOCK").fields.push(
  target("ownerTargetId", "Client propriétaire CERP confirmé", "CUSTOMER"),
  target("customerTargetId", "Client de la pièce finie CERP confirmé", "CUSTOMER"),
  text("ownerLegacyKey", "Clé source du client propriétaire", false, "Rapprochement CERP"),
  text("customerCode", "Code client d'origine", false),
  text("articleLegacyKey", "Clé source de la fiche article", false, "Rapprochement CERP")
);
for (const domain of CUTOVER_CATALOG) for (const field of domain.fields) {
  if (field.key === "technicalPieceId") { field.lookup_entity = "TECHNICAL_PIECE"; field.format = "uuid"; }
  if (field.key === "targetId" && ["CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE"].includes(domain.key)) {
    field.lookup_entity = domain.key as "CUSTOMER" | "SUPPLIER" | "ARTICLE" | "TECHNICAL_PIECE";
    if (domain.key !== "CUSTOMER") field.format = "uuid";
  }
}
// Historical display references stay intact. Confirm plan and external revision
// separately; an internal CERP version is never guessed from an old suffix.
for (const key of ["SALES_ORDER", "INTERNAL_DEMAND", "OPENING_STOCK", "WIP"] as const) {
  const fields = catalogFor(key).fields;
  fields.push({ ...text("planReference", "Référence du plan confirmée", key === "WIP"), group: "Identification technique", hint: "Référence distincte de l'indice. Conserver la référence brute de la source." });
  if (key === "WIP") {
    const revision = fields.find((field) => field.key === "technicalRevision")!;
    revision.label = "Indice externe utilisé";
    revision.group = "Identification technique";
    revision.max_length = 40;
  } else {
    fields.push({ ...text("externalRevision", "Indice externe confirmé", false), group: "Identification technique", max_length: 40, hint: "Ne pas déduire automatiquement une lettre finale. À confirmer sur le plan ou l'engagement client." });
    if (key === "OPENING_STOCK") fields.push({ key: "withoutRevision", label: "Plan explicitement sans indice", type: "boolean", required: false, group: "Identification technique" });
  }
}

// Historical review remains available, but an actual continuation is explicit
// and requires a confirmed physical cohort and a published technical version.
const nativeWip = [{ field: "resumeMode", value: "NATIVE_RESUME" }] as const;
const wipFields = catalogFor("WIP").fields;
const nativeWipField = (field: CutoverField): CutoverField => ({ ...field, required: false, required_when: [...nativeWip], group: "Poursuivre la fabrication" });
wipFields.unshift({ ...select("resumeMode", "Suite à donner à cet encours", ["REVIEW_ONLY", "NATIVE_RESUME"], false), hint: "Un dossier à compléter reste un état d'ouverture. La reprise native prépare un OF pour les seules pièces encore en fabrication." });
wipFields.push(
  nativeWipField({ ...text("historicalVersionId", "Version technique utilisée"), format: "uuid", lookup_entity: "TECHNICAL_VERSION", hint: "Choisir la version publiée correspondant au plan et à l'indice réellement utilisés, même si elle est devenue obsolète." }),
  nativeWipField({ ...text("physicalBatchReference", "Groupe physique encore en fabrication"), hint: "Référence unique de ce groupe de pièces, distincte du numéro de lot matière. Séparer les groupes si leur avancement ou leur matière diffère." }),
  nativeWipField(unit()),
  { key: "previousOperationsConfirmed", label: "Toute cette cohorte a franchi les phases précédentes", type: "boolean", required: false, group: "Poursuivre la fabrication", hint: "À confirmer lorsqu'il existe des phases précédentes. Séparer les groupes si leur avancement diffère." },
  { ...text("affairTargetId", "Commande CERP à poursuivre", false, "Rapprochement CERP"), lookup_entity: "NATIVE_ORDER", pattern: "^[1-9][0-9]{0,14}$", hint: "Rapprochement SuperAdmin avec la commande ou le besoin interne déjà créé dans CERP." },
  { ...text("commandeLigneId", "Ligne de commande CERP", false, "Rapprochement CERP"), lookup_entity: "NATIVE_ORDER_LINE", pattern: "^[1-9][0-9]{0,14}$", hint: "Choisir la ligne de la pièce réellement reprise, après préparation de la commande." },
  { ...text("livraisonAffaireId", "Affaire de livraison CERP", false, "Rapprochement CERP"), lookup_entity: "DELIVERY_AFFAIR", pattern: "^[1-9][0-9]{0,14}$", hint: "Choisir l'affaire affectée à cette ligne de commande. Aucun nouveau numéro historique n'est inventé." },
  { ...text("materialOpening", "État matière confirmé", false), required_when: [...nativeWip], max_length: 8000, group: "Matière déjà utilisée", hint: "Renseigner les matières déjà consommées par exigence et par lot, sans créer de sortie de stock supplémentaire." },
  { key: "withoutRevision", label: "Plan utilisé explicitement sans indice", type: "boolean", required: false, group: "Identification technique" },
);
wipFields.find((field) => field.key === "technicalRevision")!.required = false;
wipFields.find((field) => field.key === "quantityRemaining")!.hint = "Uniquement les pièces physiques encore en cours dans ce groupe. Les pièces finies en OLD et les rebuts historiques sont renseignés séparément.";
// Match native persisted precision: never allow PostgreSQL to silently round a
// preparation quantity or price during a later qualified business posting.
for (const key of ["SALES_ORDER", "INTERNAL_DEMAND", "SUPPLIER_ORDER", "WIP", "LEGACY_DELIVERY", "LEGACY_RECEIPT"] as const) {
  for (const field of catalogFor(key).fields) {
    if (field.type === "number" && /^(quantity|stockReserved|scrapQuantity)/.test(field.key)) {
      field.precision = 3;
      field.max = key === "WIP" ? 9_999_999_999.999 : key === "SUPPLIER_ORDER" ? 99999999999 : 999999999;
      if (field.key === "quantityOrdered" || field.key === "quantity") field.min = 0.001;
    }
    if (field.key === "unitPrice") { field.precision = key === "SUPPLIER_ORDER" ? 4 : 2; field.max = 9999999999; }
    if (field.key === "vatRate") field.precision = 2;
  }
}

// The same sheet supports a confirmed native link and a new native draft.
// Required CREATE fields must remain visible without forcing their re-entry for LINK.
for (const domain of ["CUSTOMER", "SUPPLIER", "ARTICLE", "TECHNICAL_PIECE"] as const) {
  for (const field of catalogFor(domain).fields) {
    if (field.key === "targetId") field.required_when = [{ field: "resolution", value: "LINK" }];
    else if (field.required && !["resolution", "customerCode", "supplierCode", "articleReference"].includes(field.key)) field.required_when = [{ field: "resolution", value: "CREATE" }];
  }
}
for (const key of ["name", "country", "address", "postalCode", "city", "creationDate", "deliverySameAsBilling"]) {
  const field = catalogFor("CUSTOMER").fields.find((item) => item.key === key)!;
  field.required_when = [{ field: "resolution", value: "CREATE" }];
}
for (const key of ["deliveryAddress", "deliveryPostalCode", "deliveryCity", "deliveryCountry"]) {
  const field = catalogFor("CUSTOMER").fields.find((item) => item.key === key)!;
  field.required_when = [{ field: "resolution", value: "CREATE" }, { field: "deliverySameAsBilling", value: false }];
}
