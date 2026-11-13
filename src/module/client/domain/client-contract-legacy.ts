import type { ClientContract } from "../types/client-contract.types";

export type LegacyContractSourceLine = {
  id: string;
  article_id: string | null;
  root_article_id: string | null;
  piece_technique_id: string | null;
  piece_technique_version_id: string | null;
  indice: string | null;
  unit_id: string | null;
  unit: string | null;
  code: string | null;
  designation: string | null;
  quantity: string;
  due_date: string | null;
  technical_identity_valid: boolean;
};

export type LegacyContractMapping = {
  commande_ligne_id: string;
  contract_line_id: string;
  article_id: string;
  root_article_id: string;
  piece_technique_version_id: string | null;
  unit_id: string;
  historical_line: LegacyContractSourceLine;
};

export type LegacyContractIssue = {
  line_id: string | null;
  code: string;
  message: string;
};

/** Match actual article families and units. Names and current indices are never identity fallbacks. */
export function mapLegacyContractLines(
  contract: ClientContract,
  lines: readonly LegacyContractSourceLine[],
): { mappings: LegacyContractMapping[]; issues: LegacyContractIssue[] } {
  const mappings: LegacyContractMapping[] = [];
  const issues: LegacyContractIssue[] = [];
  if (!lines.length) {
    return { mappings, issues: [{ line_id: null, code: "LEGACY_ORDER_EMPTY", message: "Le cadre ne contient aucune ligne." }] };
  }
  for (const line of lines) {
    if (!line.technical_identity_valid) {
      issues.push({ line_id: line.id, code: "LEGACY_TECHNICAL_IDENTITY_MISMATCH", message: "La version technique historique n’appartient pas à cet article." });
      continue;
    }
    if (!line.article_id || !line.root_article_id) {
      issues.push({ line_id: line.id, code: "LEGACY_ARTICLE_UNTRACKED", message: "Cette ligne n’est pas reliée à un article identifié." });
      continue;
    }
    const candidates = contract.lines.filter(candidate => candidate.root_article_id === line.root_article_id);
    if (candidates.length !== 1) {
      issues.push({ line_id: line.id, code: "LEGACY_CONTRACT_FAMILY_MISMATCH", message: "La famille d’article n’est pas définie de façon unique dans le contrat." });
      continue;
    }
    const target = candidates[0];
    if (!line.unit_id || line.unit_id !== target.unit_id) {
      issues.push({ line_id: line.id, code: "LEGACY_CONTRACT_UNIT_MISMATCH", message: "L’unité historique ne correspond pas à celle du contrat." });
      continue;
    }
    // A missing historical technical version stays missing. Association of the
    // commercial family grants no manufacturing, OLD-stock or quality approval.
    mappings.push({ commande_ligne_id: line.id, contract_line_id: target.id,
      article_id: line.article_id, root_article_id: line.root_article_id,
      piece_technique_version_id: line.piece_technique_version_id, unit_id: line.unit_id,
      historical_line: line });
  }
  return { mappings, issues };
}
