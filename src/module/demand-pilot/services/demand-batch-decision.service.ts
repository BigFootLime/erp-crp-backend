import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError } from "../../../utils/httpError";
import { decideDemand } from "../repository/demand-pilot.repository";
export const batchDecisionSchema = z
  .object({
    client_id: z.string().trim().min(1).max(80),
    action: z.enum(["ACCEPT", "REJECT", "REVIEW"]),
    reason: z.string().trim().max(2000).optional(),
    revisions: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            version: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    (b) => new Set(b.revisions.map((r) => r.id)).size === b.revisions.length,
    "Sélection dupliquée.",
  );
export async function decideBatch(
  body: z.infer<typeof batchDecisionSchema>,
  userId: number,
  key: string,
) {
  const results = [];
  for (const row of body.revisions) {
    const h = createHash("sha256")
      .update("demand-batch:" + key + ":" + row.id)
      .digest("hex");
    const subkey =
      h.slice(0, 8) +
      "-" +
      h.slice(8, 12) +
      "-5" +
      h.slice(13, 16) +
      "-a" +
      h.slice(17, 20) +
      "-" +
      h.slice(20, 32);
    try {
      const result = await decideDemand({
        clientId: body.client_id,
        id: row.id,
        expectedVersion: row.version,
        action: body.action,
        actor: { userId },
        reason: body.reason,
        idempotencyKey: subkey,
      });
      results.push({
        id: row.id,
        status: result.data.status,
        replayed: result.replayed,
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      results.push({ id: row.id, status: "EXCEPTION", message: e.message });
    }
  }
  return { results };
}
