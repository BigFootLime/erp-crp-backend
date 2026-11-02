import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { createSecureUpload } from "../../../shared/uploads/secure-upload";
import {
  recordCarco,
  getCarco,
  submitCarco,
  bindCarco,
} from "../services/carco-review.service";
import { exportCarco } from "../services/carco-return";

const router = Router();
const scopeFields = z.object({
  client_id: z.string().trim().min(1).max(80),
  external_site: z.string().trim().min(1).max(80),
});
function scope(raw: unknown) {
  const fields = scopeFields.parse(raw);
  return { clientId: fields.client_id, site: fields.external_site };
}
router.post(
  "/",
  createSecureUpload("import-tabular", { storage: "memory" }).single("file"),
  asyncHandler(async (req, res) => {
    const input = scopeFields
      .extend({
        source_version: z.string().trim().min(1).max(160),
        source_as_of: z.string().datetime({ offset: true }),
        complete_snapshot: z.enum(["true", "false"]).default("false"),
      })
      .parse(req.body);
    if (!req.file)
      throw new HttpError(
        400,
        "CARCO_FILE_REQUIRED",
        "Sélectionnez un fichier Excel ou CSV.",
      );
    const s = scope(input);
    const id = await recordCarco(
      s,
      input.source_version,
      input.source_as_of,
      input.complete_snapshot === "true",
      req.file,
      req.user!.id,
    );
    res.json(await getCarco(s, id));
  }),
);
router.get(
  "/latest",
  asyncHandler(async (req, res) => {
    res.json({ review: await getCarco(scope(req.query)) });
  }),
);
router.get(
  "/:id/return.csv",
  asyncHandler(async (req, res) => {
    const csv = await exportCarco(
      scope(req.query),
      z.string().uuid().parse(req.params.id),
    );
    res.setHeader("Cache-Control", "no-store");
    res
      .attachment("retour-CLAYENS.csv")
      .type("text/csv; charset=utf-8")
      .send(csv);
  }),
);
router.post(
  "/:id/bind",
  asyncHandler(async (req, res) => {
    const input = z
      .object({
        row_number: z.number().int().min(2),
        schedule_key: z.string().trim().min(1).max(160),
      })
      .parse(req.body);
    const s = scope(req.body),
      id = z.string().uuid().parse(req.params.id);
    await bindCarco(s, id, input.row_number, input.schedule_key, req.user!.id);
    res.json(await getCarco(s, id));
  }),
);
router.post(
  "/:id/submit",
  asyncHandler(async (req, res) => {
    res.json(
      await submitCarco(
        scope(req.body),
        z.string().uuid().parse(req.params.id),
        req.user!.id,
        z.string().uuid().parse(req.header("Idempotency-Key")),
        z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .parse(req.body.qualification_hash),
      ),
    );
  }),
);
export default router;
