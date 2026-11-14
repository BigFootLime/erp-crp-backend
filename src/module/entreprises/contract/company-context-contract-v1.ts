/**
 * Public /entreprises/context contract, owned by the backend.
 *
 * This deliberately excludes the resolved internal CompanyContext identities
 * (central account and Directory profile). The frontend carries a generated
 * copy for boundary validation; the release check compares the complete artifact.
 */
export const COMPANY_CONTEXT_CONTRACT_VERSION = 1 as const;
export const COMPANY_CONTEXT_CONTRACT_FINGERPRINT =
  "cerp-company-context-v1-20261114" as const;

export const COMPANY_CONTEXT_HTTP_HEADERS = {
  company: "X-CERP-Company",
  environment: "X-CERP-Database",
} as const;

export const COMPANY_CONTEXT_COMPATIBILITY_FIXTURES = {
  legacy: {
    contract_version: 1,
    mode: "LEGACY",
    active_company: null,
    environment: "cerp_prod",
    available_companies: [],
    module_keys: [],
    commercial_projection_capabilities: [],
    workspace: null,
  },
  commercial: {
    contract_version: 1,
    mode: "COMPANY",
    active_company: {
      id: "22222222-2222-4222-8222-222222222222",
      code: "EC",
      name: "Esprit Carabine",
      profile: "COMMERCIAL",
    },
    environment: "cerp_test",
    available_companies: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        code: "EC",
        name: "Esprit Carabine",
        profile: "COMMERCIAL",
      },
    ],
    module_keys: ["clients"],
    commercial_projection_capabilities: ["stock.projection.read"],
    workspace: "ACCUEIL",
  },
  industrial: {
    contract_version: 1,
    mode: "COMPANY",
    active_company: {
      id: "11111111-1111-4111-8111-111111111111",
      code: "CRP",
      name: "Croix Rousse Précision",
      profile: "INDUSTRIAL",
    },
    environment: "cerp_prod",
    available_companies: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        code: "CRP",
        name: "Croix Rousse Précision",
        profile: "INDUSTRIAL",
      },
    ],
    module_keys: ["production"],
    commercial_projection_capabilities: [],
    workspace: "INDUSTRIAL",
  },
} as const;
