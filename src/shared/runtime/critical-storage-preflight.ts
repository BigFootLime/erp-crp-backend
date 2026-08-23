import { preflightVaultStorage } from "../../module/ged/services/ged-vault.service";

type CriticalStoragePreflightDependencies = Readonly<{
  preflightGedVault: () => Promise<void>;
}>;

function enabledOutsideProduction(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

/**
 * Production cannot opt out. Non-production may opt in so operators and tests
 * can rehearse the exact startup boundary without making every unit test own a
 * filesystem mount.
 */
export function requiresGedVaultStartupPreflight(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.NODE_ENV === "production"
    || enabledOutsideProduction(environment.CERP_GED_STARTUP_PREFLIGHT);
}

export async function preflightCriticalStorageAtStartup(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: CriticalStoragePreflightDependencies = { preflightGedVault: preflightVaultStorage }
): Promise<{ ged_vault_required: boolean; ged_vault_ready: boolean }> {
  const required = requiresGedVaultStartupPreflight(environment);
  if (!required) return { ged_vault_required: false, ged_vault_ready: false };

  await dependencies.preflightGedVault();
  return { ged_vault_required: true, ged_vault_ready: true };
}
