import request from "supertest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

const mocks = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientQuery: vi.fn(),
  clientRelease: vi.fn(),
}));

vi.mock("pg", () => {
  const emitter = new EventEmitter();

  const pool = {
    on: emitter.on.bind(emitter),
    query: mocks.poolQuery,
    connect: mocks.poolConnect,
  };

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });

  return {
    Pool: vi.fn(() => pool),
    __emitter__: emitter,
  };
});

vi.mock("../utils/checkNetworkDrive", () => ({
  checkNetworkDrive: vi.fn(() => Promise.resolve()),
}));

vi.mock("../module/auth/middlewares/auth.middleware", () => ({
  authenticateToken: (req: { user?: { id: number; role: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 1, role: "Atelier" };
    next();
  },
  authorizeRole:
    (...roles: string[]) =>
    (req: { user?: { role: string } }, res: { status: (n: number) => { json: (b: unknown) => unknown } }, next: () => void) => {
      if (req.user && roles.includes(req.user.role)) {
        next();
        return;
      }
      res.status(403).json({ error: "Accès interdit" });
    },
}));

import app from "../config/app";

beforeEach(() => {
  mocks.poolQuery.mockReset();
  mocks.poolConnect.mockReset();
  mocks.clientQuery.mockReset();
  mocks.clientRelease.mockReset();

  mocks.poolConnect.mockResolvedValue({
    query: mocks.clientQuery,
    release: mocks.clientRelease,
  });
});

describe("/api/v1/production machine intelligence", () => {
  it("GET /api/v1/production/machine-models returns catalog entries with instance counts", async () => {
    mocks.poolQuery
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-1111-1111-111111111111",
            model_code: "MATSUURA_VX_1000",
            manufacturer: "Matsuura",
            model: "VX-1000",
            display_name: "Matsuura VX-1000",
            machine_type: "MILLING",
            axes_count: 3,
            description: "Vertical machining center",
            source_summary: "Official Matsuura references",
            is_active: true,
            source_confidence: "official",
            instances_count: 2,
            created_at: "2026-06-12T08:00:00.000Z",
            updated_at: "2026-06-12T08:00:00.000Z",
          },
        ],
      });

    const res = await request(app).get("/api/v1/production/machine-models").set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 1,
      items: [
        {
          model_code: "MATSUURA_VX_1000",
          display_name: "Matsuura VX-1000",
          instances_count: 2,
          source_confidence: "official",
        },
      ],
    });
    expect(String(mocks.poolQuery.mock.calls[1]?.[0])).toContain("production_machine_models");
  });

  it("GET /api/v1/production/machine-models/:id/capabilities returns model capabilities", async () => {
    const modelId = "11111111-1111-1111-1111-111111111111";

    mocks.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            id: modelId,
            model_code: "TAKUMI_VC1052",
            manufacturer: "Takumi",
            model: "VC1052",
            display_name: "Takumi VC1052",
            machine_type: "MILLING",
            axes_count: 3,
            description: null,
            source_summary: null,
            is_active: true,
            source_confidence: "official",
            instances_count: 2,
            created_at: "2026-06-12T08:00:00.000Z",
            updated_at: "2026-06-12T08:00:00.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "22222222-2222-2222-2222-222222222222",
            machine_model_id: modelId,
            process_type: "3-axis milling",
            material_family: "Aluminium",
            capability_level: "preferred",
            notes: "High-speed vertical milling profile.",
            source_url: "https://takumicnc.fr/centres-usinage-cnc-3-axes-table-croisee/vc1052/",
            source_confidence: "official",
          },
        ],
      });

    const res = await request(app)
      .get(`/api/v1/production/machine-models/${modelId}/capabilities`)
      .set("Authorization", "Bearer fake");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      expect.objectContaining({
        process_type: "3-axis milling",
        material_family: "Aluminium",
        capability_level: "preferred",
      }),
    ]);
  });

  it("POST /api/v1/production/machines/onboarding creates model intelligence and the physical machine", async () => {
    const modelId = "11111111-1111-1111-1111-111111111111";
    const machineId = "33333333-3333-3333-3333-333333333333";

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: modelId,
            model_code: "HURCO-VM10",
            manufacturer: "Hurco",
            model: "VM10",
            display_name: "Hurco VM10",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: machineId,
            code: "VM10-01",
            name: "Hurco VM10 #1",
            type: "MILLING",
            status: "ACTIVE",
            machine_model_id: modelId,
            display_name: "VM10 #1",
            brand: "Hurco",
            model: "VM10",
            serial_number: null,
            commissioned_year: null,
            image_path: null,
            hourly_rate: 0,
            currency: "EUR",
            is_available: true,
            dashboard_color: null,
            model_3d_path: null,
            documentation_url: null,
            documentation_source: null,
            scheduling_enabled: true,
            outillage_enabled: true,
            location: "Atelier principal",
            workshop_zone: "Zone fraisage",
            notes: null,
            created_at: "2026-06-15T08:00:00.000Z",
            updated_at: "2026-06-15T08:00:00.000Z",
            created_by: 1,
            updated_by: 1,
            archived_at: null,
            archived_by: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-06-15T08:00:00.000Z" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/api/v1/production/machines/onboarding")
      .set("Authorization", "Bearer fake")
      .send({
        machine: {
          code: "VM10-01",
          name: "Hurco VM10 #1",
          type: "MILLING",
          display_name: "VM10 #1",
          brand: "Hurco",
          model: "VM10",
          hourly_rate: 0,
          currency: "EUR",
          status: "ACTIVE",
          is_available: true,
          scheduling_enabled: true,
          outillage_enabled: true,
          location: "Atelier principal",
          workshop_zone: "Zone fraisage",
        },
        machine_model: {
          manufacturer: "Hurco",
          model: "VM10",
          display_name: "Hurco VM10",
          machine_type: "MILLING",
          axes_count: 3,
        },
        specs: {
          x_travel_mm: 661,
          y_travel_mm: 407,
          z_travel_mm: 508,
          table_length_mm: 762,
          table_width_mm: 406,
          max_table_load_kg: 1500,
          spindle_taper: "CAT 40",
          spindle_speed_max_rpm: 12000,
          spindle_power_kw: 11,
          tool_magazine_capacity: 24,
          compatible_holders: ["CAT 40"],
        },
        capabilities: [{ process_type: "Fraisage 3 axes", material_family: "Aluminium", capability_level: "preferred" }],
        tooling: [{ holder_type: "CAT 40", spindle_taper: "CAT 40", compatible: true }],
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: machineId,
      code: "VM10-01",
      machine_model_id: modelId,
      manufacturer: "Hurco",
      model_name: "VM10",
    });

    const sqlCalls = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlCalls).toContain("production_machine_models");
    expect(sqlCalls).toContain("production_machine_specs");
    expect(sqlCalls).toContain("production_machine_capabilities");
    expect(sqlCalls).toContain("production_machine_tooling");
    expect(sqlCalls).toContain("INSERT INTO machines");
    expect(mocks.clientRelease).toHaveBeenCalled();
  });

  it("PATCH /api/v1/production/machines/:id/onboarding updates the physical machine and model intelligence", async () => {
    const modelId = "11111111-1111-1111-1111-111111111111";
    const machineId = "33333333-3333-3333-3333-333333333333";

    mocks.clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{ id: machineId, machine_model_id: modelId, archived_at: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: modelId,
            model_code: "HURCO-VM10",
            manufacturer: "Hurco",
            model: "VM10",
            display_name: "Hurco VM10",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: machineId,
            code: "VM10-01",
            name: "Hurco VM10 cellule 1",
            type: "MILLING",
            status: "ACTIVE",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ id: "audit-1", created_at: "2026-06-15T08:00:00.000Z" }] })
      .mockResolvedValueOnce({ rows: [] });

    mocks.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: machineId,
          code: "VM10-01",
          name: "Hurco VM10 cellule 1",
          type: "MILLING",
          status: "ACTIVE",
          machine_model_id: modelId,
          model_display_name: "Hurco VM10",
          manufacturer: "Hurco",
          model_name: "VM10",
          display_name: "VM10 cellule 1",
          brand: "Hurco",
          model: "VM10",
          serial_number: null,
          commissioned_year: null,
          image_path: null,
          hourly_rate: 0,
          currency: "EUR",
          is_available: true,
          dashboard_color: null,
          model_3d_path: "/models/machines/cnc-01.glb",
          documentation_url: null,
          documentation_source: null,
          scheduling_enabled: true,
          outillage_enabled: true,
          location: "Atelier principal",
          workshop_zone: "Zone fraisage",
          notes: "Centre prioritaire production.",
          created_at: "2026-06-15T08:00:00.000Z",
          updated_at: "2026-06-15T09:00:00.000Z",
          created_by: 1,
          updated_by: 1,
          archived_at: null,
          archived_by: null,
        },
      ],
    });

    const res = await request(app)
      .patch(`/api/v1/production/machines/${machineId}/onboarding`)
      .set("Authorization", "Bearer fake")
      .send({
        machine: {
          code: "VM10-01",
          name: "Hurco VM10 cellule 1",
          type: "MILLING",
          machine_model_id: modelId,
          display_name: "VM10 cellule 1",
          brand: "Hurco",
          model: "VM10",
          hourly_rate: 0,
          currency: "EUR",
          status: "ACTIVE",
          is_available: true,
          model_3d_path: "/models/machines/cnc-01.glb",
          scheduling_enabled: true,
          outillage_enabled: true,
          location: "Atelier principal",
          workshop_zone: "Zone fraisage",
          notes: "Centre prioritaire production.",
        },
        specs: {
          x_travel_mm: 661,
          y_travel_mm: 407,
          z_travel_mm: 508,
          spindle_taper: "CAT 40",
          spindle_speed_max_rpm: 12000,
          spindle_power_kw: 11,
          spindle_torque_nm: 72.4,
          tool_magazine_capacity: 24,
          max_tool_diameter_mm: 80,
          compatible_holders: ["CAT 40"],
        },
        capabilities: [{ process_type: "Fraisage 3 axes", material_family: "Aluminium", capability_level: "preferred" }],
        tooling: [{ holder_type: "CAT 40", spindle_taper: "CAT 40", compatible: true }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: machineId,
      code: "VM10-01",
      name: "Hurco VM10 cellule 1",
      machine_model_id: modelId,
      manufacturer: "Hurco",
      model_name: "VM10",
    });

    const sqlCalls = mocks.clientQuery.mock.calls.map((call) => String(call[0])).join("\n");
    expect(sqlCalls).toContain("production_machine_specs");
    expect(sqlCalls).toContain("spindle_torque_nm");
    expect(sqlCalls).toContain("production_machine_capabilities");
    expect(sqlCalls).toContain("production_machine_tooling");
    expect(sqlCalls).toContain("UPDATE machines");
    expect(JSON.stringify(mocks.clientQuery.mock.calls)).toContain("production.machines.onboarding.update");
    expect(mocks.clientRelease).toHaveBeenCalled();
  });
});
