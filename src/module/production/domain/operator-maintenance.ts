import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
const uuid = z.string().uuid();
const reason = z.string().trim().min(3).max(500);
const date = z.string().date();
export const maintenanceCounter = z
  .number()
  .finite()
  .min(0)
  .max(99_999_999_999)
  .refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.0001,
    "Trois décimales au maximum.",
  );
const base = { idempotency_key: uuid };
export const maintenanceCommand = z
  .discriminatedUnion("action", [
    z
      .object({
        ...base,
        action: z.literal("AUTHORIZE"),
        plan_id: uuid,
        user_id: z.number().int().positive(),
        enabled: z.boolean(),
        valid_from: date,
        valid_to: date,
        reason,
        document_id: uuid,
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("READ_COUNTER"),
        plan_id: uuid,
        expected_version: z.number().int().positive(),
        value: maintenanceCounter,
        reset: z.boolean(),
        next_due_counter: maintenanceCounter.nullable(),
        reason,
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("COMPLETE"),
        plan_id: uuid,
        expected_version: z.number().int().positive(),
        document_id: uuid,
        counter_value: maintenanceCounter.nullable(),
        notes: z.string().trim().min(3).max(4000),
        results: z
          .array(
            z
              .object({
                id: z.string().trim().min(1).max(80),
                completed: z.literal(true),
                conform: z.boolean(),
                note: z.string().trim().max(1000).nullable(),
              })
              .strict(),
          )
          .min(1)
          .max(100),
      })
      .strict(),
    z
      .object({
        ...base,
        action: z.literal("RESOLVE"),
        hold_id: uuid,
        document_id: uuid,
        reason,
      })
      .strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.action === "AUTHORIZE" && input.valid_to < input.valid_from)
      ctx.addIssue({
        code: "custom",
        path: ["valid_to"],
        message: "La fin de validité précède son début.",
      });
    if (input.action === "COMPLETE")
      for (const result of input.results)
        if (!result.conform && (!result.note || result.note.length < 3))
          ctx.addIssue({
            code: "custom",
            path: ["results"],
            message: "Décrivez chaque anomalie.",
          });
  });
export type MaintenanceCommand = z.infer<typeof maintenanceCommand>;
export type MaintenanceChecklistItem = {
  id: string;
  label: string;
  blocks_machine?: boolean;
};
export function validateMaintenanceResults(
  checklist: MaintenanceChecklistItem[],
  results: Extract<MaintenanceCommand, { action: "COMPLETE" }>["results"],
) {
  const expected = new Set(checklist.map((item) => item.id));
  const submitted = new Set(results.map((item) => item.id));
  if (
    !checklist.length ||
    expected.size !== checklist.length ||
    submitted.size !== results.length ||
    results.length !== checklist.length ||
    results.some((item) => !expected.has(item.id))
  )
    throw new HttpError(
      422,
      "MAINTENANCE_CHECKLIST_INCOMPLETE",
      "Réalisez tous les contrôles de la checklist courante, une fois chacun.",
    );
  return results.filter(
    (result) =>
      !result.conform &&
      checklist.find((item) => item.id === result.id)?.blocks_machine !== false,
  );
}
export function maintenanceManager(roles: (string | null | undefined)[]) {
  const accepted = new Set([
    "directeur",
    "gerant",
    "administrateur systeme et reseau",
    "responsable maintenance",
    "maintenance",
  ]);
  return roles.some((role) =>
    accepted.has(
      (role ?? "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase(),
    ),
  );
}
