import { Router, type RequestHandler } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireRecentMfa } from "../../auth/middlewares/mfa-assurance.middleware";
import { isSuperadmin } from "../../access-control/services/access-control.service";
import { HttpError } from "../../../utils/httpError";
import * as controller from "../controllers/data-cutover.controller";
import type { CutoverAccess } from "../types/data-cutover.types";

const router = Router();
router.use(authenticateToken);
router.use((req, res, next) => {
  if (!req.user?.id) { next(new HttpError(401, "UNAUTHORIZED", "Authentification requise.")); return; }
  void isSuperadmin(req.user.id).then((admin) => {
    res.locals.cutoverAccess = { userId: req.user!.id, isSuperadmin: admin } satisfies CutoverAccess;
    res.setHeader("Cache-Control", "private, no-store");
    next();
  }).catch(next);
});
const onlySuperadmin: RequestHandler = (_req, res, next) => {
  if (!(res.locals.cutoverAccess as CutoverAccess).isSuperadmin) { next(new HttpError(403, "CUTOVER_SUPERADMIN_REQUIRED", "Seul le SuperAdmin prépare les périmètres et valide les dossiers de reprise.")); return; }
  next();
};
const recentAssurance: RequestHandler = (req, res, next) => {
  if ((res.locals.cutoverAccess as CutoverAccess).isSuperadmin && req.user?.mfa !== true) {
    next(new HttpError(403, "MFA_REQUIRED", "Une authentification MFA est requise pour modifier la préparation en tant que SuperAdmin.")); return;
  }
  requireRecentMfa()(req, res, next);
};

router.get("/capabilities", controller.capabilities);
router.get("/lookups/:entity", onlySuperadmin, controller.lookup);
router.get("/batches", controller.list);
router.post("/batches", onlySuperadmin, recentAssurance, controller.create);
router.get("/batches/:id", controller.detail);
router.get("/batches/:id/rows", controller.rows);
router.patch("/batches/:id/rows/:rowId", recentAssurance, controller.patchRow);
router.post("/batches/:id/preview", onlySuperadmin, recentAssurance, controller.preview);
router.post("/batches/:id/validate", onlySuperadmin, recentAssurance, controller.validate);
// An export contains the complete source package, including personal and
// commercial data. It therefore requires the same fresh MFA assurance as a
// preparation change, even though the operation itself is read-only.
router.get("/batches/:id/export", onlySuperadmin, recentAssurance, controller.exportPackage);
router.get("/batches/:id/contributors", onlySuperadmin, controller.contributors);
router.post("/batches/:id/contributors", onlySuperadmin, recentAssurance, controller.assignContributor);
router.post("/batches/:id/application-preview", onlySuperadmin, recentAssurance, controller.applicationPreview);
router.post("/batches/:id/apply", onlySuperadmin, recentAssurance, controller.apply);
router.get("/batches/:id/applications", onlySuperadmin, recentAssurance, controller.applications);
router.get("/batches/:id/openings", onlySuperadmin, recentAssurance, controller.openings);
router.get("/batches/:id/evidence", onlySuperadmin, recentAssurance, controller.evidence);
router.post("/batches/:id/rows/:rowId/evidence", onlySuperadmin, recentAssurance, controller.linkEvidence);

export default router;
