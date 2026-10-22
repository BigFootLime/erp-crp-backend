import { getModuleCatalogEntry } from "../domain/module-catalog";
import type { DbQueryer } from "./access-control.repository";

/** Explicit deployment/fixture data operation. Never grants an account or changes schema. */
export async function synchronizeErpConfigurationCatalog(tx: DbQueryer): Promise<void> {
  for (const key of ["parametrage-erp", "administration"]) {
    const entry = getModuleCatalogEntry(key);
    if (!entry) throw new Error("ERP_CONFIGURATION_CATALOG_MISSING");
    await tx.query(`INSERT INTO public.app_modules
      (module_key,label,description,category,api_prefixes,nav_page_keys,enabled_by_default,is_protected,sort_order,is_active)
      VALUES($1,$2,$3,$4,$5::text[],$6::text[],false,$7,$8,true)
      ON CONFLICT(module_key) DO UPDATE SET label=excluded.label,description=excluded.description,
      category=excluded.category,api_prefixes=excluded.api_prefixes,nav_page_keys=excluded.nav_page_keys,
      enabled_by_default=false,is_protected=excluded.is_protected,sort_order=excluded.sort_order,is_active=true`,
    [entry.module_key, entry.label, entry.description, entry.category, entry.api_prefixes, entry.nav_page_keys, entry.is_protected, entry.sort_order]);
  }
  await tx.query("UPDATE public.realtime_authorization_epoch SET epoch=epoch+1 WHERE singleton=true");
}
