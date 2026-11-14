import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { COMPANY_CONTEXT_HTTP_HEADERS } from "../contract/company-context-contract-v1";

export const COMPANY_HEADER: typeof COMPANY_CONTEXT_HTTP_HEADERS.company =
  COMPANY_CONTEXT_HTTP_HEADERS.company;
export const COMPANY_ENVIRONMENT_HEADER: typeof COMPANY_CONTEXT_HTTP_HEADERS.environment =
  COMPANY_CONTEXT_HTTP_HEADERS.environment;
export const COMPANY_SOCKET_QUERY = "company";
export const companyIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const companyEnvironmentSchema = z.enum(["cerp_prod", "cerp_test"]);

export type CompanyRuntimeConfiguration =
  | { enabled: false }
  | {
      enabled: true;
      company_id: string;
      environment: "cerp_prod" | "cerp_test";
    };

/** No database URL, pool selection or client input belongs in this configuration. */
export function companyRuntimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): CompanyRuntimeConfiguration {
  const flag = env.CERP_BUSINESS_COMPANIES_ENABLED;
  if (flag === undefined || flag === "false") return { enabled: false };
  if (flag !== "true")
    throw new HttpError(
      503,
      "COMPANY_RUNTIME_CONFIGURATION_INVALID",
      "Le contexte entreprise doit être configuré.",
    );
  const parsed = z
    .object({
      company_id: companyIdSchema,
      environment: companyEnvironmentSchema,
    })
    .safeParse({
      company_id: env.CERP_COMPANY_ID,
      environment: env.CERP_COMPANY_ENVIRONMENT,
    });
  if (!parsed.success || env.CERP_SHARED_DIRECTORY_ENABLED !== "true") {
    throw new HttpError(
      503,
      "COMPANY_RUNTIME_CONFIGURATION_INVALID",
      "Le contexte entreprise doit être configuré.",
    );
  }
  return { enabled: true, ...parsed.data };
}
