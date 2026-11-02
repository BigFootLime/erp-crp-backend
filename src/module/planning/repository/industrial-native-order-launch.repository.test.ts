import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../utils/httpError";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock("../../commande-client/repository/commande-client.repository", () => ({
  repoGenerateAffairesFromOrderTx: mocks.launch,
}));
import { tryLaunchSimpleFirmOrderViaNativeWorkflowTx } from "./industrial-native-order-launch.repository";

const audit = {
  user_id: 7,
  user_role: "Planificateur",
  ip: null,
  user_agent: null,
  device_type: null,
  os: null,
  browser: null,
  path: "/planning",
  page_key: "planning",
  client_session_id: "test",
};
const input = {
  order_id: 11,
  order_line_id: 22,
  qty_to_produce: 100,
  expected_updated_at: "2026-11-02T08:00:00Z",
  firm_source_ids: ["firm:schedule-1"],
};

describe("industrial native firm order launch", () => {
  const query = vi.fn();
  beforeEach(() => {
    query.mockReset();
    mocks.launch.mockReset();
    query.mockImplementation((sql: string) => {
      if (sql.includes("AS correct_quantity FROM public.ordres_fabrication"))
        return Promise.resolve({ rows: [{ id: 41, correct_quantity: true }] });
      if (sql.includes("SELECT c.updated_at"))
        return Promise.resolve({
          rows: [
            {
              updated_at: input.expected_updated_at,
              due_date: "2026-11-10",
              order_type: "FERME",
              creation_flow_version: 1,
              line_count: 1,
              schedule_count: 1,
              contract_bound: false,
              already_launched: false,
              shipped: false,
            },
          ],
        });
      return Promise.resolve({ rows: [] });
    });
    mocks.launch.mockResolvedValue({
      root_of_ids: [41],
      idempotent_replay: false,
    });
  });
  it("uses the ordinary order workflow once for the proven one-line firm scope", async () => {
    await expect(
      tryLaunchSimpleFirmOrderViaNativeWorkflowTx(
        { query } as never,
        input,
        audit,
      ),
    ).resolves.toMatchObject({ status: "LAUNCHED" });
    expect(mocks.launch).toHaveBeenCalledWith(
      expect.anything(),
      "11",
      expect.objectContaining({
        decision: "SHIP_ALL_TOGETHER",
        lines: [
          { commande_ligne_id: 22, qty_ship_now: 0, qty_to_produce: 100 },
        ],
      }),
      audit,
    );
  });
  it.each([
    [{ ...input, firm_source_ids: ["a", "b"] }, null, "Plusieurs échéances"],
    [
      input,
      {
        order_type: "FERME",
        line_count: 1,
        contract_bound: true,
        already_launched: false,
      },
      "contrat",
    ],
    [
      input,
      {
        order_type: "FERME",
        line_count: 1,
        contract_bound: false,
        already_launched: true,
      },
      "déjà lancée",
    ],
    [
      input,
      {
        order_type: "FERME",
        line_count: 2,
        contract_bound: false,
        already_launched: false,
      },
      "Plusieurs lignes",
    ],
    [
      input,
      {
        order_type: "FERME",
        line_count: 1,
        contract_bound: false,
        already_launched: false,
        creation_flow_version: 2,
      },
      "validation ADV",
    ],
    [
      input,
      {
        order_type: "FERME",
        line_count: 1,
        contract_bound: false,
        already_launched: false,
        shipped: true,
      },
      "partiellement expédiée",
    ],
  ] as const)(
    "keeps an unsafe variant in review",
    async (candidate, change, reason) => {
      if (change)
        query.mockImplementation((sql: string) => {
          if (sql.includes("SELECT c.updated_at"))
            return Promise.resolve({
              rows: [
                {
                  updated_at: input.expected_updated_at,
                  due_date: "2026-11-10",
                  creation_flow_version: 1,
                  schedule_count: 1,
                  shipped: false,
                  ...change,
                },
              ],
            });
          return Promise.resolve({ rows: [] });
        });
      await expect(
        tryLaunchSimpleFirmOrderViaNativeWorkflowTx(
          { query } as never,
          candidate,
          audit,
        ),
      ).resolves.toMatchObject({
        status: "REVIEW",
        reason: expect.stringContaining(reason),
      });
      expect(mocks.launch).not.toHaveBeenCalled();
    },
  );
  it("rolls back a native workflow guard and returns review without an OF", async () => {
    mocks.launch.mockRejectedValue(
      new HttpError(409, "COMMAND_CHECKPOINT", "Checkpoint ADV actif"),
    );
    await expect(
      tryLaunchSimpleFirmOrderViaNativeWorkflowTx(
        { query } as never,
        input,
        audit,
      ),
    ).resolves.toMatchObject({
      status: "REVIEW",
      reason: expect.stringContaining("Checkpoint ADV"),
    });
    expect(query).toHaveBeenCalledWith(
      "ROLLBACK TO SAVEPOINT industrial_native_order_launch",
    );
  });
});
