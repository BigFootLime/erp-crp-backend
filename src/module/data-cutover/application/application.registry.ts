import { createCutoverApplicationService } from "./application.service";
import { cutoverOrdersAdapter } from "./orders/orders.adapter";
import { openingApplicationAdapters } from "./openings/openings.adapter";
import { cutoverReferenceAdapters } from "./references/references.adapter";

export const cutoverApplication = createCutoverApplicationService([
  ...cutoverReferenceAdapters,
  cutoverOrdersAdapter,
  ...openingApplicationAdapters,
]);
