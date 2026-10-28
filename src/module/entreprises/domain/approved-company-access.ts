import { z } from "zod";
const version = z.number().int().min(0).max(2_147_483_646);
export const approvedCompanyAccessUpdateSchema = z.object({
  source_site: z.enum(["cerp_prod", "cerp_test"]),
  source_membership_version: version,
  source_hash: z.string().regex(/^[a-f0-9]{64}$/),
  company_access: z.array(z.object({
    company_id: z.string().uuid().transform(value => value.toLowerCase()),
    expected_company_version: version,
    expected_membership_version: version,
    enabled: z.boolean(),
  }).strict()).max(1000).refine(rows => new Set(rows.map(row => row.company_id)).size === rows.length, "Entreprises dupliquées"),
}).strict();
