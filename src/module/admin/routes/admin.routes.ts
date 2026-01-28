// src/module/admin/routes/admin.routes.ts
import { Router } from "express";
import {
  listUsersAdmin,
  listLoginLogsAdmin,
  resetUserPasswordAdmin,
  getAdminAnalytics,
} from "../controllers/admin.controller";

const router = Router();

// NOTE: put your auth/role middlewares here IF you already have them
// router.use(authMiddleware)
// router.use(requireRole("Administrateur Systeme et Reseau"))

router.get("/users", listUsersAdmin);
router.get("/login-logs", listLoginLogsAdmin);
router.get("/analytics", getAdminAnalytics);
router.patch("/users/:id/password", resetUserPasswordAdmin);

export default router;
