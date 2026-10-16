import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createAuditLog, listAuditLogs } from "../controllers/audit-logs.controller";
import { requireSensitiveCapability } from "../../access-control/middlewares/sensitive-capability.middleware";

const router = Router();

router.post("/", authenticateToken, createAuditLog);
router.get("/", authenticateToken, requireSensitiveCapability("audit.read"), listAuditLogs);

export default router;
