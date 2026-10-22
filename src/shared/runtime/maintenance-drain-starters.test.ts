import { describe, expect, it, vi } from "vitest";

import { startElectronicInvoiceMaintenance } from "../../module/facturation/electronic-invoicing/electronic-invoice.service";
import { startEReportingMaintenance } from "../../module/facturation/electronic-invoicing/electronic-invoice-reporting.service";
import { startReminderMaintenance } from "../../module/facturation/services/reminder-job.service";
import { startWebhookDeliveryMaintenance } from "../../module/integrations/webhooks/webhook.service";
import { startAuthoritativePdfArchiveMaintenance } from "../authoritative-documents/authoritative-document.worker";
import { startPlanningForecastMaintenance } from "../../module/planning/services/planning-forecast.worker";
import { startDurationLearningMaintenance } from "../../module/planning/services/duration-learning.worker";
import { startCumpProjectionMaintenance } from "../../module/stock/services/cump-projection.worker";

type Stop = () => void | Promise<void>;

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release: () => release?.() };
}

async function assertStarterDrains(
  start: (cycle: () => Promise<void>) => Stop,
  advance: () => Promise<void> = async () => undefined,
  advanceBeforeWait = false,
): Promise<void> {
  const gate = deferred();
  const cycle = vi.fn(() => gate.promise);
  const stop = start(cycle);
  if (advanceBeforeWait) await advance();
  await vi.waitFor(() => expect(cycle).toHaveBeenCalledTimes(1));

  let stopped = false;
  const stopping = Promise.resolve(stop()).then(() => { stopped = true; });
  await advance();
  expect(stopped).toBe(false);
  expect(cycle).toHaveBeenCalledTimes(1);

  gate.release();
  await stopping;
  await advance();
  expect(cycle).toHaveBeenCalledTimes(1);
}

describe("maintenance starters drain their real active cycle", () => {
  it("drains electronic invoicing before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startElectronicInvoiceMaintenance({ cycle }));
  });

  it("drains e-reporting before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startEReportingMaintenance({ cycle }));
  });

  it("drains reminder processing before another cycle can start", async () => {
    vi.useFakeTimers();
    try {
      await assertStarterDrains(
        (cycle) => startReminderMaintenance({
          ADV_REMINDERS_JOB_ENABLED: "true",
          ADV_REMINDERS_JOB_INTERVAL_MS: "60000",
        }, { cycle }),
        async () => { await vi.advanceTimersByTimeAsync(120_000); },
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains webhook delivery before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startWebhookDeliveryMaintenance({ cycle }));
  });

  it("drains authoritative PDF archiving before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startAuthoritativePdfArchiveMaintenance({ cycle }));
  });

  it("drains planning forecasting before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startPlanningForecastMaintenance({ cycle }));
  });

  it("drains duration learning before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startDurationLearningMaintenance({ cycle }));
  });

  it("drains CUMP projection before another cycle can start", async () => {
    await assertStarterDrains((cycle) => startCumpProjectionMaintenance({ cycle }));
  });
});
