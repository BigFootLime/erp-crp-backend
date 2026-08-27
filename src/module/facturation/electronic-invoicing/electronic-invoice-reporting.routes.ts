import { Router } from "express";

import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";
import {
  createEReportingPayment,
  createEReportingTransaction,
  listEReportingPeriods,
} from "./electronic-invoice-reporting.controller";

const router = Router();

router.get("/reporting-periods", requireFinanceCapability("ereporting_read"), listEReportingPeriods);
router.post("/reporting-transactions", requireFinanceCapability("ereporting_submit"), createEReportingTransaction);
router.post("/reporting-payments", requireFinanceCapability("ereporting_submit"), createEReportingPayment);

export default router;
