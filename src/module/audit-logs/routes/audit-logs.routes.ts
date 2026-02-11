import { Router } from "express";
import { authenticateToken } from "../../auth/middlewares/auth.middleware";
import { createAuditLog, listAuditLogs } from "../controllers/audit-logs.controller";

const router = Router();

router.post("/", authenticateToken, createAuditLog);
router.get("/", authenticateToken, listAuditLogs);

export default router;
