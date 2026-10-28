import { z } from "zod";
import type { BackgroundStarter } from "../../../shared/runtime/background-lifecycle";
import { companyRuntimeService } from "./company-runtime.service";

export type CompanyBackgroundProfile = "COMMERCIAL" | "INDUSTRIAL" | "LEGACY";
export async function resolveCompanyBackgroundProfile(): Promise<CompanyBackgroundProfile> {
  const runtime = companyRuntimeService.configuration();
  if (!runtime.enabled) return "LEGACY";
  const resolved = z.object({ company: z.object({ id: z.string().uuid(), profile: z.enum(["COMMERCIAL", "INDUSTRIAL"]) }),
    environment: z.enum(["cerp_prod", "cerp_test"]) }).parse(
    await companyRuntimeService.directory().call("business-company-sign-in-context", { input: {} }));
  if (resolved.company.id !== runtime.company_id || resolved.environment !== runtime.environment)
    throw new Error("COMPANY_BACKGROUND_PROFILE_SCOPE_MISMATCH");
  return resolved.company.profile;
}

const COMMERCIAL_TASKS = new Set([
  "auth-rate-limit", "locks", "reminders", "electronic-invoices", "supplier-invoices",
  "e-reporting", "webhooks", "authoritative-documents", "intercompany-delivery",
]);
export function selectCompanyBackgroundStarters(profile: CompanyBackgroundProfile, entries: readonly { key: string; start: BackgroundStarter }[]): BackgroundStarter[] {
  return entries.filter(entry => profile !== "COMMERCIAL" || COMMERCIAL_TASKS.has(entry.key)).map(entry => entry.start);
}
