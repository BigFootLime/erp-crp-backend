import {type Request,type Response,type RequestHandler} from "express";
import { z } from "zod";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { sendSecureStoredFile } from "../../../shared/uploads/secure-download";
import * as ged from "../../ged/services/ged.service";
import { downloadOfGedVersion } from "../services/terminal-document.service";
import * as station from "../../production/services/station.service";
import { svcDownloadSelfInspection } from "../../production/services/production-workbench.service";
import { reprintDocument } from "../../production/services/of-versioning.service";
import { downloadReceptionDocumentSVC } from "../../receptions/services/receptions.service";
import {
  getDocumentStoragePath,
  resolveCerpStoragePath,
} from "../../../utils/cerpStorage";
import * as execution from "../../production/services/production-execution.service";
import { releasePreviousIntervention } from "../../production/repository/automatic-intervention.repository";
import * as ev from "../../production/validators/production-execution.validators";
import { stationHandoverSchema } from "../../production/validators/station.validators";
import * as quality from "../../qualite/services/quality-360.service";
import * as qv from "../../qualite/validators/quality-360.validators";
import * as auth from "../repository/terminal-auth.repository";
import * as dossier from "../repository/terminal-dossier.repository";
import {
  identifyTerminal,
  requireModule,
} from "../services/terminal-auth.service";
import {
  operatorDossier,
  assertStartAllowed,
  assertPointageScope,
  resolveOperatorScan,
} from "../services/terminal-operator.service";
import { pinFingerprint } from "../domain/terminal-policy";
import * as v from "../validators/terminals.validators";

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res).catch(next);
  };
const actor = (req: Request) => ({ id: req.user!.id, role: req.user!.role });
const audit = (req: Request) => ({
  user_id: req.user!.id,
  user_role: req.user!.role,
  role: req.user!.role,
  request_id: null,
  ip: req.ip ?? null,
  user_agent: req.get("user-agent") ?? null,
  device_type: "ANDROID_TERMINAL",
  os: "Android",
  browser: null,
  path: req.path,
  page_key: "terminal.operator",
  client_session_id: req.station?.session_id ?? null,
});
const key = (req: Request) => v.commandKey.parse(req.get("Idempotency-Key"));
const scope = (req: Request) =>
  v.scopeSchema.parse({
    of_id: req.params.of_id,
    operation_id: req.params.operation_id,
  });
const controlInput = z
  .object({
    trigger: z.enum(["FIRST_ARTICLE", "IN_PROCESS", "FINAL", "PERIODIC"]),
    population: z.number().finite().positive(),
    unite: z.string().min(1).max(16),
    preview_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

// admin.get '/'
export const listTerminals = handle(async (_req, res) =>
  res.json(await auth.listTerminals()),
);

// admin.get '/options'
export const adminOptions = handle(async (_req, res) => {
  res.json(await auth.terminalAdminOptions());
});

// admin.patch '/:id'
export const updateTerminal = handle(async (req, res) => {
  const id = v.uuid.parse(req.params.id);
  const body = z
    .object({
      machine_id: v.uuid.nullable(),
      warehouse_id: v.uuid.nullish(),
      scanner_prefix: z.string().min(1).max(16),
      scanner_suffix: z.enum(["ENTER", "TAB"]),
    })
    .strict()
    .parse(req.body);
  await auth.updateTerminalSettings(id, body, req.user!.id);
  res.json({ saved: true });
});

// admin.post '/'
export const enrollTerminal = handle(async (req, res) => {
  const body = v.enrollSchema.parse(req.body);
  if(body.warehouse_id&&!(await pool.query('SELECT id FROM public.magasins WHERE id=$1::uuid',[body.warehouse_id])).rows.length)
    throw new HttpError(422,'TERMINAL_WAREHOUSE_UNKNOWN','Choisissez un magasin existant.');
  if (!['OPERATOR','RECEPTION','OF_PROCUREMENT'].includes(body.kind))
    throw new HttpError(
      422,
      "TERMINAL_PILOT_ONLY",
      "Cette application n’est pas encore disponible.",
    );
  const device = await station.svcEnrollDevice({
    actor: actor(req),
    body: {
      label: body.label,
      site: body.site_code,
      assignment_mode: body.kind==='OPERATOR'?"FIXED":"MOBILE",
      machine_id: body.machine_id,
      auto_lock_seconds: body.auto_lock_seconds,
      session_max_seconds: body.session_max_seconds,
      code_prefix: "TAB",
    },
  });
  res
    .status(201)
    .json(await auth.enrollTerminal(body, device.id, req.user!.id));
});

// admin.post '/:id/pairing'
export const renewPairing = handle(async (req, res) =>
  res.json(
    await auth.transaction((tx) =>
      auth.createPairing(tx, v.uuid.parse(req.params.id), req.user!.id),
    ),
  ),
);

// admin.post '/:id/revoke'
export const revokeTerminal = handle(async (req, res) => {
  await auth.revokeTerminal(
    v.uuid.parse(req.params.id),
    req.user!.id,
    v.revokeSchema.parse(req.body).reason,
  );
  res.json({ revoked: true });
});

// admin.put '/pins'
export const setPin = handle(async (req, res) => {
  const b = v.pinSchema.parse(req.body);
  await auth.setPin(
    b.site_code,
    b.user_id,
    pinFingerprint(b.site_code, b.pin),
    req.user!.id,
  );
  res.json({ saved: true });
});

// admin.post '/pins/revoke'
export const revokePin = handle(async (req, res) => {
  const b = v.pinSchema.omit({ pin: true }).parse(req.body);
  await auth.revokePin(b.site_code, b.user_id, req.user!.id);
  res.json({ revoked: true });
});

// router.post '/pair'
export const pairTerminal = handle(async (req, res) => {
  const b = v.pairingSchema.parse(req.body);
  res.json(await auth.pairTerminal(b.code, b.kind));
});

// router.get '/bootstrap'
export const bootstrapTerminal = handle(async (req, res) =>
  res.json({
    terminal: req.terminal,
    server_time: new Date().toISOString(),
    contract_version: 1,
    web_url: process.env.FRONTEND_URL ?? null,
  }),
);

// router.post '/identify'
export const identifyOperator = handle(async (req, res) => {
  const b = v.identifySchema.parse(req.body);
  res.json(await identifyTerminal(req.terminal!, b.pin, b.app_version));
});

// router.get '/session'
export const getSession = handle(async (req, res) =>
  res.json({
    session_id: req.station!.session_id,
    user: req.station!.user,
    machine_id: req.station!.machine_id,
    server_time: new Date().toISOString(),
  }),
);

// router.post '/session/activity'
export const recordActivity = handle(async (req, res) => {
  await auth.touchTerminalSession(req.station!.session_id);
  res.json({ active: true });
});

// router.post '/session/lock'
export const lockSession = handle(async (req, res) =>
  res.json(
    await station.svcLock({
      station: req.station!,
      body: { reason: "MANUAL" },
    }),
  ),
);

// router.post '/session/close'
export const closeSession = handle(async (req, res) => {
  await auth.closeTerminalSession(
    req.station!.session_id,
    req.terminal!.id,
    req.user!.id,
  );
  res.json({ closed: true });
});

// router.get '/operator/worklist'
export const getWorklist = handle(async (req, res) =>
  res.json(
    await dossier.plannedWorklist(
      req.terminal!,
      z.coerce
        .number()
        .int()
        .min(0)
        .max(100000)
        .default(0)
        .parse(req.query.offset),
    ),
  ),
);

// router.get '/operator/activities'
export const listActivities = handle(async (_req, res) =>
  res.json(
    await execution.svcListActivityCategories({ include_disabled: false }),
  ),
);

// router.post '/operator/scan'
export const resolveScan = handle(async (req, res) => {
  const b = z
    .object({ code: z.string().trim().min(1).max(256) })
    .strict()
    .parse(req.body);
  const result = await resolveOperatorScan(req.terminal!, b.code);
  await auth.audit(
    pool,
    req.terminal!.id,
    req.user!.id,
    "OF_SCAN_RESOLVED",
    result,
  );
  res.json(result);
});

// router.get base
export const getDossier = handle(async (req, res) => {
  const s = scope(req);
  res.json(
    await operatorDossier(req.terminal!, req.station!, s.of_id, s.operation_id),
  );
});

// router.post `${base}/handover`
export const createHandover = handle(async (req, res) => {
  const s = scope(req);
  await dossier.operationContext(req.terminal!, s.of_id, s.operation_id);
  const b = stationHandoverSchema
    .omit({ of_id: true, operation_id: true, pointage_id: true })
    .strict()
    .parse(req.body);
  const receiver = await auth.isSiteOperator(
    req.terminal!.site_code,
    b.incoming_user_id,
  );
  if (!receiver)
    throw new HttpError(
      422,
      "TERMINAL_HANDOVER_RECIPIENT",
      "Choisissez un opérateur actif de ce site.",
    );
  await requireModule(b.incoming_user_id, "production");
  res.json(
    await station.svcCreateHandover({
      station: req.station!,
      body: { ...b, ...s },
      idempotencyKey: key(req),
    }),
  );
});

// router.get `${base}/documents/:id`
export const downloadDocument = handle(async (req, res) => {
  const s = scope(req);
  const context = await dossier.operationContext(
    req.terminal!,
    s.of_id,
    s.operation_id,
  );
  const manifest = await dossier.dossierDocuments(context);
  const doc = manifest.find(
    (d) => d.id === v.uuid.parse(req.params.id) && d.available,
  );
  if (!doc)
    throw new HttpError(
      404,
      "TERMINAL_DOCUMENT_OUTSIDE_SCOPE",
      "Document absent du dossier applicable.",
    );
  if (doc.source === "OF_DOCUMENT") {
    const { pdf } = await reprintDocument(s.of_id, doc.id, audit(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="OF-${s.of_id}.pdf"`,
    );
    res.send(pdf);
    return;
  }
  if (doc.source === "MATERIAL_CERTIFICATE" && doc.reception_id) {
    const file = await downloadReceptionDocumentSVC(
      doc.reception_id,
      doc.id,
      audit(req),
    );
    if (!file)
      throw new HttpError(
        404,
        "TERMINAL_DOCUMENT_UNAVAILABLE",
        "Certificat indisponible.",
      );
    const root = getDocumentStoragePath("receptions");
    await sendSecureStoredFile(res, {
      filePath: resolveCerpStoragePath(file.storage_path, root),
      allowedRoots: [root],
      filename: file.original_name,
      mimeType: file.mime_type,
      expectedSha256: doc.sha256 ?? undefined,
      download: true,
    });
    return;
  }
  if (doc.source === "SELF_INSPECTION") {
    const pdf = await svcDownloadSelfInspection(s.of_id, doc.id, audit(req));
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="autocontrole-OF-${s.of_id}.pdf"`,
    );
    res.setHeader("X-CERP-Document-SHA256", doc.sha256 ?? "");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(pdf);
    return;
  }
  const file = await downloadOfGedVersion(actor(req), context, doc.id);
  await ged.recordVersionDownloadAuthorized(actor(req), file);
  const delivery = await sendSecureStoredFile(res, {
    filePath: file.file_path,
    allowedRoots: [file.allowed_root],
    filename: file.original_name,
    mimeType: file.mime_type,
    download: true,
    expectedSha256: doc.sha256 ?? file.sha256,
    integrityError: {
      status: 409,
      code: "GED_INTEGRITY",
      message: "Intégrité du document non vérifiée.",
    },
  });
  if (delivery === "completed")
    await ged.recordVersionDownload(actor(req), file, "DOWNLOAD");
});

// router.post `${base}/program/confirm`
export const confirmProgram = handle(async (req, res) => {
  const s = scope(req);
  const b = z
    .object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .parse(req.body);
  res.json(
    await dossier.confirmProgram(
      req.terminal!,
      s.of_id,
      s.operation_id,
      b.fingerprint,
      req.user!.id,
      key(req),
    ),
  );
});

// router.post `${base}/start`
export const startExecution = handle(async (req, res) => {
  const s = scope(req);
  const b = z
    .object({
      activity_code: z.enum(["SETUP", "PRODUCTION", "CONTROL"]),
      planning_version: z.string().min(1),
      reason: z.string().trim().min(3).max(500).optional(),
      expected_readiness_version: z.string().optional(),
      release_execution_id: v.uuid.optional(),
    })
    .strict()
    .parse(req.body);
  const idempotencyKey = key(req);
  res.json(
    await execution.svcStartExecution({
      actor: actor(req),
      audit: audit(req),
      idempotencyKey,
      source: "TERMINAL",
      body: ev.startExecutionSchema.shape.body.parse({
        ...s,
        machine_id: req.terminal!.machine_id,
        activity_code: b.activity_code,
        comment: b.reason,
        expected_readiness_version: b.expected_readiness_version,
      }),
      transactionHooks: {
        beforeCommit: async () => {},
        beforeEffect: async (db) => {
          await assertStartAllowed({
            terminal: req.terminal!,
            station: req.station!,
            ofId: s.of_id,
            operationId: s.operation_id,
            planningVersion: b.planning_version,
            reason: b.reason,
            activity: b.activity_code,
            db,
            key: idempotencyKey,
          });
          if (!(await auth.hasProductionReceipt(db, idempotencyKey)))
            await releasePreviousIntervention(
              db,
              req.user!.id,
              null,
              b.release_execution_id,
            );
        },
      },
    }),
  );
});

// router.post '/operator/executions/:id/:action'
export const transitionExecution = handle(async (req, res) => {
  const id = v.uuid.parse(req.params.id);
  const pointage = await assertPointageScope(req.terminal!, req.station!, id);
  // Never accept alternate operator, machine, retrospective date or time type.
  const input = z
    .object({
      activity_code: z
        .enum(["SETUP", "PRODUCTION", "CONTROL", "AUTO_MACHINE", "BREAKDOWN"])
        .optional(),
      reason: z.string().trim().min(3).max(500).optional(),
      comment: z.string().max(2000).optional(),
      stops_machine: z.boolean().optional(),
      planning_version: z.string().optional(),
      release_execution_id: v.uuid.optional(),
    })
    .strict()
    .parse(req.body);
  const { planning_version, release_execution_id, ...b } = input;
  const idempotencyKey = key(req);
  const common = {
    actor: actor(req),
    audit: audit(req),
    id,
    idempotencyKey,
    transactionHooks: {
      beforeCommit: async () => {},
      beforeEffect: async (db: import("pg").PoolClient) => {
        if (["change", "resume"].includes(String(req.params.action))) {
          await assertStartAllowed({
            terminal: req.terminal!,
            station: req.station!,
            ofId: pointage.of_id,
            operationId: pointage.operation_id,
            planningVersion: planning_version ?? "",
            activity: b.activity_code ?? "PRODUCTION",
            reason: b.reason,
            db,
            key: idempotencyKey,
          });
          if (!(await auth.hasProductionReceipt(db, idempotencyKey))) {
            if (b.activity_code === "AUTO_MACHINE") {
              const current = await assertPointageScope(
                req.terminal!,
                req.station!,
                id,
                db,
              );
              if (current.activity_code !== "PRODUCTION")
                throw new HttpError(
                  409,
                  "INTERVENTION_NOT_AUTOMATIC",
                  "Seule une production peut être laissée en automatique.",
                );
            } else
              await releasePreviousIntervention(
                db,
                req.user!.id,
                id,
                release_execution_id,
              );
          }
        }
      },
    },
  };
  let result: unknown;
  switch (req.params.action) {
    case "stop":
      result = await execution.svcStopExecution({
        ...common,
        body: ev.stopExecutionSchema.shape.body.parse({ comment: b.comment }),
      });
      break;
    case "pause":
      result = await execution.svcPauseExecution({
        ...common,
        body: ev.pauseExecutionSchema.shape.body.parse(b),
      });
      break;
    case "resume":
      result = await execution.svcResumeExecution({
        ...common,
        body: ev.resumeExecutionSchema.shape.body.parse(b),
      });
      break;
    case "change":
      result = await execution.svcChangeExecution({
        ...common,
        body: ev.changeExecutionSchema.shape.body.parse(b),
      });
      break;
    case "incident":
      result = await execution.svcDeclareIncident({
        ...common,
        body: ev.incidentExecutionSchema.shape.body.parse(b),
      });
      break;
    default:
      throw new HttpError(404, "TERMINAL_ACTION_UNKNOWN", "Commande inconnue.");
  }
  res.json(result);
});

// router.post `${base}/declaration/preview`
export const previewDeclaration = handle(async (req, res) => {
  const s = scope(req);
  await dossier.operationContext(req.terminal!, s.of_id, s.operation_id);
  const body = ev.finishOperationPreviewSchema.shape.body
    .omit({ of_id: true, operation_id: true })
    .strict()
    .parse(req.body);
  res.json(
    await execution.svcPreviewFinishOperation({
      actor: actor(req),
      body: { ...body, ...s },
    }),
  );
});

// router.post `${base}/declaration/confirm`
export const confirmDeclaration = handle(async (req, res) => {
  const s = scope(req);
  await dossier.operationContext(req.terminal!, s.of_id, s.operation_id);
  const body = ev.finishOperationSchema.shape.body
    .omit({ of_id: true, operation_id: true })
    .strict()
    .parse(req.body);
  res.json(
    await execution.svcFinishOperation({
      actor: actor(req),
      audit: audit(req),
      body: { ...body, ...s },
      idempotencyKey: key(req),
    }),
  );
});

// router.post `${base}/controls/:action`
export const prepareControl = handle(async (req, res) => {
  const s = scope(req);
  const c = await dossier.operationContext(
    req.terminal!,
    s.of_id,
    s.operation_id,
  );
  const b = controlInput.parse(req.body);
  if (b.population > c.quantite_lancee)
    throw new HttpError(
      422,
      "TERMINAL_CONTROL_POPULATION",
      "La population dépasse la quantité lancée de l’OF.",
    );
  // The verified production session may record OF-scoped self-inspection only. Quality decision and release remain unavailable.
  const body = qv.executionPreviewSchema.shape.body.parse({
    source_type: "OF_OPERATION",
    source_id: s.operation_id,
    of_id: s.of_id,
    piece_technique_id: c.piece_technique_id,
    piece_version_id: c.piece_technique_version_id,
    trigger: b.trigger,
    population: b.population,
    unite: b.unite,
  });
  if (req.params.action === "preview")
    res.json(await quality.svcPreviewExecution(body, true));
  else if (req.params.action === "create")
    res
      .status(201)
      .json(
        await quality.svcCreateExecution({
          body: qv.createExecutionSchema.shape.body.parse({
            ...body,
            preview_sha256: b.preview_sha256,
            controlled_by: req.user!.id,
          }),
          actor: audit(req),
          idempotencyKey: key(req),
          ofSnapshotOnly: true,
        }),
      );
  else
    throw new HttpError(404, "TERMINAL_ACTION_UNKNOWN", "Commande inconnue.");
});

// router.post `${base}/controls/:id/measurements`
export const recordMeasurements = handle(async (req, res) => {
  const s = scope(req);
  const id = v.uuid.parse(req.params.id);
  await dossier.assertQualityScope(req.terminal!, s.of_id, s.operation_id, id); // The verified production session may record OF-scoped self-inspection only. Quality decision and release remain unavailable.
  const body = qv.recordMeasurementsSchema.shape.body.parse(req.body);
  res.json(
    await quality.svcRecordMeasurements({
      id,
      body,
      actor: audit(req),
      idempotencyKey: key(req),
    }),
  );
});
