import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { signPilotFixtureSession } from "./industrial-pilot-session.fixture";
import PDFDocument from "pdfkit";
import request from "supertest";
import { expect } from "vitest";
import pool from "../../config/database";
import { errorHandler } from "../../middlewares/errorHandler";
import dossierRouter from "../../module/operation-dossiers/routes/operation-dossiers.routes";
import { repoUpsertOperationDossier } from "../../module/operation-dossiers/repository/operation-dossiers.repository";
import productionRouter from "../../module/production/routes/production.routes";
import executionRouter from "../../module/production/routes/production-execution.routes";
import { repoGetOfReadiness } from "../../module/production/repository/production.repository";
import planningRouter from "../../module/planning/routes/planning.routes";
import {
  repoCreateExecution,
  repoOfOperationExecutionContext,
  repoPreviewExecution,
} from "../../module/qualite/repository/quality-360.repository";

type Placement = {
  phase: number;
  resource: string;
  start: string;
  end: string;
};

async function instructionPdf() {
  const document = new PDFDocument();
  const chunks: Buffer[] = [];
  const bytes = new Promise<Buffer>((resolve, reject) => {
    document.on("data", (part: Buffer) => chunks.push(part));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
  });
  document.text(
    "Recette locale CERP. Effectuer le controle dimensionnel de la piece temoin.",
  );
  document.end();
  return bytes;
}

/** Exercise the official workshop release after technical approval. The PDF,
 * inspection plan and scheduling evidence belong to the local test fixture. */
export async function releasePilotOf(
  ofId: number,
  actorId: number,
  slots: Placement[],
) {
  const target = new URL(
    process.env.DATABASE_URL ?? "postgres://localhost/off",
  );
  if (
    process.env.NODE_ENV !== "test" ||
    process.env.CERP_E2E_ISOLATED !== "1" ||
    target.pathname !== "/cerp_test" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)
  )
    throw new Error(
      "Workshop release fixture requires isolated local cerp_test.",
    );
  const root = await mkdtemp(join(tmpdir(), "cerp-pilot-release-"));
  const previous = {
    JWT_SECRET: process.env.JWT_SECRET,
    CERP_STORAGE_ROOT: process.env.CERP_STORAGE_ROOT,
    CERP_DOCUMENTS_ROOT: process.env.CERP_DOCUMENTS_ROOT,
    CERP_TMP_ROOT: process.env.CERP_TMP_ROOT,
  };
  const secret = randomBytes(48).toString("hex");
  Object.assign(process.env, {
    JWT_SECRET: secret,
    CERP_STORAGE_ROOT: root,
    CERP_DOCUMENTS_ROOT: join(root, "documents"),
    CERP_TMP_ROOT: join(root, "tmp"),
  });
  try {
    const { user, token } = await signPilotFixtureSession(actorId);
    const authorization = "Bearer " + token;
    const audit = {
      user_id: actorId,
      role: user.role,
      request_id: null,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      path: "/api/v1/production",
      page_key: "production",
      client_session_id: null,
    };
    const app = express()
      .use(express.json())
      .use("/api/v1/planning", planningRouter)
      .use("/api/v1/dossiers", dossierRouter)
      .use("/api/v1/production/execution", executionRouter)
      .use("/api/v1/production", productionRouter)
      .use(errorHandler);
    const release = () =>
      request(app)
        .post(`/api/v1/production/ofs/${ofId}/release`)
        .set("Authorization", authorization)
        .send({ override: false });
    await request(app)
      .post(`/api/v1/production/ofs/${ofId}/release`)
      .send({ override: false })
      .expect(401);
    const before = await repoGetOfReadiness({ id: ofId });
    expect(before?.blockers).toContain("CAPACITY_OR_CALENDAR_MISSING");
    const refused = await release();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.code).toBe("OF_OPERATION_START_REQUIRED");
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM public.of_release_decisions WHERE of_id=$1",
          [ofId],
        )
      ).rows[0].n,
    ).toBe(0);

    const operations = (
      await pool.query<{ id: string; phase: number }>(
        "SELECT id::text,phase FROM public.of_operations WHERE of_id=$1 ORDER BY phase,id",
        [ofId],
      )
    ).rows;
    expect(operations.length).toBeGreaterThan(0);
    const operator = (
      await pool.query<{ id: number }>(
        "INSERT INTO public.users(username,password,role,status,email) VALUES($1,'DISABLED_TEST_CREDENTIAL','Employee','Active',$2) RETURNING id",
        [
          "OP-" + ofId + "-" + randomUUID().slice(0, 8),
          randomUUID() + "@example.invalid",
        ],
      )
    ).rows[0];
    await pool.query("INSERT INTO public.user_role_assignments(user_id, role_key, assigned_by) VALUES ($1,'Employee',$2),($1,'Opérateur atelier',$2)", [operator.id, actorId]);
    const operatorAuth =
      "Bearer " + (await signPilotFixtureSession(operator.id)).token;
    const start = (key: string, version?: string) =>
      request(app)
        .post("/api/v1/production/execution")
        .set("Authorization", operatorAuth)
        .set("Idempotency-Key", key)
        .send({
          of_id: ofId,
          operation_id: operations[0].id,
          activity_code: "PRODUCTION",
          expected_readiness_version: version,
        });
    const tooEarly = await start(randomUUID());
    expect(tooEarly.status, JSON.stringify(tooEarly.body)).toBe(409);
    expect(tooEarly.body.code).toBe("OPERATION_NOT_READY");
    const dossierPath = `/api/v1/production/ofs/${ofId}`;
    const prepared = await request(app)
      .get(dossierPath + "/dossier")
      .set("Authorization", authorization)
      .expect(200);
    const complete = await request(app)
      .post(dossierPath + "/complete")
      .set("Authorization", authorization)
      .send({
        expectedVersion: prepared.body.version,
        idempotencyKey: randomUUID(),
      });
    expect(complete.status, JSON.stringify(complete.body)).toBe(200);
    expect(complete.body.status).toBe("COMPLETE");
    const pdf = await instructionPdf();
    for (const op of operations) {
      const slot = slots.find((s) => s.phase === op.phase);
      if (!slot?.resource.startsWith("machine:"))
        throw new Error("Missing simulated machine slot for phase " + op.phase);
      const planned = await request(app)
        .post("/api/v1/planning/events")
        .set("Authorization", authorization)
        .send({
          of_id: ofId,
          of_operation_id: op.id,
          machine_id: slot.resource.slice("machine:".length),
          start_ts: slot.start,
          end_ts: slot.end,
          status: "PLANNED",
        });
      expect(planned.status, JSON.stringify(planned.body)).toBe(201);
      const dossier = await repoUpsertOperationDossier({
        operation_type: "OF_OPERATION",
        operation_id: op.id,
        dossier_type: "TECHNIQUE",
        title: "Instruction de recette",
        audit,
      });
      const attached = await request(app)
        .post(`/api/v1/dossiers/${dossier.id}/versions`)
        .set("Authorization", authorization)
        .attach("documents[DOC_01]", pdf, "instruction-recette.pdf");
      expect(attached.status, JSON.stringify(attached.body)).toBe(201);
    }

    const context = await repoOfOperationExecutionContext(
      ofId,
      operations[0].id,
    );
    const preview = await repoPreviewExecution(context.source, true);
    await repoCreateExecution({
      actor: audit,
      idempotencyKey: randomUUID(),
      ofSnapshotOnly: true,
      body: { ...context.source, preview_sha256: preview.snapshot_sha256 },
    });
    const ready = await repoGetOfReadiness({ id: ofId });
    expect(ready?.blockers).toEqual([]);
    const read = await request(app)
      .get(dossierPath + "/operation-readiness")
      .set("Authorization", authorization)
      .expect(200);
    const op = read.body.operations.find(
      (entry: { id: string }) => entry.id === operations[0].id,
    );
    expect(op?.canStart, JSON.stringify(op?.blockers)).toBe(true);
    const key = randomUUID();
    const accepted = await start(key, read.body.version);
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
    const replay = await start(key, read.body.version);
    expect(replay.status, JSON.stringify(replay.body)).toBe(201);
    expect(replay.body.id).toBe(accepted.body.id);
    const saved = (
      await pool.query(
        `SELECT o.numero,o.statut::text,
      (SELECT count(*)::int FROM public.of_release_decisions d
       WHERE d.of_id=o.id AND d.decision='RELEASED' AND NOT d.override) AS releases
      FROM public.ordres_fabrication o WHERE o.id=$1`,
        [ofId],
      )
    ).rows[0];
    expect(saved).toMatchObject({ statut: "EN_COURS", releases: 1 });
    const receipt = (
      await pool.query(
        "SELECT decided_by,blocker_codes,evidence FROM public.of_release_decisions WHERE of_id=$1 AND decision='RELEASED'",
        [ofId],
      )
    ).rows[0];
    expect(receipt).toMatchObject({
      decided_by: operator.id,
      blocker_codes: [],
      evidence: {
        scope: "OPERATION_START",
        pointage_id: accepted.body.id,
        operation_authorization: {
          operation: { id: operations[0].id, canStart: true },
        },
      },
    });
    expect(receipt.evidence.dossier_validation_id).toBeTruthy();
    expect(ready?.evidence.planned_event_count).toBeGreaterThanOrEqual(
      operations.length,
    );
    expect(ready?.evidence.quality_plan_count).toBeGreaterThanOrEqual(1);
    expect(ready?.evidence.reservation_count).toBeGreaterThanOrEqual(1);
    const logs = await pool.query(
      "SELECT id::text,status FROM public.production_pointages WHERE of_id=$1",
      [ofId],
    );
    expect(logs.rows).toEqual([{ id: accepted.body.id, status: "RUNNING" }]);
    return saved;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
