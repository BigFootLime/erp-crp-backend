// src/module/billers/routes/billers.routes.ts
import { Router } from "express";
import { listBillers } from "../controllers/billers.controller";

const router = Router();
router.get("/", listBillers);
export default router;
