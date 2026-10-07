import { z } from "zod";
import { HttpError } from "../../../utils/httpError";

export const approvalScopeSchema = z
  .object({
  client_id: z.string().trim().min(1).max(3),
    product_article_id: z.string().uuid().nullable().default(null),
    purchase_article_id: z.string().uuid().nullable().default(null),
    domaine_code: z.string().trim().min(1).max(80),
  })
  .strict();
export const approvalRevisionInputSchema = z
  .object({
    scope: approvalScopeSchema,
    expected_revision_id: z.string().uuid().nullable(),
    required: z.boolean(),
    suspended: z.boolean().default(false),
    exclusive: z.boolean().default(false),
    valid_from: z.string().date(),
    valid_to: z.string().date().nullable(),
    supplier_ids: z.array(z.string().uuid()).max(100),
    evidence_version_id: z.string().uuid(),
    reason: z.string().trim().min(3).max(500),
    idempotency_key: z.string().uuid(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.valid_to && input.valid_to < input.valid_from)
      ctx.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "La fin de validité précède son début.",
      });
    if (new Set(input.supplier_ids).size !== input.supplier_ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["supplier_ids"],
        message: "Un fournisseur ne doit apparaître qu’une fois.",
      });
    if (input.required && !input.suspended && !input.supplier_ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["supplier_ids"],
        message: "Renseignez au moins un fournisseur agréé.",
      });
    if (input.exclusive && (!input.required || input.supplier_ids.length !== 1))
      ctx.addIssue({
        code: "custom",
        path: ["supplier_ids"],
        message: "L’exclusivité exige un seul fournisseur agréé.",
      });
    if (!input.required && input.supplier_ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["supplier_ids"],
        message: "Une levée d’exigence ne sélectionne aucun fournisseur.",
      });
  });
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;
export type ApprovalRevisionInput = z.infer<typeof approvalRevisionInputSchema>;
export type ApprovalEvidence = {
  document_id: string;
  version_id: string;
  code: string;
  title: string;
  version_number: number;
  filename: string;
  sha256: string;
  size_bytes: number;
};
export type ApprovalPolicy = ApprovalScope & {
  scope_id: string;
  revision_id: string;
  revision: number;
  required: boolean;
  suspended: boolean;
  exclusive: boolean;
  valid_from: string;
  valid_to: string | null;
  supplier_ids: string[];
  evidence: ApprovalEvidence;
  evidence_applicable: boolean;
  reason: string;
  created_at: string;
};
export type PurchaseClientContext = {
  line_id: string;
  client_id: string;
  product_article_id: string | null;
  purchase_article_id: string | null;
  of_id: number | null;
  domains: string[];
};
export type ApprovalCheck = {
  line_id: string;
  client_id: string;
  product_article_id: string | null;
  purchase_article_id: string | null;
  of_id: number | null;
  domain: string;
  status: "VALID" | "NOT_REQUIRED" | "NOT_CONFIGURED" | "BLOCKED";
  policies: ApprovalPolicy[];
  reason: string | null;
};

export function evaluateClientApproval(
  context: PurchaseClientContext,
  domain: string,
  supplierId: string,
  policies: ApprovalPolicy[],
  today: string,
): ApprovalCheck {
  // Every applicable general or more specific scope must permit the supplier.
  const applicable = policies.filter(
    (policy) =>
      policy.client_id === context.client_id &&
      policy.domaine_code === domain &&
      (!policy.product_article_id ||
        policy.product_article_id === context.product_article_id) &&
      (!policy.purchase_article_id ||
        policy.purchase_article_id === context.purchase_article_id),
  );
  let reason: string | null = null;
  for (const policy of applicable) {
    if (policy.suspended) {
      reason = "Agrément suspendu";
      break;
    }
    if (
      policy.valid_from > today ||
      (policy.valid_to && policy.valid_to < today)
    ) {
      reason = "Agrément hors de sa période de validité";
      break;
    }
    if (!policy.evidence_applicable) {
      reason = "Justificatif approuvé à renouveler";
      break;
    }
    if (policy.required && !policy.supplier_ids.includes(supplierId)) {
      reason = policy.exclusive
        ? "Fournisseur exclusif différent"
        : "Fournisseur absent de la liste agréée";
      break;
    }
  }
  return {
    line_id: context.line_id,
    client_id: context.client_id,
    product_article_id: context.product_article_id,
    purchase_article_id: context.purchase_article_id,
    of_id: context.of_id,
    domain,
    policies: applicable,
    reason,
    status: reason
      ? "BLOCKED"
      : !applicable.length
        ? "NOT_CONFIGURED"
        : applicable.some((p) => p.required)
          ? "VALID"
          : "NOT_REQUIRED",
  };
}
export function assertClientApprovals(checks: ApprovalCheck[]): void {
  const blocked = checks.filter((check) => check.status === "BLOCKED");
  if (blocked.length)
    throw new HttpError(
      409,
      "CLIENT_SUPPLIER_APPROVAL_NOT_VALID",
      "Le fournisseur ne respecte pas un agrément exigé par le client. Faites vérifier le périmètre, la validité et le justificatif par la Qualité.",
      { checks: blocked },
    );
}
