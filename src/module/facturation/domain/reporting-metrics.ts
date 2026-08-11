// Reporting commercial 360 (#275) — catalogue de métriques versionné.
//
// Chaque indicateur affiché quelque part dans le CERP doit exister ici, avec sa
// définition, sa formule, sa source autoritaire, sa base de date et ses exclusions.
// Un indicateur absent du catalogue ne doit pas être rendu : c'est la règle qui
// empêche de réinventer un « chiffre d'affaires » au fil des écrans.
//
// La version évolue dès qu'une formule, un périmètre ou une exclusion change.
// Elle est renvoyée dans l'enveloppe de chaque réponse et affichée à l'écran.

import {
  AVOIR_EXCLUDED_STATUSES,
  AVOIR_LEDGER_STATUSES,
  BL_DELIVERED_STATUSES,
  BL_SHIPPED_STATUSES,
  DEVIS_DECIDED_STATUSES,
  DEVIS_OPEN_STATUSES,
  FACTURE_EXCLUDED_STATUSES,
  FACTURE_LEDGER_STATUSES,
  PAIEMENT_EXCLUDED_STATUSES,
  REPORTING_TIMEZONE,
} from "./reporting-policy";

export const METRIC_CATALOG_VERSION = "2026.07.26-1";

export type MetricFamily =
  | "devis"
  | "commandes"
  | "livraisons"
  | "facturation"
  | "encaissement"
  | "clients"
  | "qualite_donnees";

export type MetricUnit = "currency" | "count" | "ratio" | "days";

export type MetricAvailability = "available" | "deferred";

export type MetricDefinition = {
  /** Identifiant stable — ne change jamais, même si le libellé change. */
  id: string;
  family: MetricFamily;
  label: string;
  definition: string;
  formula: string;
  numerator?: string;
  denominator?: string;
  /** Tables et colonnes autoritaires. */
  sources: string[];
  /** Grain élémentaire du calcul. */
  grain: string;
  /** Champ de date qui fait entrer une ligne dans la période. */
  date_field: string;
  statuses_included: readonly string[];
  statuses_excluded: readonly string[];
  cancellation: string;
  credit_notes: string;
  currency: string;
  /** HT, TTC ou sans objet. */
  tax_basis: "HT" | "TTC" | "HT+TTC" | "N/A";
  timezone: string;
  as_of: string;
  refresh: string;
  unit: MetricUnit;
  owner: string;
  availability: MetricAvailability;
  /** Limites connues, écarts assumés, pièges d'interprétation. */
  limitations: string[];
};

const COMMON = {
  currency: "Partitionné par devise. Aucun total inter-devises (pas de table de taux datés).",
  timezone: REPORTING_TIMEZONE,
  refresh: "Temps réel (agrégat SQL à la demande, aucune matérialisation).",
} as const;

const CATALOG: MetricDefinition[] = [
  // -------------------------------------------------------------------------
  // Devis
  // -------------------------------------------------------------------------
  {
    id: "quotes.issued.count",
    family: "devis",
    label: "Devis créés",
    definition:
      "Nombre de devis dont la date de création tombe dans la période, hors brouillons et hors devis annulés.",
    formula: "COUNT(devis) WHERE date_creation ∈ [from, to] AND statut ∉ {BROUILLON, ANNULE}",
    sources: ["devis.id", "devis.date_creation", "devis.statut"],
    grain: "Un devis (en-tête).",
    date_field: "devis.date_creation (timestamp sans fuseau, interprété comme heure locale atelier)",
    statuses_included: ["ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE"],
    statuses_excluded: ["BROUILLON", "ANNULE"],
    cancellation: "Les devis ANNULE sont exclus du numérateur et du dénominateur.",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet (métrique de flux sur la période).",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "`devis.date_creation` est un `timestamp without time zone` : il est lu tel quel, sans conversion de fuseau.",
      "Il n'existe aucune date d'envoi historisée : « créé » n'est pas « envoyé ».",
    ],
  },
  {
    id: "quotes.issued.amount_ht",
    family: "devis",
    label: "Montant devisé HT",
    definition: "Somme des totaux HT des devis créés sur la période, hors brouillons et annulés.",
    formula: "SUM(devis.total_ht) sur le même périmètre que quotes.issued.count",
    sources: ["devis.total_ht"],
    grain: "Un devis (en-tête).",
    date_field: "devis.date_creation",
    statuses_included: ["ENVOYE", "ACCEPTE", "REFUSE", "EXPIRE"],
    statuses_excluded: ["BROUILLON", "ANNULE"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: "Le devis ne porte pas de colonne devise ; la devise du client fait foi (clients.devise).",
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "Un devis révisé (V2, V3…) est une ligne distincte : la somme des montants d'une racine de devis surestime l'opportunité réelle. La ventilation par version est disponible via `devis.root_devis_id`.",
    ],
  },
  {
    id: "quotes.decision_rate",
    family: "devis",
    label: "Taux de décision",
    definition:
      "Part des devis de la cohorte qui portent aujourd'hui une décision explicite (accepté ou refusé).",
    formula: "quotes.decided.count / quotes.issued.count",
    numerator: "Devis de la cohorte dont le statut courant ∈ {ACCEPTE, REFUSE}",
    denominator: "Devis de la cohorte (hors BROUILLON, ANNULE)",
    sources: ["devis.statut"],
    grain: "Cohorte = devis créés dans la période.",
    date_field: "devis.date_creation (date de cohorte, pas date de décision)",
    statuses_included: DEVIS_DECIDED_STATUSES,
    statuses_excluded: ["BROUILLON", "ANNULE"],
    cancellation: "Exclus du numérateur et du dénominateur.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "État courant observé au moment de la requête — ce n'est PAS un état historisé.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "`devis_historique` et `devis_etat_suivi` existent en base mais ne sont écrits par aucun code : il n'y a aucune date de décision.",
      "Le taux d'une cohorte récente est mécaniquement bas (les décisions n'ont pas encore eu lieu).",
    ],
  },
  {
    id: "quotes.win_rate",
    family: "devis",
    label: "Taux de succès",
    definition: "Part des devis décidés de la cohorte qui ont été acceptés.",
    formula: "COUNT(statut = ACCEPTE) / COUNT(statut ∈ {ACCEPTE, REFUSE})",
    numerator: "Devis acceptés de la cohorte",
    denominator: "Devis décidés de la cohorte",
    sources: ["devis.statut"],
    grain: "Cohorte = devis créés dans la période.",
    date_field: "devis.date_creation",
    statuses_included: ["ACCEPTE", "REFUSE"],
    statuses_excluded: ["BROUILLON", "ANNULE", "ENVOYE", "EXPIRE"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "État courant observé.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "Le dénominateur exclut les devis sans décision : le taux ne descend pas quand le portefeuille dort.",
    ],
  },
  {
    id: "quotes.open.amount_ht",
    family: "devis",
    label: "Portefeuille ouvert HT",
    definition:
      "Montant HT des devis actuellement au statut ENVOYE, sans pondération de probabilité.",
    formula: "SUM(devis.total_ht) WHERE statut = 'ENVOYE'",
    sources: ["devis.total_ht", "devis.statut", "devis.date_validite"],
    grain: "Un devis.",
    date_field: "Aucun — photographie de l'état courant.",
    statuses_included: DEVIS_OPEN_STATUSES,
    statuses_excluded: ["BROUILLON", "ACCEPTE", "REFUSE", "EXPIRE", "ANNULE"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "État courant.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "Aucune pondération par probabilité : le CERP ne stocke aucune probabilité, en inventer une fabriquerait un pipeline faux.",
      "Un devis dont `date_validite` est dépassée reste ENVOYE tant que personne ne le requalifie ; il est signalé à part comme « périmé, non requalifié ».",
    ],
  },
  {
    id: "quotes.decision_lead_time",
    family: "devis",
    label: "Délai de décision",
    definition: "Délai entre l'envoi d'un devis et la décision du client.",
    formula: "Indisponible.",
    sources: [],
    grain: "Un devis.",
    date_field: "Aucune date d'envoi ni de décision historisée.",
    statuses_included: [],
    statuses_excluded: [],
    cancellation: "Sans objet.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: "Sans objet.",
    unit: "days",
    owner: "Direction commerciale",
    availability: "deferred",
    limitations: [
      "Bloquant : `devis_historique` (ancien_statut, nouveau_statut, date_action) n'est écrit par aucun code du backend.",
      "`devis.updated_at` est réécrit à chaque modification : ce n'est pas une date de décision.",
      "Livrable dès que les transitions de devis seront journalisées.",
    ],
  },

  // -------------------------------------------------------------------------
  // Commandes et carnet
  // -------------------------------------------------------------------------
  {
    id: "orders.booked.count",
    family: "commandes",
    label: "Commandes prises",
    definition: "Nombre de commandes client dont la date de commande tombe dans la période.",
    formula: "COUNT(commande_client) WHERE date_commande ∈ [from, to]",
    sources: ["commande_client.id", "commande_client.date_commande", "commande_client.order_type"],
    grain: "Une commande (en-tête).",
    date_field: "commande_client.date_commande (date)",
    statuses_included: ["FERME", "CADRE", "INTERNE (compté à part)"],
    statuses_excluded: [],
    cancellation:
      "`commande_client` ne porte AUCUNE colonne de statut : une commande annulée n'est pas distinguable en base.",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "ADV",
    availability: "available",
    limitations: [
      "Les commandes internes (`order_type = 'INTERNE'`) sont comptées séparément et jamais additionnées au commercial.",
      "Absence de statut d'en-tête : le carnet ne peut pas être déduit d'un statut, il est calculé sur les quantités de lignes.",
    ],
  },
  {
    id: "orders.booked.amount_ht",
    family: "commandes",
    label: "Montant commandé HT",
    definition: "Somme des totaux HT des commandes prises sur la période, hors commandes internes.",
    formula: "SUM(commande_client.total_ht) WHERE date_commande ∈ [from, to] AND order_type <> 'INTERNE'",
    sources: ["commande_client.total_ht"],
    grain: "Une commande.",
    date_field: "commande_client.date_commande",
    statuses_included: ["FERME", "CADRE"],
    statuses_excluded: ["INTERNE"],
    cancellation: "Non distinguable (voir orders.booked.count).",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "ADV",
    availability: "available",
    limitations: [
      "Une commande CADRE porte un engagement global ; ses appels de livraison sont dans `commande_cadre_release`. Le montant d'en-tête peut donc précéder l'engagement ferme.",
    ],
  },
  {
    id: "orders.backlog.amount_ht",
    family: "commandes",
    label: "Carnet de commandes HT",
    definition:
      "Valeur HT restant à livrer, calculée ligne par ligne : (quantité commandée − quantité expédiée) × prix unitaire net.",
    formula:
      "SUM(GREATEST(cl.quantite - expediee, 0) * cl.prix_unitaire_ht * (1 - COALESCE(cl.remise_ligne,0)/100))",
    sources: [
      "commande_ligne.quantite",
      "commande_ligne.prix_unitaire_ht",
      "commande_ligne.remise_ligne",
      "bon_livraison_ligne.quantite",
      "bon_livraison.statut",
    ],
    grain: "Une ligne de commande.",
    date_field: "Aucun — photographie de l'état courant (ou à `as_of` via la date d'expédition).",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "CANCELLED"],
    cancellation: "Un BL annulé ne consomme pas la commande (aligné sur `v_bon_livraison_reliquats_226`).",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Les expéditions retenues sont celles dont la date d'expédition est ≤ as_of.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "ADV",
    availability: "available",
    limitations: [
      "Le carnet repose sur les quantités de lignes, jamais sur un statut d'en-tête.",
      "Une commande sans ligne (saisie incomplète) pèse zéro et est signalée en qualité de données.",
    ],
  },
  {
    id: "orders.overdue_lines.count",
    family: "commandes",
    label: "Lignes en retard",
    definition:
      "Lignes de commande dont le délai client est dépassé à la date d'arrêté et dont la quantité restante est strictement positive.",
    formula: "COUNT(commande_ligne) WHERE delai_client < as_of AND quantite_restante > 0",
    sources: ["commande_ligne.delai_client", "commande_ligne.quantite", "bon_livraison_ligne.quantite"],
    grain: "Une ligne de commande.",
    date_field: "commande_ligne.delai_client",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["CANCELLED"],
    cancellation: "Sans objet.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Comparaison stricte au jour d'arrêté, en Europe/Paris.",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "ADV",
    availability: "available",
    limitations: [
      "Une ligne sans `delai_client` n'est jamais comptée en retard (elle est signalée comme non échéancée).",
    ],
  },

  // -------------------------------------------------------------------------
  // Livraisons
  // -------------------------------------------------------------------------
  {
    id: "deliveries.shipped.count",
    family: "livraisons",
    label: "BL expédiés",
    definition: "Bons de livraison expédiés sur la période.",
    formula: "COUNT(bon_livraison) WHERE statut ∈ {SHIPPED, DELIVERED} AND date_expedition ∈ [from, to]",
    sources: ["bon_livraison.statut", "bon_livraison.date_expedition"],
    grain: "Un bon de livraison.",
    date_field: "bon_livraison.date_expedition",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "CANCELLED"],
    cancellation: "Les BL annulés sont exclus.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "Logistique",
    availability: "available",
    limitations: [
      "Un BL expédié sans `date_expedition` renseignée est exclu de la période et signalé en qualité de données.",
    ],
  },
  {
    id: "deliveries.delivered.count",
    family: "livraisons",
    label: "BL livrés",
    definition: "Bons de livraison réceptionnés côté client sur la période.",
    formula: "COUNT(bon_livraison) WHERE statut = 'DELIVERED' AND date_livraison ∈ [from, to]",
    sources: ["bon_livraison.statut", "bon_livraison.date_livraison"],
    grain: "Un bon de livraison.",
    date_field: "bon_livraison.date_livraison",
    statuses_included: BL_DELIVERED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "SHIPPED", "CANCELLED"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "Logistique",
    availability: "available",
    limitations: [],
  },
  {
    id: "deliveries.shipped.amount_ht",
    family: "livraisons",
    label: "Valeur expédiée HT",
    definition:
      "Valeur HT des quantités expédiées, valorisée au prix de la ligne de commande d'origine.",
    formula: "SUM(bll.quantite * cl.prix_unitaire_ht * (1 - COALESCE(cl.remise_ligne,0)/100))",
    sources: ["bon_livraison_ligne.quantite", "bon_livraison_ligne.commande_ligne_id", "commande_ligne.prix_unitaire_ht"],
    grain: "Une ligne de BL rattachée à une ligne de commande.",
    date_field: "bon_livraison.date_expedition",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "CANCELLED"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Logistique",
    availability: "available",
    limitations: [
      "Une ligne de BL sans `commande_ligne_id` (livraison hors commande) ne peut pas être valorisée : elle est comptée en quantité et signalée comme non valorisable.",
    ],
  },
  {
    id: "deliveries.on_time_rate",
    family: "livraisons",
    label: "Taux de livraison à l'heure",
    definition:
      "Part des lignes expédiées dont la date d'expédition est ≤ au délai client contractuel de la ligne de commande.",
    formula: "COUNT(date_expedition <= delai_client) / COUNT(lignes expédiées avec delai_client)",
    numerator: "Lignes expédiées à l'heure",
    denominator: "Lignes expédiées disposant d'un délai client",
    sources: ["bon_livraison.date_expedition", "commande_ligne.delai_client"],
    grain: "Une ligne de BL.",
    date_field: "bon_livraison.date_expedition",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "CANCELLED"],
    cancellation: "Exclus.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Logistique",
    availability: "available",
    limitations: [
      "C'est un taux « à l'heure » à la LIGNE, distinct de l'OTIF commande défini par le contrat Direction `direction-dashboard/1.0`.",
      "Les lignes sans `delai_client` sortent du dénominateur et sont comptées séparément.",
    ],
  },
  {
    id: "deliveries.otif_rate",
    family: "livraisons",
    label: "OTIF",
    definition:
      "Part des commandes dont chaque ligne atteint cumulativement la quantité commandée au plus tard à son délai client.",
    formula:
      "COUNT(commandes dont toutes les lignes sont complètes à delai_client) / COUNT(commandes échues dont toutes les lignes ont delai_client)",
    sources: [
      "commande_client",
      "commande_ligne.delai_client",
      "bon_livraison",
      "bon_livraison_ligne",
    ],
    grain: "Une commande.",
    date_field: "MAX(commande_ligne.delai_client) au grain commande.",
    statuses_included: BL_SHIPPED_STATUSES,
    statuses_excluded: ["DRAFT", "READY", "CANCELLED"],
    cancellation: "Les BL annulés sont exclus ; les commandes internes sont exclues.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Date d'arrêté de la requête Direction.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Logistique",
    availability: "deferred",
    limitations: [
      "Cette entrée reste différée uniquement dans le payload `/reporting/commercial/v2`; l'OTIF autoritaire est exposé par `/reporting/direction/overview`.",
      "Fiabilité PARTIAL pour l'historique : les révisions de `commande_ligne.delai_client` ne sont pas historisées au grain ligne.",
      "Les retours ne réécrivent pas l'OTIF faute de relation autoritaire retour-livraison.",
    ],
  },

  // -------------------------------------------------------------------------
  // Facturation
  // -------------------------------------------------------------------------
  {
    id: "invoicing.gross.amount_ht",
    family: "facturation",
    label: "Facturé brut HT",
    definition: "Somme HT des factures entrées au registre sur la période.",
    formula: "SUM(facture.total_ht) WHERE statut ∈ registre AND date_registre ∈ [from, to]",
    sources: ["facture.total_ht", "facture.statut", "facture.date_emission", "facture.issued_at"],
    grain: "Une facture.",
    date_field: "facture.date_emission (défaut) ou issued_at converti en date Europe/Paris",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Les factures CANCELLED / annulee / annule sont exclues, sans exception.",
    credit_notes: "Non déduits (voir invoicing.net.amount_ht).",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet (métrique de flux).",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Ce n'est PAS un chiffre d'affaires comptable : aucun rattachement à l'exercice, aucune validation d'un expert-comptable, aucun retraitement de coupure.",
    ],
  },
  {
    id: "invoicing.credits.amount_ht",
    family: "facturation",
    label: "Avoirs émis HT",
    definition: "Somme HT des avoirs finalisés entrés au registre sur la période.",
    formula: "SUM(avoir.total_ht) WHERE statut ∈ registre AND date_registre ∈ [from, to]",
    sources: ["avoir.total_ht", "avoir.statut", "avoir.date_emission", "avoir.issued_at"],
    grain: "Un avoir.",
    date_field: "avoir.date_emission (défaut) ou issued_at converti en date Europe/Paris",
    statuses_included: AVOIR_LEDGER_STATUSES,
    statuses_excluded: AVOIR_EXCLUDED_STATUSES,
    cancellation: "Les avoirs annulés sont exclus.",
    credit_notes: "C'est la métrique des avoirs elle-même.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Un avoir peut porter sur une facture d'une période antérieure : le facturé net d'une période peut donc être négatif. C'est correct, ce n'est pas une anomalie.",
    ],
  },
  {
    id: "invoicing.net.amount_ht",
    family: "facturation",
    label: "Facturé net HT",
    definition: "Facturé brut HT diminué des avoirs finalisés HT, sur la même période et le même périmètre.",
    formula: "invoicing.gross.amount_ht − invoicing.credits.amount_ht",
    sources: ["facture.total_ht", "avoir.total_ht"],
    grain: "Une pièce financière (facture ou avoir).",
    date_field: "Identique aux deux composantes.",
    statuses_included: [...FACTURE_LEDGER_STATUSES, ...AVOIR_LEDGER_STATUSES],
    statuses_excluded: [...FACTURE_EXCLUDED_STATUSES, ...AVOIR_EXCLUDED_STATUSES],
    cancellation: "Pièces annulées exclues des deux composantes.",
    credit_notes: "Déduits.",
    currency: COMMON.currency,
    tax_basis: "HT+TTC",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Libellé volontairement « Facturé net » et non « Chiffre d'affaires » : aucune règle comptable formelle n'a été validée pour le CERP.",
      "Indicateur de pilotage commercial — ne remplace pas les états comptables validés.",
    ],
  },
  {
    id: "invoicing.tax.amount",
    family: "facturation",
    label: "TVA (TTC − HT)",
    definition: "Écart entre le TTC et le HT des pièces du registre.",
    formula: "SUM(total_ttc) − SUM(total_ht)",
    sources: ["facture.total_ttc", "facture.total_ht", "avoir.total_ttc", "avoir.total_ht"],
    grain: "Une pièce financière.",
    date_field: "Identique à invoicing.net.amount_ht",
    statuses_included: [...FACTURE_LEDGER_STATUSES, ...AVOIR_LEDGER_STATUSES],
    statuses_excluded: [...FACTURE_EXCLUDED_STATUSES, ...AVOIR_EXCLUDED_STATUSES],
    cancellation: "Pièces annulées exclues.",
    credit_notes: "Déduits.",
    currency: COMMON.currency,
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Différence arithmétique, PAS une donnée fiscale autoritaire. `facture.total_tax` existe mais est nullable et non systématiquement renseigné.",
      "Ne jamais utiliser cette valeur pour une déclaration.",
    ],
  },

  // -------------------------------------------------------------------------
  // Encaissement et encours
  // -------------------------------------------------------------------------
  {
    id: "cash.collected.amount_ttc",
    family: "encaissement",
    label: "Encaissements TTC",
    definition: "Somme des règlements dont la date de paiement tombe dans la période.",
    formula: "SUM(paiement.montant) WHERE date_paiement ∈ [from, to] AND règlement net",
    sources: ["paiement.montant", "paiement.date_paiement", "paiement.status", "paiement.workflow_status"],
    grain: "Un règlement.",
    date_field: "paiement.date_paiement (date)",
    statuses_included: ["UNALLOCATED", "PARTIALLY_ALLOCATED", "ALLOCATED"],
    statuses_excluded: PAIEMENT_EXCLUDED_STATUSES,
    cancellation: "Règlements rejetés et extournés exclus, ainsi que les contre-écritures d'extourne.",
    credit_notes: "Sans objet (un avoir n'est pas un encaissement).",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "`date_paiement` est la date métier retenue. `value_date` et `booking_date` existent mais sont nullables et non alimentées.",
      "Un règlement non affecté est encaissé : il compte ici, mais ne réduit l'encours d'aucune facture précise.",
    ],
  },
  {
    id: "receivables.open.amount_ttc",
    family: "encaissement",
    label: "Créances ouvertes TTC",
    definition:
      "Reste dû des factures du registre à la date d'arrêté : total TTC − règlements affectés ≤ as_of − avoirs affectés finalisés ≤ as_of, pour les factures dont le solde est strictement positif.",
    formula:
      "SUM(GREATEST(solde, 0)) où solde = facture.total_ttc − Σ allocations de règlement ≤ as_of − Σ allocations d'avoir finalisées ≤ as_of",
    sources: [
      "facture.total_ttc",
      "paiement_allocations.amount_ttc",
      "paiement.date_paiement",
      "avoir_source_allocations.amount_ttc",
      "avoir.issued_at",
    ],
    grain: "Une facture.",
    date_field: "Date d'entrée au registre de la facture ≤ as_of",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Factures annulées exclues de l'encours.",
    credit_notes: "Seuls les avoirs finalisés ET affectés à la facture, avec une date ≤ as_of, réduisent l'encours.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of:
      "STRICT : aucun règlement ni avoir postérieur à as_of n'entre dans le calcul. C'est le défaut central corrigé par #275.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Les soldes créditeurs (facture sur-réglée) ne sont PAS écrasés à zéro : ils sont isolés dans receivables.credit_balance.amount_ttc.",
      "Les règlements non affectés ne réduisent aucune créance : ils sont exposés séparément.",
    ],
  },
  {
    id: "receivables.overdue.amount_ttc",
    family: "encaissement",
    label: "Créances échues TTC",
    definition: "Part des créances ouvertes dont l'échéance est strictement antérieure à la date d'arrêté.",
    formula: "SUM(solde) WHERE solde > 0 AND COALESCE(date_echeance, date_emission) < as_of",
    sources: ["facture.date_echeance", "facture.date_emission"],
    grain: "Une facture.",
    date_field: "facture.date_echeance, à défaut facture.date_emission",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Factures annulées exclues.",
    credit_notes: "Idem receivables.open.amount_ttc.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Comparaison stricte (`<`) à la date d'arrêté.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "L'échéancier détaillé `facture_echeance` (paiement en plusieurs fois) n'est pas encore utilisé : l'échéance d'en-tête fait foi. Une facture à échéances multiples est donc traitée comme mono-échéance.",
    ],
  },
  {
    id: "receivables.aging",
    family: "encaissement",
    label: "Balance âgée",
    definition:
      "Ventilation des créances ouvertes en cinq tranches d'ancienneté d'échéance à la date d'arrêté.",
    formula:
      "Tranches sur (as_of − échéance) : non échu (< 0), 1–30, 31–60, 61–90, > 90 jours. Bornes disjointes et exhaustives.",
    sources: ["facture.date_echeance", "facture.date_emission", "facture.total_ttc"],
    grain: "Une facture.",
    date_field: "facture.date_echeance, à défaut facture.date_emission",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Factures annulées exclues.",
    credit_notes: "Idem receivables.open.amount_ttc.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Toutes les tranches sont calculées à la même date d'arrêté.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Invariant testé : la somme des cinq tranches est strictement égale à receivables.open.amount_ttc.",
    ],
  },
  {
    id: "receivables.unallocated_payments.amount_ttc",
    family: "encaissement",
    label: "Règlements non affectés TTC",
    definition:
      "Part nette encore affectable à la date d'arrêté : montant du règlement − allocations ≤ as_of. Un rattachement direct hérité sans allocation vaut affectation complète.",
    formula:
      "SUM(MAX(paiement.montant − affecté_économique ≤ as_of, 0)) WHERE date_paiement ≤ as_of AND règlement net",
    sources: ["paiement.montant", "paiement_allocations.amount_ttc"],
    grain: "Un règlement.",
    date_field: "paiement.date_paiement ≤ as_of",
    statuses_included: ["UNALLOCATED", "PARTIALLY_ALLOCATED"],
    statuses_excluded: PAIEMENT_EXCLUDED_STATUSES,
    cancellation: "Règlements rejetés / extournés exclus.",
    credit_notes: "Sans objet.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Les allocations postérieures à as_of ne sont pas prises en compte.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Ce montant ne doit jamais être soustrait de l'encours global : ce serait supposer un lettrage qui n'existe pas.",
      "Une preuve directe héritée (facture_id renseigné sans allocation) est projetée ALLOCATED et contribue zéro au disponible.",
    ],
  },
  {
    id: "receivables.unallocated_credits.amount_ttc",
    family: "encaissement",
    label: "Avoirs non affectés TTC",
    definition:
      "Part des avoirs finalisés à la date d'arrêté qui n'est imputée à aucune facture.",
    formula: "SUM(avoir.total_ttc − Σ avoir_source_allocations) WHERE date registre ≤ as_of",
    sources: ["avoir.total_ttc", "avoir_source_allocations.amount_ttc"],
    grain: "Un avoir.",
    date_field: "Date d'entrée au registre de l'avoir ≤ as_of",
    statuses_included: AVOIR_LEDGER_STATUSES,
    statuses_excluded: AVOIR_EXCLUDED_STATUSES,
    cancellation: "Avoirs annulés exclus.",
    credit_notes: "C'est la métrique des avoirs non imputés.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Les imputations postérieures à as_of ne sont pas prises en compte.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Un avoir non imputé est une dette envers le client : il ne réduit pas l'encours mais doit être visible.",
    ],
  },
  {
    id: "receivables.credit_balance.amount_ttc",
    family: "encaissement",
    label: "Trop-perçus / soldes créditeurs TTC",
    definition:
      "Valeur absolue des soldes de factures devenus négatifs à la date d'arrêté (règlements + avoirs affectés supérieurs au total de la facture).",
    formula: "SUM(-solde) WHERE solde < 0",
    sources: ["facture.total_ttc", "paiement_allocations.amount_ttc", "avoir_source_allocations.amount_ttc"],
    grain: "Une facture.",
    date_field: "Date d'entrée au registre de la facture ≤ as_of",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Factures annulées exclues.",
    credit_notes: "Comptés dans le solde.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Même date d'arrêté que l'encours.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Avant #275, `GREATEST(0, …)` écrasait ces montants à zéro : un trop-perçu était strictement invisible.",
      "Les triggers #227 rendent normalement le sur-lettrage impossible ; une valeur non nulle ici signale une anomalie de données à instruire.",
    ],
  },
  {
    id: "cash.collection_rate",
    family: "encaissement",
    label: "Taux d'encaissement",
    definition:
      "Part encaissée du facturé net TTC de la période, encaissements mesurés sur la même période.",
    formula: "cash.collected.amount_ttc / invoicing.net.amount_ttc",
    numerator: "Encaissements nets de la période",
    denominator: "Facturé net TTC de la période",
    sources: ["paiement.montant", "facture.total_ttc", "avoir.total_ttc"],
    grain: "Période.",
    date_field: "date_paiement au numérateur, date de registre au dénominateur",
    statuses_included: FACTURE_LEDGER_STATUSES,
    statuses_excluded: FACTURE_EXCLUDED_STATUSES,
    cancellation: "Pièces annulées exclues.",
    credit_notes: "Déduits du dénominateur.",
    currency: COMMON.currency,
    tax_basis: "TTC",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Comptabilité",
    availability: "available",
    limitations: [
      "Numérateur et dénominateur ne portent pas sur les mêmes pièces : un encaissement de janvier peut solder une facture de décembre. Le ratio mesure une trésorerie relative, pas un recouvrement de cohorte.",
      "Le dénominateur peut être nul ou négatif (avoirs) : le ratio est alors renvoyé à `null`, jamais à zéro.",
    ],
  },
  {
    id: "cash.dso",
    family: "encaissement",
    label: "DSO",
    definition: "Days Sales Outstanding — délai moyen d'encaissement.",
    formula: "Indisponible.",
    sources: [],
    grain: "Période.",
    date_field: "N/A",
    statuses_included: [],
    statuses_excluded: [],
    cancellation: "Sans objet.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: "Sans objet.",
    unit: "days",
    owner: "Comptabilité",
    availability: "deferred",
    limitations: [
      "Bloquant : la méthode (moyenne simple, countback / épuisement du solde) n'est pas arbitrée, et l'historique de facturation est vide — un DSO calculé sur quelques semaines n'aurait aucun sens.",
      "Livrable après arbitrage Finance et 12 mois d'historique réel.",
    ],
  },

  // -------------------------------------------------------------------------
  // Clients
  // -------------------------------------------------------------------------
  {
    id: "clients.top.net_ht",
    family: "clients",
    label: "Top clients (facturé net HT)",
    definition:
      "Classement des clients par facturé net HT sur la période, périmètre strictement identique au total.",
    formula: "SUM(facture.total_ht) − SUM(avoir.total_ht) GROUP BY client_id",
    sources: ["facture.client_id", "avoir.client_id", "clients.company_name"],
    grain: "Un client.",
    date_field: "Identique à invoicing.net.amount_ht",
    statuses_included: [...FACTURE_LEDGER_STATUSES, ...AVOIR_LEDGER_STATUSES],
    statuses_excluded: [...FACTURE_EXCLUDED_STATUSES, ...AVOIR_EXCLUDED_STATUSES],
    cancellation: "Pièces annulées exclues.",
    credit_notes: "Déduits.",
    currency: COMMON.currency,
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "currency",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "Invariant testé : la somme de TOUS les clients est égale à invoicing.net.amount_ht. La liste renvoyée est tronquée, l'écrêtage est annoncé explicitement.",
      "Le HT est retenu pour la performance commerciale ; l'encours reste en TTC.",
    ],
  },
  {
    id: "clients.concentration.top5_share",
    family: "clients",
    label: "Poids du Top 5",
    definition: "Part du facturé net HT de la période concentrée sur les cinq premiers clients.",
    formula: "Σ(5 premiers clients) / Σ(tous les clients)",
    numerator: "Facturé net HT des 5 premiers clients",
    denominator: "Facturé net HT total de la période",
    sources: ["facture.total_ht", "avoir.total_ht"],
    grain: "Période.",
    date_field: "Identique à clients.top.net_ht",
    statuses_included: [...FACTURE_LEDGER_STATUSES, ...AVOIR_LEDGER_STATUSES],
    statuses_excluded: [...FACTURE_EXCLUDED_STATUSES, ...AVOIR_EXCLUDED_STATUSES],
    cancellation: "Pièces annulées exclues.",
    credit_notes: "Déduits.",
    currency: "Sans objet.",
    tax_basis: "HT",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: COMMON.refresh,
    unit: "ratio",
    owner: "Direction commerciale",
    availability: "available",
    limitations: [
      "Le ratio n'a de sens que si le dénominateur est strictement positif ; sinon `null`.",
      "Les clients à net négatif (avoirs sans facture sur la période) restent dans le dénominateur.",
    ],
  },
  {
    id: "clients.margin",
    family: "clients",
    label: "Marge par client",
    definition: "Marge réelle dégagée par client.",
    formula: "Indisponible.",
    sources: [],
    grain: "Un client.",
    date_field: "N/A",
    statuses_included: [],
    statuses_excluded: [],
    cancellation: "Sans objet.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Sans objet.",
    refresh: "Sans objet.",
    unit: "currency",
    owner: "Contrôle de gestion",
    availability: "deferred",
    limitations: [
      "Bloquant : l'allocation et la réconciliation multi-objets par client ne sont pas exhaustives (voir MARGIN_UNAVAILABLE).",
      "Interdit d'afficher une marge estimée sous le libellé « marge réelle », « rentabilité » ou « contribution ».",
    ],
  },

  // -------------------------------------------------------------------------
  // Qualité de données
  // -------------------------------------------------------------------------
  {
    id: "quality.anomalies",
    family: "qualite_donnees",
    label: "Anomalies de données",
    definition:
      "Compteurs des situations qui rendent un agrégat partiellement faux : pièce sans date, ligne de BL non rattachée, commande sans ligne, statut hors vocabulaire, devise multiple.",
    formula: "Compteurs indépendants, calculés sur le même périmètre que les agrégats.",
    sources: ["facture", "avoir", "paiement", "commande_ligne", "bon_livraison_ligne", "devis"],
    grain: "Variable selon l'anomalie.",
    date_field: "Périmètre de la requête.",
    statuses_included: [],
    statuses_excluded: [],
    cancellation: "Sans objet.",
    credit_notes: "Sans objet.",
    currency: "Sans objet.",
    tax_basis: "N/A",
    timezone: COMMON.timezone,
    as_of: "Date d'arrêté de la requête.",
    refresh: COMMON.refresh,
    unit: "count",
    owner: "Direction",
    availability: "available",
    limitations: [
      "Une anomalie n'est pas corrigée automatiquement : elle est signalée pour instruction humaine.",
    ],
  },
];

const BY_ID = new Map(CATALOG.map((metric) => [metric.id, metric]));

export function listMetrics(): MetricDefinition[] {
  return CATALOG;
}

export function getMetric(id: string): MetricDefinition | undefined {
  return BY_ID.get(id);
}

export function listMetricsByFamily(family: MetricFamily): MetricDefinition[] {
  return CATALOG.filter((metric) => metric.family === family);
}

export function listDeferredMetrics(): MetricDefinition[] {
  return CATALOG.filter((metric) => metric.availability === "deferred");
}

/** Vrai si l'identifiant existe : sert de garde-fou aux tests de contrat. */
export function isKnownMetric(id: string): boolean {
  return BY_ID.has(id);
}
