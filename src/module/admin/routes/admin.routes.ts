// src/module/admin/routes/admin.routes.ts
import { Router } from "express";
import { authenticateToken, authorizeRole } from "../../auth/middlewares/auth.middleware";
import {
  createPasswordResetTokenAdmin,
  createUserAdmin,
  deleteUserAdmin,
  getUserAdmin,
  listUsersAdmin,
  listLoginLogsAdmin,
  resetUserPasswordAdmin,
  getAdminAnalytics,
  patchUserAdmin,
} from "../controllers/admin.controller";

const router = Router();

router.use(authenticateToken);
router.use(authorizeRole("Administrateur Systeme et Reseau", "Directeur"));

router.get("/users", listUsersAdmin);
router.get("/users/:id", getUserAdmin);
router.post("/users", createUserAdmin);
router.patch("/users/:id", patchUserAdmin);
router.delete("/users/:id", deleteUserAdmin);

router.get("/login-logs", listLoginLogsAdmin);
router.get("/analytics", getAdminAnalytics);

router.post("/users/:id/password-reset-token", createPasswordResetTokenAdmin);
router.patch("/users/:id/password", resetUserPasswordAdmin);

export default router;
