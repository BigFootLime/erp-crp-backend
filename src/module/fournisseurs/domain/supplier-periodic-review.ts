import { z } from "zod";

export const reviewDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Date invalide.");
const reason = z.string().trim().min(3).max(500);
const score = z.number().int().min(0).max(5).nullable();
const policy = z
  .object({
    action: z.literal("CONFIGURE"),
    idempotency_key: z.string().uuid(),
    domaine_code: z.string().trim().min(1).max(80).nullable(),
    enabled: z.boolean(),
    cadence_months: z.number().int().min(1).max(60),
    first_due: reviewDate,
    owner_id: z.number().int().positive(),
    reason,
  })
  .strict();
const evaluation = z
  .object({
    action: z.literal("EVALUATE"),
    idempotency_key: z.string().uuid(),
    scope_id: z.string().uuid(),
    expected_policy_id: z.string().uuid(),
    period_from: reviewDate,
    period_to: reviewDate,
    evaluated_on: reviewDate,
    next_due: reviewDate,
    outcome: z.enum(["SATISFACTORY", "RESERVATIONS", "UNSATISFACTORY"]),
    quality_score: score,
    delivery_score: score,
    responsiveness_score: score,
    observations: z.string().trim().min(3).max(4000),
    actions: z.string().trim().min(3).max(4000),
    version_id: z.string().uuid(),
    supersedes_id: z.string().uuid().nullable(),
    correction_reason: reason.nullable(),
  })
  .strict();
export const supplierReviewCommand = z
  .discriminatedUnion("action", [policy, evaluation])
  .superRefine((input, ctx) => {
    if (input.action !== "EVALUATE") return;
    if (input.period_to < input.period_from)
      ctx.addIssue({
        code: "custom",
        path: ["period_to"],
        message: "La fin de période précède son début.",
      });
    if (input.evaluated_on < input.period_to)
      ctx.addIssue({
        code: "custom",
        path: ["evaluated_on"],
        message: "L’évaluation doit suivre la période examinée.",
      });
    if (input.next_due <= input.evaluated_on)
      ctx.addIssue({
        code: "custom",
        path: ["next_due"],
        message: "L’échéance suivante doit être postérieure à l’évaluation.",
      });
    if (Boolean(input.supersedes_id) !== Boolean(input.correction_reason))
      ctx.addIssue({
        code: "custom",
        path: ["correction_reason"],
        message:
          "Une correction doit désigner l’évaluation et expliquer son motif.",
      });
  });
export type SupplierReviewCommand = z.infer<typeof supplierReviewCommand>;
/** Calendar cadence with end-of-month clamping, never JavaScript date rollover. */
export function reviewNextDate(value: string, months: number): string {
  const [y, m, d] = value.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const end = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, end));
  return target.toISOString().slice(0, 10);
}
