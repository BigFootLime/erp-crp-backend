import { asyncHandler } from "../../../utils/asyncHandler";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { sharedDirectoryClient } from "../../../shared-directory/site-runtime";
import { directoryAdminCall, directoryTargetId } from "../../../shared-directory/admin.facade";
import { companyAuthorityFailure } from "../../entreprises/runtime/company-runtime.service";
import { approvedCompanyAccessUpdateSchema } from "../../entreprises/domain/approved-company-access";
import { adminUserIdParamSchema } from "../validators/admin.validators";

/** Uses the same authenticated numeric-user binding as the existing account
 * editor. Directory independently revalidates the live owner and recent MFA. */
function handler(operation: string, update = false) {
  return asyncHandler(async (req, res) => {
    if (!sharedDirectoryClient()) throw new HttpError(503, "DIRECTORY_UNAVAILABLE", "La gestion des entreprises est momentanément indisponible.");
    const dto = adminUserIdParamSchema.parse({ params: req.params });
    const profile_id = await directoryTargetId(pool, Number(dto.params.id));
    const input = update ? { ...approvedCompanyAccessUpdateSchema.parse(req.body), profile_id } : { profile_id };
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json(await directoryAdminCall(pool, req, operation, input));
    } catch (error) {
      if ((error as { code?: string })?.code === "BUSINESS_COMPANY_OWNER_SELF_ACCESS_REQUIRED")
        throw new HttpError(409, "BUSINESS_COMPANY_OWNER_SELF_ACCESS_REQUIRED", "Conservez votre accès à l’entreprise principale pour administrer les comptes.");
      companyAuthorityFailure(error);
    }
  });
}
export const getCompanyAccountAccess = handler("business-companies-admin-approved-access-options");
export const updateCompanyAccountAccess = handler("business-companies-admin-approved-access-set", true);
