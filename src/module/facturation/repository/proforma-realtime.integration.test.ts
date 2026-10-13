import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
vi.mock("../../../config/database", () => ({ default: { query: vi.fn(), connect: vi.fn() } }));
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";

describe("proforma events — actual realtime contract validation", () => {
  it.each([
    { entityType: "PROFORMA", entityId: "10000000-0000-4000-8000-000000000001", module: "facturation" },
    { entityType: "PROFORMA_AFFAIR", entityId: "affair-12", module: "facturation" },
    { entityType: "DELIVERY_PREPAYMENT", entityId: "12", module: "livraisons" },
  ])("publishes only the owned module/entity targets for $entityType", async identity => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if(sql.includes("realtime_stream_enqueue_state")) return { rows: [{ stream_ordinal: "1" }] };
      if(sql.includes("INSERT INTO public.erp_outbox_events")) return { rows: [{ event_id: values?.[5] }] };
      return { rows: [] };
    });
    const tx = { query } as unknown as Pick<PoolClient,"query">;
    await expect(enqueueEntityChanged(tx, { ...identity, action: "updated", at: "2026-10-13T19:00:00.000Z", invalidateKeys: ["proformas","delivery-affairs"] },
      { deduplicationKey: `recipe:${identity.entityType}` })).resolves.toMatch(/^[0-9a-f-]{36}$/);
    const insert = query.mock.calls.find(([sql]) => sql.includes("INSERT INTO public.erp_outbox_events"))!;
    const envelope = JSON.parse(String(insert[1]?.[4]));
    expect(envelope.input.targets).toEqual([{ scope: "module", moduleKey: identity.module }, { scope: "entity", entityType: identity.entityType, entityId: identity.entityId }]);
  });
  it("does not broadcast Finance entities into the delivery module", async () => {
    const query = vi.fn();
    expect(() => enqueueEntityChanged({query} as unknown as Pick<PoolClient,"query">,
      { entityType:"PROFORMA",entityId:"PF-ID",module:"livraisons",action:"updated",at:"2026-10-13T19:00:00.000Z",invalidateKeys:["proformas"] },
      {deduplicationKey:"recipe:wrong-module"})).toThrow("INVALID_REALTIME_ENTITY_TARGET");
    expect(query).not.toHaveBeenCalled();
  });
});
