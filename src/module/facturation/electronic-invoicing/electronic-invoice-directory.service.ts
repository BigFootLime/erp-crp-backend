import { HttpError } from "../../../utils/httpError";
import type { AuditContext } from "../../client/repository/client.repository";
import {
  findDirectoryVerificationReplay,
  persistDirectoryVerification,
  readDirectoryVerificationResource,
  type ElectronicInvoiceDirectoryResourceType,
} from "./electronic-invoice-directory.repository";
import {
  loadSuperPdpConfiguration,
  SuperPdpClient,
} from "./providers/super-pdp/super-pdp.client";

function client(): SuperPdpClient {
  return new SuperPdpClient(loadSuperPdpConfiguration());
}

export function searchElectronicInvoiceDirectoryCompanies(params: {
  number?: string;
  formalNameStartsWith?: string;
  postCodeStartsWith?: string;
  limit?: number;
}) {
  return client().searchFrenchDirectoryCompanies(params);
}

export function listElectronicInvoiceDirectoryEntries(number: string) {
  return client().listFrenchDirectoryEntries(number);
}

export async function verifyElectronicInvoiceDirectoryAddress(params: {
  resourceType: ElectronicInvoiceDirectoryResourceType;
  resourceId: string;
  identifier: string;
  expectedUpdatedAt: string;
  idempotencyKey: string;
  audit: AuditContext;
}) {
  const resource = await readDirectoryVerificationResource(params.resourceType, params.resourceId);
  const replay = await findDirectoryVerificationReplay({
    resourceType: params.resourceType,
    resourceId: params.resourceId,
    siren: resource.siren,
    identifier: params.identifier,
    expectedUpdatedAt: params.expectedUpdatedAt,
    idempotencyKey: params.idempotencyKey,
  });
  if (replay) return replay;
  const entries = await listElectronicInvoiceDirectoryEntries(resource.siren);
  const selected = entries.find((entry) => entry.identifier === params.identifier);
  if (!selected) {
    throw new HttpError(422, "EINVOICE_DIRECTORY_ENTRY_NOT_FOUND", "Cette adresse n'appartient pas au SIREN qualifié dans l'annuaire.");
  }
  if (!selected.is_active) {
    throw new HttpError(422, "EINVOICE_DIRECTORY_ENTRY_INACTIVE", "Cette adresse existe dans l'annuaire mais n'est pas active.");
  }
  return persistDirectoryVerification({
    ...params,
    siren: resource.siren,
  });
}
