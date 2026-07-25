import { Router } from "express";
import { commercialOutstanding, commercialRevenue, commercialTopClients } from "../controllers/reporting.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();

router.get("/commercial/revenue", requireFinanceCapability("reporting_read"), commercialRevenue);
router.get("/commercial/outstanding", requireFinanceCapability("reporting_read"), commercialOutstanding);
router.get("/commercial/top-clients", requireFinanceCapability("reporting_read"), commercialTopClients);

export default router;
