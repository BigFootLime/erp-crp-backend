import { Router, type RequestHandler } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { HttpError } from "../../../utils/httpError";
import { healthProgrammations, listProgrammations } from "../controllers/programmation.controller";

function isAdminRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("admin") || r.includes("administrateur");
}

function isProductionRole(role: string | undefined): boolean {
  if (!role) return false;
  const r = role.trim().toLowerCase();
  return r.includes("production") || r.includes("atelier");
}

const requireProductionOrAdmin: RequestHandler = (req, _res, next) => {
  const role = req.user?.role;
  if (!isAdminRole(role) && !isProductionRole(role)) {
    next(new HttpError(403, "FORBIDDEN", "Production role required"));
    return;
  }
  next();
};

const router = Router();

router.use(authenticateToken);
router.use(requireProductionOrAdmin);

router.get("/health", healthProgrammations);
router.get("/", listProgrammations);

export default router;
