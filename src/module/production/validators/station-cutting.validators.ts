import { z } from "zod";
import {
  startExecutionSchema,
  pauseExecutionSchema,
  resumeExecutionSchema,
  stopExecutionSchema,
  finishOperationPreviewSchema,
  finishOperationSchema,
} from "./production-execution.validators";

const zeroQuantities = {
  qty_good: z.literal(0).default(0),
  qty_scrap: z.literal(0).default(0),
  qty_rework: z.literal(0).default(0),
  qty_pending_control: z.literal(0).default(0),
  complete_operation: z.literal(true),
  stop_active_segment: z.literal(true).default(true),
};
const segment = <T extends z.ZodTypeAny>(payload: T) =>
  z
    .object({
      id: z.string().uuid(),
      payload,
    })
    .strict();

/** The transport carries no operator identity, retroactive clock or new quantities. */
export const cuttingExecutionCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("start"),
      payload: startExecutionSchema.shape.body
        .pick({
          of_id: true,
          operation_id: true,
          machine_id: true,
          activity_code: true,
        })
        .extend({
          operation_id: z.string().uuid(),
          activity_code: z.literal("PRODUCTION"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("pause"),
      payload: segment(pauseExecutionSchema.shape.body.strict().default({})),
    })
    .strict(),
  z
    .object({
      command: z.literal("resume"),
      payload: segment(
        resumeExecutionSchema.shape.body
          .pick({
            activity_code: true,
            comment: true,
          })
          .extend({
            activity_code: z.literal("PRODUCTION").default("PRODUCTION"),
          })
          .strict()
          .default({}),
      ),
    })
    .strict(),
  z
    .object({
      command: z.literal("stop"),
      payload: segment(
        stopExecutionSchema.shape.body
          .pick({ comment: true })
          .strict()
          .default({}),
      ),
    })
    .strict(),
  z
    .object({
      command: z.literal("preview-finish"),
      payload: finishOperationPreviewSchema.shape.body
        .extend(zeroQuantities)
        .strict(),
    })
    .strict(),
  z
    .object({
      command: z.literal("finish"),
      payload: finishOperationSchema.shape.body.extend(zeroQuantities).strict(),
    })
    .strict(),
]);
export type CuttingExecutionCommand = z.infer<
  typeof cuttingExecutionCommandSchema
>;
