import type { ImportDecisionGate, ImportEntityCapability, ImportTargetField } from "../types/import-assistant.types";

const DECISIONS: Record<string, ImportDecisionGate> = {
  "DEC-01": { id: "DEC-01", label: "Mapping CODENATURE vers les catégories CERP", responsible: "Méthodes + Achats", evidence: "Échantillon d’articles validé" },
  "DEC-02": { id: "DEC-02", label: "Référence plan et indice des pièces", responsible: "Méthodes", evidence: "Plans et documents vérifiés" },
  "DEC-03": { id: "DEC-03", label: "Domaines et types fournisseurs", responsible: "Achats", evidence: "Activité, commandes et articles vérifiés" },
  "DEC-04": { id: "DEC-04", label: "Clients actifs à enrichir en priorité", responsible: "Commerce", evidence: "Top clients et activité récente" },
  "DEC-05": { id: "DEC-05", label: "Magasins et emplacements d’ouverture", responsible: "Production + Stock", evidence: "Plan d’implantation" },
  "DEC-06": { id: "DEC-06", label: "Date de cut-off de l’inventaire", responsible: "Direction + Stock", evidence: "PV de bascule" },
  "DEC-07": { id: "DEC-07", label: "Inventaire des machines CNC et de leur état", responsible: "Production + Maintenance", evidence: "Fiches terrain" },
  "DEC-09": { id: "DEC-09", label: "Salariés actifs et correspondances utilisateurs", responsible: "RH", evidence: "Liste du personnel actuelle" },
  "DEC-12": { id: "DEC-12", label: "Conservation des données RH", responsible: "RH + RGPD", evidence: "Politique de rétention" },
  "DEC-13": { id: "DEC-13", label: "Sort des BL historiques et ouverts", responsible: "Commerce + Logistique", evidence: "Liste des BL réellement ouverts" },
  "DEC-14": { id: "DEC-14", label: "Champs CLIPPER absents de CERP", responsible: "Product Owner", evidence: "Backlog extension ou archive" },
  "DEC-15": { id: "DEC-15", label: "Spécification de l’assistant d’import", responsible: "Product + Architecture + Sécurité", evidence: "Issues #301 et #167" },
  "DEC-16": { id: "DEC-16", label: "Flux article fabriqué vers réception et stock", responsible: "Production + Qualité + Stock", evidence: "Test E2E pilote" },
};

const field = (
  key: string,
  label: string,
  kind: ImportTargetField["kind"],
  options: Omit<ImportTargetField, "key" | "label" | "kind"> = {}
): ImportTargetField => ({ key, label, kind, ...options });

const commonOptional = {
  email: field("email", "E-mail", "text"),
  phone: field("phone", "Téléphone", "text"),
  notes: field("notes", "Notes", "text", { sensitive: true }),
};

const CLIENT_FIELDS: ImportTargetField[] = [
  field("company_name", "Raison sociale", "text", { required: true }),
  commonOptional.email,
  commonOptional.phone,
  field("website_url", "Site internet", "text"),
  field("siret", "SIRET", "text"),
  field("vat_number", "N° TVA", "text"),
  field("naf_code", "Code NAF", "text"),
  field("status", "Statut", "enum", { required: true, values: ["prospect", "client", "inactif"] }),
  field("blocked", "Bloqué", "boolean", { required: true }),
  field("reason", "Motif de blocage", "text"),
  field("creation_date", "Date de création", "date", { required: true }),
  field("bill_address.name", "Nom adresse de facturation", "text", { required: true }),
  field("bill_address.street", "Rue de facturation", "text", { required: true }),
  field("bill_address.house_number", "N° de facturation", "text"),
  field("bill_address.address_complement", "Complément de facturation", "text"),
  field("bill_address.postal_code", "Code postal de facturation", "text", { required: true }),
  field("bill_address.city", "Ville de facturation", "text", { required: true }),
  field("bill_address.country", "Pays de facturation", "text", { required: true }),
  field("delivery_address.name", "Nom adresse de livraison", "text", { required: true }),
  field("delivery_address.street", "Rue de livraison", "text", { required: true }),
  field("delivery_address.house_number", "N° de livraison", "text"),
  field("delivery_address.address_complement", "Complément de livraison", "text"),
  field("delivery_address.postal_code", "Code postal de livraison", "text", { required: true }),
  field("delivery_address.city", "Ville de livraison", "text", { required: true }),
  field("delivery_address.country", "Pays de livraison", "text", { required: true }),
  field("observations", "Observations", "text", { sensitive: true }),
  field("devise", "Devise ISO", "text"),
  field("encours_max", "Encours maximum", "number", { sensitive: true }),
  field("incoterm", "Incoterm", "enum", { values: ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"] }),
  field("langue", "Langue ISO", "text"),
];

const CLIENT_ENRICHISSEMENT_FIELDS: ImportTargetField[] = [
  field("company_name", "Raison sociale", "text", {
    required: true,
    hint: "Sert aussi au rapprochement exact si la correspondance CLIPPER historique manque",
  }),
  commonOptional.email,
  commonOptional.phone,
  field("website_url", "Site internet", "text"),
  field("siret", "SIRET", "text"),
  field("vat_number", "N° TVA", "text"),
  field("naf_code", "Code NAF", "text"),
  field("status", "Statut", "enum", { values: ["prospect", "client", "inactif"] }),
  field("blocked", "Bloqué", "boolean"),
  field("reason", "Motif de blocage", "text"),
  field("bill_address.name", "Nom adresse de facturation", "text"),
  field("bill_address.street", "Rue de facturation", "text"),
  field("bill_address.house_number", "N° de facturation", "text"),
  field("bill_address.address_complement", "Complément de facturation", "text"),
  field("bill_address.postal_code", "Code postal de facturation", "text"),
  field("bill_address.city", "Ville de facturation", "text"),
  field("bill_address.country", "Pays de facturation", "text"),
  field("delivery_address.name", "Nom adresse de livraison", "text"),
  field("delivery_address.street", "Rue de livraison", "text"),
  field("delivery_address.house_number", "N° de livraison", "text"),
  field("delivery_address.address_complement", "Complément de livraison", "text"),
  field("delivery_address.postal_code", "Code postal de livraison", "text"),
  field("delivery_address.city", "Ville de livraison", "text"),
  field("delivery_address.country", "Pays de livraison", "text"),
  field("observations", "Observations", "text", { sensitive: true }),
  field("devise", "Devise ISO", "text"),
  field("encours_max", "Encours maximum", "number", { sensitive: true }),
  field("incoterm", "Incoterm", "enum", { values: ["EXW", "FCA", "CPT", "CIP", "DAP", "DPU", "DDP", "FAS", "FOB", "CFR", "CIF"] }),
  field("langue", "Langue ISO", "text"),
  field("compte_tiers", "Compte tiers", "text"),
  field("groupe_financier", "Groupe financier", "text"),
];

const CLIENT_CONTACT_FIELDS: ImportTargetField[] = [
  field("client_legacy_code", "Code client CLIPPER", "text", {
    required: true,
    hint: "Le client doit avoir été rapproché avant ses contacts",
  }),
  field("first_name", "Prénom", "text", { required: true }),
  field("last_name", "Nom", "text", { required: true }),
  field("email", "E-mail", "text", { required: true, sensitive: true }),
  field("phone_direct", "Téléphone direct", "text", { sensitive: true }),
  field("phone_personal", "Téléphone secondaire", "text", { sensitive: true }),
  field("role", "Fonction", "text"),
  field("civility", "Civilité", "enum", { values: ["Madame", "Monsieur"] }),
  field("set_primary", "Contact principal", "boolean"),
];

const FOURNISSEUR_FIELDS: ImportTargetField[] = [
  field("nom", "Raison sociale", "text", { required: true }),
  field("actif", "Actif", "boolean"),
  field("status", "Statut", "enum", { values: ["actif", "a_completer", "inactif", "archive"] }),
  field("type_principal", "Type principal", "text"),
  field("domaines", "Domaines fournisseurs", "list", { hint: "Codes séparés par ;" }),
  field("tva", "N° TVA", "text"),
  field("siret", "SIRET", "text"),
  commonOptional.email,
  field("telephone", "Téléphone", "text"),
  field("site_web", "Site internet", "text"),
  field("nom_commercial", "Nom commercial", "text"),
  commonOptional.notes,
  field("adresse.type", "Type d’adresse", "enum", { values: ["commande", "livraison", "facturation"] }),
  field("adresse.label", "Libellé d’adresse", "text"),
  field("adresse.ligne1", "Adresse", "text"),
  field("adresse.ligne2", "Complément d’adresse", "text"),
  field("adresse.house_no", "N°", "text"),
  field("adresse.postcode", "Code postal", "text"),
  field("adresse.city", "Ville", "text"),
  field("adresse.country", "Pays", "text"),
];

const ARTICLE_FIELDS: ImportTargetField[] = [
  field("designation", "Désignation", "text", { required: true }),
  field("designation_secondary", "Désignation secondaire", "text"),
  field("article_category", "Catégorie", "enum", { required: true, values: ["fabrique", "matiere", "traitement", "achat"] }),
  field("article_categories", "Catégories métier", "list", { hint: "Valeurs séparées par ;" }),
  field("family_code", "Code famille CERP", "text", { required: true }),
  field("status", "Statut", "enum", { values: ["EN_DEVIS", "VALIDE"] }),
  field("stock_managed", "Géré en stock", "boolean"),
  field("piece_technique_id", "ID pièce technique CERP", "uuid", { hint: "Obligatoire pour un article fabriqué" }),
  field("unite", "Unité", "text"),
  field("lot_tracking", "Suivi par lot", "boolean"),
  field("is_sold", "Vendu", "boolean"),
  field("is_active", "Actif", "boolean"),
  commonOptional.notes,
];

const PIECE_FIELDS: ImportTargetField[] = [
  field("client_id", "Code client CERP", "text", { required: true }),
  field("famille_id", "Famille de pièce CERP", "uuid", { required: true }),
  field("name_piece", "Nom de pièce", "text", { required: true }),
  field("designation", "Désignation", "text", { required: true }),
  field("designation_2", "Désignation secondaire", "text"),
  field("plan_reference", "Référence plan", "text", { required: true }),
  field("indice_externe", "Indice externe", "text"),
  field("sans_indice", "Sans indice", "boolean"),
  field("motif_modification", "Motif de création", "text"),
  field("date_effet", "Date d’effet", "date"),
  field("prix_unitaire", "Prix unitaire", "number", { sensitive: true }),
  field("statut", "Statut", "enum", { values: ["DRAFT", "ACTIVE", "IN_FABRICATION", "OBSOLETE"] }),
  field("cycle", "Cycle", "number"),
  field("cycle_fabrication", "Cycle de fabrication", "number"),
  field("ensemble", "Ensemble", "boolean"),
];

const MACHINE_FIELDS: ImportTargetField[] = [
  field("name", "Nom de la machine", "text", { required: true }),
  field("type", "Type", "enum", { required: true, values: ["MILLING", "TURNING", "EDM", "GRINDING", "OTHER"] }),
  field("display_name", "Nom affiché", "text"),
  field("brand", "Marque", "text"),
  field("model", "Modèle", "text"),
  field("serial_number", "N° de série", "text"),
  field("commissioned_year", "Année de mise en service", "number"),
  field("status", "État", "enum", { values: ["ACTIVE", "IN_MAINTENANCE", "OUT_OF_SERVICE"] }),
  field("scheduling_enabled", "Planifiable", "boolean"),
  field("outillage_enabled", "Outillage activé", "boolean"),
  field("location", "Emplacement", "text"),
  field("workshop_zone", "Zone atelier", "text"),
  commonOptional.notes,
];

export const IMPORT_CAPABILITIES: ImportEntityCapability[] = [
  { entity_type: "CLIENT", label: "1A — Clients (création)", order: 10, confirm_enabled: true, unavailable_reason: null, fields: CLIENT_FIELDS, decisions: [DECISIONS["DEC-04"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "CLIENT_ENRICHISSEMENT", label: "1B — Clients (compléter les fiches)", order: 11, confirm_enabled: true, unavailable_reason: null, fields: CLIENT_ENRICHISSEMENT_FIELDS, decisions: [DECISIONS["DEC-04"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "CLIENT_CONTACT", label: "1C — Contacts clients", order: 12, confirm_enabled: true, unavailable_reason: null, fields: CLIENT_CONTACT_FIELDS, decisions: [DECISIONS["DEC-04"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "FOURNISSEUR", label: "2 — Fournisseurs", order: 20, confirm_enabled: true, unavailable_reason: null, fields: FOURNISSEUR_FIELDS, decisions: [DECISIONS["DEC-03"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "ARTICLE", label: "4 — Articles et matières achetés", order: 40, confirm_enabled: true, unavailable_reason: null, fields: ARTICLE_FIELDS, decisions: [DECISIONS["DEC-01"], DECISIONS["DEC-14"], DECISIONS["DEC-15"], DECISIONS["DEC-16"]] },
  { entity_type: "MACHINE", label: "5 — Machines CNC", order: 50, confirm_enabled: true, unavailable_reason: null, fields: MACHINE_FIELDS, decisions: [DECISIONS["DEC-07"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "STOCK_INITIAL", label: "6 — Stock d’ouverture", order: 60, confirm_enabled: false, unavailable_reason: "Le stock doit passer par un inventaire ou des mouvements d’ouverture contrôlés ; les magasins, emplacements et le cut-off doivent être renseignés.", fields: [], decisions: [DECISIONS["DEC-05"], DECISIONS["DEC-06"], DECISIONS["DEC-15"], DECISIONS["DEC-16"]] },
  { entity_type: "BL_HISTORIQUE", label: "7 — BL historiques", order: 70, confirm_enabled: false, unavailable_reason: "Le sort des BL ouverts et historiques doit être décidé avant toute écriture.", fields: [], decisions: [DECISIONS["DEC-13"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
  { entity_type: "EMPLOYE", label: "8 — Salariés", order: 80, confirm_enabled: false, unavailable_reason: "L’import RH reste fermé tant que le périmètre, les correspondances utilisateurs et la rétention ne sont pas documentés.", fields: [], decisions: [DECISIONS["DEC-09"], DECISIONS["DEC-12"], DECISIONS["DEC-15"]] },
  { entity_type: "PIECE_TECHNIQUE", label: "9 — Pièces techniques (dernière étape)", order: 90, confirm_enabled: true, unavailable_reason: null, fields: PIECE_FIELDS, decisions: [DECISIONS["DEC-02"], DECISIONS["DEC-14"], DECISIONS["DEC-15"]] },
];

export function getImportCapability(entityType: string): ImportEntityCapability | null {
  return IMPORT_CAPABILITIES.find((capability) => capability.entity_type === entityType) ?? null;
}
