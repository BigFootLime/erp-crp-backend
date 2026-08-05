import { Router } from "express";

import {
  approveReminder,
  cancelReminder,
  createReminderPolicy,
  getReminderReadiness,
  getReminderClientPreference,
  listClientReminderHistory,
  listInvoiceReminderHistory,
  listReminderPolicies,
  listReminderSuggestions,
  retireReminderPolicy,
  retryReminder,
  runReminderCycleNow,
  sendReminder,
  upsertReminderClientPreference,
  validateReminderPolicy,
} from "../controllers/reminders.controller";
import { requireFinanceCapability } from "../middlewares/finance-authorization.middleware";

const router = Router();

router.get("/readiness", requireFinanceCapability("reminder_read"), getReminderReadiness);
router.get("/policies", requireFinanceCapability("reminder_read"), listReminderPolicies);
router.post("/policies", requireFinanceCapability("reminder_policy_manage"), createReminderPolicy);
router.post("/policies/:id/validate", requireFinanceCapability("reminder_policy_manage"), validateReminderPolicy);
router.post("/policies/:id/retire", requireFinanceCapability("reminder_policy_manage"), retireReminderPolicy);

router.get("/suggestions", requireFinanceCapability("reminder_read"), listReminderSuggestions);
router.post("/cycles", requireFinanceCapability("reminder_job_run"), runReminderCycleNow);
router.post("/suggestions/:id/approve", requireFinanceCapability("reminder_approve"), approveReminder);
router.post("/suggestions/:id/send", requireFinanceCapability("reminder_send"), sendReminder);
router.post("/suggestions/:id/retry", requireFinanceCapability("reminder_retry"), retryReminder);
router.post("/suggestions/:id/cancel", requireFinanceCapability("reminder_approve"), cancelReminder);

router.get("/invoices/:id/history", requireFinanceCapability("reminder_read"), listInvoiceReminderHistory);
router.get("/clients/:id/history", requireFinanceCapability("reminder_read"), listClientReminderHistory);
router.get("/clients/:id/preferences", requireFinanceCapability("reminder_read"), getReminderClientPreference);
router.put("/clients/:id/preferences", requireFinanceCapability("reminder_opt_out_manage"), upsertReminderClientPreference);

export default router;
