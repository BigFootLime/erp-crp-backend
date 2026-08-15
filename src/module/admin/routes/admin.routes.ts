// src/module/admin/routes/admin.routes.ts
import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { requireSuperadmin } from "../../access-control/middlewares/require-superadmin";
import {
  createPasswordResetTokenAdmin,
  createAccountInvitationAdmin,
  createUserAdmin,
  getUserAdmin,
  listRolesAdmin,
  listUsersAdmin,
  listLoginLogsAdmin,
  resetUserPasswordAdmin,
  getAdminAnalytics,
  patchUserAdmin,
} from "../controllers/admin.controller";
import { getOperationsConsole } from "../controllers/operations-console.controller";

const router = Router();

router.use(authenticateToken);
// Account administration is a sensitive exception to the open-by-default
// module model. The live database marker is authoritative; role labels and a
// granted Administration module can never authorize account provisioning.
router.use(requireSuperadmin);

router.get("/users", listUsersAdmin);
router.get("/roles", listRolesAdmin);
router.get("/users/:id", getUserAdmin);
router.post("/users", createUserAdmin);
router.patch("/users/:id", patchUserAdmin);
router.post("/users/:id/invitations", createAccountInvitationAdmin);

router.get("/login-logs", listLoginLogsAdmin);
router.get("/analytics", getAdminAnalytics);
router.get("/operations", getOperationsConsole);

router.post("/users/:id/password-reset-token", createPasswordResetTokenAdmin);
router.patch("/users/:id/password", resetUserPasswordAdmin);

export default router;
