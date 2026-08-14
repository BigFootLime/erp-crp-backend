import { Router } from "express";

import { electronicInvoiceWebhookRateLimit } from "../../auth/middlewares/auth-rate-limit.middleware";
import { receiveElectronicInvoiceWebhook } from "./electronic-invoice.controller";

const router = Router();

// No JWT: the selected provider authenticates this route through its adapter's
// signed webhook contract. The raw body is captured before JSON parsing.
router.post("/:providerCode", electronicInvoiceWebhookRateLimit, receiveElectronicInvoiceWebhook);

export default router;
