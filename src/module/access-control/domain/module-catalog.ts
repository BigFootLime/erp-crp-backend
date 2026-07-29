// Catalogue des modules ERP soumis au filtrage d'accès (#326 / back #200).
// Miroir exact du seed db/patches/20260727_admin_access_tower_326.sql : la base fait
// autorité sur les DÉCISIONS (défauts, overrides), le code fait autorité sur la
// RÉSOLUTION chemin -> module, qui doit rester déterministe même base injoignable.

export type ModuleCatalogEntry = {
  module_key: string;
  label: string;
  description: string;
  category: string;
  api_prefixes: readonly string[];
  nav_page_keys: readonly string[];
  is_protected: boolean;
  sort_order: number;
};

export const MODULE_CATALOG: readonly ModuleCatalogEntry[] = [
  {
    module_key: "clients",
    label: "Clients",
    description: "Comptes clients, contacts, adresses et conditions de règlement.",
    category: "Commerce",
    api_prefixes: ["/clients", "/payment-modes", "/billers", "/banking-info"],
    nav_page_keys: ["clients"],
    is_protected: false,
    sort_order: 10,
  },
  {
    module_key: "devis",
    label: "Devis",
    description: "Chiffrage et cycle de vie des devis clients.",
    category: "Commerce",
    api_prefixes: ["/devis"],
    nav_page_keys: ["devis"],
    is_protected: false,
    sort_order: 20,
  },
  {
    module_key: "commandes-clients",
    label: "Commandes clients",
    description: "Commandes fermes, cadres et internes, appels de livraison.",
    category: "Commerce",
    api_prefixes: ["/commandes"],
    nav_page_keys: ["commandes"],
    is_protected: false,
    sort_order: 30,
  },
  {
    module_key: "livraisons",
    label: "Livraisons",
    description: "Préparation, expédition et bons de livraison.",
    category: "Commerce",
    api_prefixes: ["/livraisons"],
    nav_page_keys: ["livraisons"],
    is_protected: false,
    sort_order: 40,
  },
  {
    module_key: "affaires",
    label: "Affaires",
    description: "Affaires commerciales et projets rattachés.",
    category: "Commerce",
    api_prefixes: ["/affaires"],
    nav_page_keys: ["affaires"],
    is_protected: false,
    sort_order: 50,
  },
  {
    module_key: "facturation",
    label: "Facturation",
    description: "Factures, avoirs, règlements et tarification.",
    category: "Commerce",
    api_prefixes: ["/factures", "/avoirs", "/paiements", "/tarification"],
    nav_page_keys: ["factures"],
    is_protected: false,
    sort_order: 60,
  },
  {
    module_key: "reporting-commercial",
    label: "Reporting commercial",
    description: "Indicateurs commerciaux et exports gouvernés.",
    category: "Commerce",
    api_prefixes: ["/reporting"],
    nav_page_keys: ["reporting-commercial"],
    is_protected: false,
    sort_order: 70,
  },
  {
    module_key: "fournisseurs",
    label: "Fournisseurs",
    description: "Référentiel fournisseurs et écosystème achat.",
    category: "Achats",
    api_prefixes: ["/fournisseurs"],
    nav_page_keys: ["fournisseurs"],
    is_protected: false,
    sort_order: 80,
  },
  {
    module_key: "commandes-fournisseurs",
    label: "Commandes fournisseurs",
    description: "Bons de commande fournisseurs et suivi des accusés.",
    category: "Achats",
    api_prefixes: ["/commandes-fournisseurs"],
    nav_page_keys: ["commandes-fournisseurs"],
    is_protected: false,
    sort_order: 90,
  },
  {
    module_key: "pieces-techniques",
    label: "Données techniques",
    description: "Pièces techniques, versions, gammes, finitions et dossiers d’opération.",
    category: "Production",
    // `/finitions` (#210) rejoint le module Données techniques : la bibliothèque
    // de finitions est un référentiel Méthodes, pas un module d'accès distinct.
    // Idem `/methodes` : familles machine, centres de frais tarifés et sélecteur
    // de machines sont les référentiels de la gamme, pas un module à part.
    api_prefixes: [
      "/pieces-techniques",
      "/piece-technique-versions",
      "/gammes",
      "/finitions",
      "/dossiers",
      "/methodes",
    ],
    // `methodes-centres-frais` et `methodes-parc-machines` sont des pages de CE
    // module : sans elles dans la liste, leurs entrées de navigation
    // disparaîtraient pour tout compte filtré.
    nav_page_keys: ["pieces-techniques", "methodes-centres-frais", "methodes-parc-machines"],
    is_protected: false,
    sort_order: 100,
  },
  {
    module_key: "production",
    label: "Production",
    description: "Ordres de fabrication, planning, pointages et poste opérateur.",
    category: "Production",
    api_prefixes: ["/production", "/planning", "/programmations"],
    nav_page_keys: [
      "production-dashboard",
      "machines-postes",
      "production-planning",
      "production-execution",
      "atelier-station",
      "production-pointages",
      "ordres-fabrication",
    ],
    is_protected: false,
    sort_order: 110,
  },
  {
    module_key: "qualite",
    label: "Qualité",
    description: "Plans de contrôle, non-conformités, réceptions et dérogations.",
    category: "Qualité",
    api_prefixes: ["/qualite", "/receptions"],
    nav_page_keys: ["qualite-center", "qualite-controls", "qualite-non-conformities", "receptions"],
    is_protected: false,
    sort_order: 120,
  },
  {
    module_key: "metrologie",
    label: "Métrologie",
    description: "Parc de moyens de mesure, étalonnages et certificats.",
    category: "Qualité",
    api_prefixes: ["/metrologie"],
    nav_page_keys: ["metrologie"],
    is_protected: false,
    sort_order: 130,
  },
  {
    module_key: "tracabilite",
    label: "Traçabilité",
    description: "Chaînage matière, généalogie des lots et dossiers as-built.",
    category: "Qualité",
    api_prefixes: ["/traceability", "/asbuilt"],
    nav_page_keys: ["traceabilite"],
    is_protected: false,
    sort_order: 140,
  },
  {
    module_key: "stock",
    label: "Stock",
    description: "Articles, mouvements, emplacements et inventaires.",
    category: "Stock",
    api_prefixes: ["/stock"],
    nav_page_keys: ["stock-dashboard", "stock-articles", "stock-mouvements", "stock-inventaires"],
    is_protected: false,
    sort_order: 150,
  },
  {
    module_key: "outillage",
    label: "Outillage",
    description: "Parc d’outils coupants et sorties atelier.",
    category: "Stock",
    api_prefixes: ["/outils"],
    nav_page_keys: ["outils", "outils-new", "outils-retirer"],
    is_protected: false,
    sort_order: 160,
  },
  {
    module_key: "temps-deplacements",
    label: "Temps & Déplacements",
    description: "Pointages horaires et frais kilométriques.",
    category: "Ressources humaines",
    api_prefixes: ["/time-clock"],
    nav_page_keys: ["td-*"],
    is_protected: false,
    sort_order: 170,
  },
  {
    module_key: "pilotage-projet",
    label: "Pilotage projet",
    description: "Project Office : lots, jalons, décisions et preuves.",
    category: "Système",
    api_prefixes: ["/project-office"],
    nav_page_keys: ["po-*"],
    is_protected: false,
    sort_order: 180,
  },
  {
    module_key: "import-clipper",
    label: "Migration CLIPPER",
    description: "Assistant de reprise des données historiques CLIPPER.",
    category: "Système",
    api_prefixes: ["/import-assistant"],
    nav_page_keys: ["import-assistant"],
    is_protected: false,
    sort_order: 190,
  },
  {
    module_key: "administration",
    label: "Administration",
    description: "Comptes, rôles, réglages ERP et tour de contrôle des accès.",
    category: "Système",
    api_prefixes: ["/admin"],
    nav_page_keys: ["administration", "erp-settings", "acces"],
    is_protected: true,
    sort_order: 200,
  },
] as const;

export const MODULE_KEYS: readonly string[] = MODULE_CATALOG.map((entry) => entry.module_key);

export const PROTECTED_MODULE_KEYS: readonly string[] = MODULE_CATALOG.filter(
  (entry) => entry.is_protected
).map((entry) => entry.module_key);

export function getModuleCatalogEntry(moduleKey: string): ModuleCatalogEntry | null {
  return MODULE_CATALOG.find((entry) => entry.module_key === moduleKey) ?? null;
}

/**
 * Un module protégé n'est jamais refusé par le gate. La réponse vient du catalogue
 * de code et non de la base : c'est ce qui garantit qu'aucune décision, même
 * erronée, ne puisse rendre l'ERP inadministrable.
 */
export function isProtectedModuleKey(moduleKey: string): boolean {
  return PROTECTED_MODULE_KEYS.includes(moduleKey);
}

// Index préfixe -> module, trié du plus long au plus court : le gate doit choisir
// « /commandes-fournisseurs » et jamais « /commandes » pour un bon de commande.
const PREFIX_INDEX: ReadonlyArray<{ prefix: string; module_key: string }> = MODULE_CATALOG.flatMap(
  (entry) => entry.api_prefixes.map((prefix) => ({ prefix, module_key: entry.module_key }))
).sort((a, b) => b.prefix.length - a.prefix.length);

const API_ROOT = "/api/v1";

function normalizePath(path: string): string {
  const withoutQuery = path.split("?")[0]?.split("#")[0] ?? "";
  // Le gate est monté dans le routeur v1 (chemin relatif), mais la fonction doit
  // rester utilisable avec une URL complète (tests, journalisation, outillage).
  const withoutRoot = withoutQuery.startsWith(API_ROOT)
    ? withoutQuery.slice(API_ROOT.length)
    : withoutQuery;
  const prefixed = withoutRoot.startsWith("/") ? withoutRoot : `/${withoutRoot}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : prefixed;
}

/**
 * Résout la clé de module d'un chemin d'API. Le plus long préfixe gagne, et un
 * préfixe ne correspond que sur une frontière de segment : « /commandes » ne doit
 * jamais capter « /commandes-fournisseurs ». Retourne `null` pour les surfaces
 * d'infrastructure partagée (/auth, /users, /codes, /notifications…), qui ne sont
 * rattachées à aucun module et ne sont donc jamais filtrées.
 */
export function resolveModuleKeyForPath(path: string | null | undefined): string | null {
  if (typeof path !== "string" || path.length === 0) return null;
  const normalized = normalizePath(path);
  for (const entry of PREFIX_INDEX) {
    if (normalized === entry.prefix || normalized.startsWith(`${entry.prefix}/`)) {
      return entry.module_key;
    }
  }
  return null;
}
