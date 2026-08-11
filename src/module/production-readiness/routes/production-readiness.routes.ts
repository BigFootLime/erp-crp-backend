import { Router } from "express";

import {
  createCalendarClosure,
  createProductionCalendar,
  deleteCalendarClosure,
  listProductionCalendars,
  readProductionReadiness,
  updateProductionCalendar,
} from "../controllers/production-readiness.controller";
import { requireProductionReadinessCapability } from "../middlewares/production-readiness-authorization.middleware";
import {
  calendarIdParamSchema,
  closureIdParamSchema,
  productionCalendarClosureSchema,
  productionCalendarSchema,
  updateProductionCalendarSchema,
  validate,
} from "../validators/production-readiness.validators";

const router = Router();

router.get("/", requireProductionReadinessCapability("view"), readProductionReadiness);
router.get("/calendars", requireProductionReadinessCapability("view"), listProductionCalendars);
router.post(
  "/calendars",
  requireProductionReadinessCapability("calendar_write"),
  validate(productionCalendarSchema, "body"),
  createProductionCalendar
);
router.patch(
  "/calendars/:calendarId",
  requireProductionReadinessCapability("calendar_write"),
  validate(calendarIdParamSchema, "params"),
  validate(updateProductionCalendarSchema, "body"),
  updateProductionCalendar
);
router.post(
  "/calendars/:calendarId/closures",
  requireProductionReadinessCapability("calendar_write"),
  validate(calendarIdParamSchema, "params"),
  validate(productionCalendarClosureSchema, "body"),
  createCalendarClosure
);
router.delete(
  "/calendars/:calendarId/closures/:closureId",
  requireProductionReadinessCapability("calendar_write"),
  validate(closureIdParamSchema, "params"),
  deleteCalendarClosure
);

export default router;
