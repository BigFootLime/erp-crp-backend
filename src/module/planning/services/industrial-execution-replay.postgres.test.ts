import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pool from "../../../config/database";
import { executeIndustrialProposals } from "./industrial-proposal-execution.service";
import type { AuditContext } from "../repository/planning.repository";

const target = new URL(process.env.DATABASE_URL ?? "postgres://localhost/off");
const isolated =
  process.env.CERP_E2E_ISOLATED === "1" &&
  process.env.CERP_DEMAND_POSTGRES_TEST === "1" &&
  target.pathname === "/cerp_test" &&
  ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);

describe.skipIf(!isolated)(
  "Industrial execution receipts on isolated PostgreSQL",
  () => {
    const runId = randomUUID(),
      prefix = randomUUID();
    const command = { proposal_indexes: [0], request_key: prefix + "-AxB" };
    let audit: AuditContext;

    beforeAll(async () => {
      const actor = (
        await pool.query(
          "SELECT id FROM public.users WHERE is_superadmin ORDER BY id LIMIT 1",
        )
      ).rows[0].id;
      audit = {
        user_id: actor,
        role: "superadmin",
        ip: null,
        user_agent: null,
        device_type: null,
        os: null,
        browser: null,
        path: null,
        page_key: null,
        client_session_id: null,
      };
      await pool.query(`INSERT INTO public.clients(client_id,client_code,company_name)
      VALUES ('IRQ','IRQ','Recette décisions industrielles') ON CONFLICT (client_id) DO NOTHING`);
      await pool.query(
        `INSERT INTO public.industrial_plan_runs(id,client_id,start,label,capacity_percent,status,created_by)
      VALUES($1,'IRQ',current_date,'Recette historique',100,'READY',$2)`,
        [runId, actor],
      );
      const hash = createHash("sha256")
        .update(JSON.stringify({ runId, command }))
        .digest("hex");
      await pool.query(
        `INSERT INTO public.industrial_proposal_executions(
      run_id,proposal_index,action,status,request_key,request_hash,source_digest,reason,created_by)
      VALUES($1,0,'REVIEW','REVIEW',$2,$3,'historical','Contrôle historique',$4)`,
        [runId, command.request_key + ":0", hash, actor],
      );
    });
    afterAll(() => pool.end());

    it("replays a committed decision only on the exact actor and request key", async () => {
      await expect(
        executeIndustrialProposals(runId, command, audit),
      ).resolves.toMatchObject({ replayed: true });
      await expect(
        executeIndustrialProposals(
          runId,
          { ...command, proposal_indexes: [1] },
          audit,
        ),
      ).rejects.toMatchObject({ code: "INDUSTRIAL_EXECUTION_KEY_CONFLICT" });
      for (const key of [prefix + "-A_B", prefix + "-A%", prefix + "-AxB:0"]) {
        await expect(
          executeIndustrialProposals(
            runId,
            { ...command, request_key: key },
            audit,
          ),
        ).rejects.toMatchObject({ code: "PLAN_NOT_VALIDATED" });
      }
      await expect(
        executeIndustrialProposals(runId, command, { ...audit, user_id: -1 }),
      ).rejects.toMatchObject({ code: "PLAN_NOT_VALIDATED" });
    });
  },
);
