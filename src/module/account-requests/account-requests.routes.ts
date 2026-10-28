import { Router } from "express";

import { accountRequestRateLimit, accountRequestStatusRateLimit } from '../auth/middlewares/auth-rate-limit.middleware';
import * as controller from "./account-requests.controller";

export const publicAccountRequestRouter = Router();
publicAccountRequestRouter.post('/account-requests', accountRequestRateLimit, controller.submit);
publicAccountRequestRouter.get('/account-requests/status', accountRequestStatusRateLimit, controller.status);

export const adminAccountRequestRouter = Router();
// This router is mounted beneath the already protected admin router. A router-
// wide guard here would also run for unrelated parent routes after the mount.
// Standalone fixtures must compose the same three parent guards explicitly.
adminAccountRequestRouter.get("/account-requests", controller.list);
adminAccountRequestRouter.get("/account-requests/:id/company-access-options", controller.companyAccessOptions);
adminAccountRequestRouter.post("/account-requests/:id/approve", controller.approve);
adminAccountRequestRouter.post("/account-requests/:id/reject", controller.reject);
adminAccountRequestRouter.delete("/account-requests/:id", controller.purge);
