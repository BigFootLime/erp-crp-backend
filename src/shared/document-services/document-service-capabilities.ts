import { checkVaultHealth, type VaultHealth } from "../../module/ged/services/ged-vault.service";

export type DocumentServiceReasonCode =
  | "GED_VAULT_NOT_CONFIGURED"
  | "GED_VOLUME_NOT_READY"
  | "GED_VAULT_NOT_WRITABLE";

export type DocumentServiceCapabilities = Readonly<{
  contract_version: 1;
  status: "available" | "degraded";
  document_writes_supported: boolean;
  reason_code: DocumentServiceReasonCode | null;
  checked_at: string;
}>;

export function documentServiceCapabilitiesFromHealth(
  health: VaultHealth,
  checkedAt = new Date().toISOString()
): DocumentServiceCapabilities {
  const reasonCode: DocumentServiceReasonCode | null = !health.configured
    ? "GED_VAULT_NOT_CONFIGURED"
    : !health.root_present || (health.sentinel_required && !health.sentinel_present)
      ? "GED_VOLUME_NOT_READY"
      : !health.healthy || !health.writable
        ? "GED_VAULT_NOT_WRITABLE"
        : null;
  const supported = reasonCode === null;
  return {
    contract_version: 1,
    status: supported ? "available" : "degraded",
    document_writes_supported: supported,
    reason_code: reasonCode,
    checked_at: checkedAt,
  };
}

/** Shared authenticated service truth; deliberately excludes paths/capacity. */
export async function collectDocumentServiceCapabilities(): Promise<DocumentServiceCapabilities> {
  return documentServiceCapabilitiesFromHealth(await checkVaultHealth());
}
