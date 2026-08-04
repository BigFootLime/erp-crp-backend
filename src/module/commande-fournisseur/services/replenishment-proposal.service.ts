import {
  repoListReplenishmentProposals,
  repoRefreshReplenishmentProposals,
  repoValidateReplenishmentProposal,
} from "../repository/replenishment-proposal.repository"
import type { AuditContext } from "../repository/commande-fournisseur.repository"
import type {
  ListReplenishmentProposalsDTO,
  RefreshReplenishmentProposalsDTO,
  ValidateReplenishmentProposalDTO,
} from "../validators/replenishment-proposal.validators"

export const listReplenishmentProposalsSVC = (query: ListReplenishmentProposalsDTO) =>
  repoListReplenishmentProposals(query)

export const refreshReplenishmentProposalsSVC = (body: RefreshReplenishmentProposalsDTO, audit: AuditContext) =>
  repoRefreshReplenishmentProposals(body, audit)

export const validateReplenishmentProposalSVC = (
  id: string,
  body: ValidateReplenishmentProposalDTO,
  audit: AuditContext
) => repoValidateReplenishmentProposal(id, body, audit)
