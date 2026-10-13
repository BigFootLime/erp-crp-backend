import pool from "../../../config/database";
import type { ProformaDraftBodyDTO, ProformaListQueryDTO } from "../validators/proforma.validators";
import { buildProformaPreview } from "../repository/proforma-preview.repository";
import { repoCreateProforma, repoDecideDeliveryPrepaymentTerms, repoIssueProforma } from "../repository/proforma-command.repository";
import { repoGetProforma, repoListProformas, repoPreviewExistingProforma } from "../repository/proforma-read.repository";

export const svcPreviewProforma = (input: ProformaDraftBodyDTO) => buildProformaPreview(pool, input, false);
export const svcCreateProforma = (args: Parameters<typeof repoCreateProforma>[0]) => repoCreateProforma(args);
export const svcIssueProforma = (args: Parameters<typeof repoIssueProforma>[0]) => repoIssueProforma(args);
export const svcDecideDeliveryPrepaymentTerms = (args: Parameters<typeof repoDecideDeliveryPrepaymentTerms>[0]) => repoDecideDeliveryPrepaymentTerms(args);
export const svcListProformas = (query: ProformaListQueryDTO) => repoListProformas(query);
export const svcGetProforma = (id: string) => repoGetProforma(id);
export const svcPreviewExistingProforma = (id: string) => repoPreviewExistingProforma(id);
