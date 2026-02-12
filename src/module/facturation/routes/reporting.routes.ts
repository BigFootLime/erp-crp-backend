import { Router } from "express";
import { commercialOutstanding, commercialRevenue, commercialTopClients } from "../controllers/reporting.controller";

const router = Router();

router.get("/commercial/revenue", commercialRevenue);
router.get("/commercial/outstanding", commercialOutstanding);
router.get("/commercial/top-clients", commercialTopClients);

export default router;
