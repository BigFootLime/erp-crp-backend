import type { Request } from "express";
import { asyncHandler } from "../../../utils/asyncHandler";
import { HttpError } from "../../../utils/httpError";
import { emitEntityChanged } from "../../../shared/realtime/realtime.service";
import type { AuditContext } from "../repository/production.repository";
import {
  createMachineOnboardingSchema,
  createMachineSchema,
  createOfSchema,
  createOfReceiptSchema,
  createPosteSchema,
  generateOfsSchema,
  listMachinesQuerySchema,
  listOfQuerySchema,
  listPostesQuerySchema,
  machineIdParamSchema,
  ofIdParamSchema,
  ofOperationIdParamSchema,
  posteIdParamSchema,
  previewOfGenerationSchema,
  reorderOfOperationsSchema,
  startOfTimeLogSchema,
  stopOfTimeLogSchema,
  updateMachineSchema,
  updateMachineOnboardingSchema,
  updateOfOperationSchema,
  updateOfSchema,
  updatePosteSchema,
} from "../validators/production.validators";
import {
  svcArchiveMachine,
  svcArchivePoste,
  svcCreateMachine,
  svcCreateMachineOnboarding,
  svcCreateOrdreFabrication,
  svcCreatePoste,
  svcGenerateOfs,
  svcGetOfTechnicalSnapshot,
  svcGetOrdreFabrication,
  svcGetOrdreFabricationTree,
  svcGetMachine,
  svcGetPoste,
  svcGetOfReceiptContext,
  svcGetOfTraceability,
  svcListOrdresFabrication,
  svcListMachines,
  svcListPostes,
  svcCreateOfReceipt,
  svcPreviewOfGeneration,
  svcReorderOfOperations,
  svcStartOfOperationTimeLog,
  svcStopOfOperationTimeLog,
  svcUpdateOrdreFabrication,
  svcUpdateOrdreFabricationOperation,
  svcUpdateMachine,
  svcUpdateMachineOnboarding,
  svcUpdatePoste,
} from "../services/production.service";
import { svcGetMachineIntelligence } from "../services/machine-intelligence.service";
import { roleHasMachineCapability } from "../domain/machine-rbac";
import { roleHasOfCapability } from "../domain/of-rbac";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBody(req: Request): unknown {
  const body = req.body as unknown;
  if (!isRecord(body)) return body;
  const data = body.data;
  if (typeof data !== "string") return body;
  try {
    return JSON.parse(data);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Invalid JSON payload in 'data'");
  }
}

function isMulterFile(value: unknown): value is Express.Multer.File {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    typeof value.originalname === "string" &&
    typeof value.mimetype === "string" &&
    typeof value.size === "number"
  );
}

export function buildAuditContext(req: Request): AuditContext {
  const user = req.user;
  if (!user) throw new HttpError(401, "UNAUTHORIZED", "Authentication required");

  const forwardedFor = req.headers["x-forwarded-for"];
  const ipFromHeader = typeof forwardedFor === "string" ? forwardedFor.split(",")[0]?.trim() : null;
  const ua = typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null;
  const pageKey = typeof req.headers["x-page-key"] === "string" ? req.headers["x-page-key"] : null;
  const clientSessionId =
    typeof req.headers["x-client-session-id"] === "string"
      ? req.headers["x-client-session-id"]
      : typeof req.headers["x-session-id"] === "string"
        ? req.headers["x-session-id"]
        : null;

  return {
    user_id: user.id,
    user_role: typeof user.role === "string" ? user.role : null,
    ip: ipFromHeader ?? req.ip ?? null,
    user_agent: ua,
    device_type: null,
    os: null,
    browser: null,
    path: req.originalUrl ?? null,
    page_key: pageKey,
    client_session_id: clientSessionId,
  };
}

function getUserRef(req: Request): { id: number; name: string } {
  const user = req.user;
  if (!user || typeof user.id !== "number") throw new HttpError(401, "UNAUTHORIZED", "Authentication required");
  const name = typeof user.username === "string" && user.username.trim() ? user.username.trim() : String(user.id);
  return { id: user.id, name };
}

function emitOfChanged(req: Request, params: { ofId: number; action: "created" | "updated" | "deleted" | "status_changed" }) {
  const entityId = String(params.ofId);
  emitEntityChanged({
    entityType: "OF",
    entityId,
    action: params.action,
    module: "production",
    at: new Date().toISOString(),
    by: getUserRef(req),
    invalidateKeys: [
      "production:ofs",
      `production:of:${entityId}`,
      `production:of:${entityId}:receipt-context`,
      `production:of:${entityId}:traceability`,
    ],
  });
}

function hasMachineCostMutation(value: object): boolean {
  return ["hourly_rate", "hourly_rate_source", "hourly_rate_effective_at"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

function assertMachineRateProvenance(value: {
  hourly_rate?: number | null;
  hourly_rate_source?: string | null;
  hourly_rate_effective_at?: string | null;
}): void {
  if (value.hourly_rate == null) return;
  if (!value.hourly_rate_source || !value.hourly_rate_effective_at) {
    throw new HttpError(422, "MACHINE_RATE_PROVENANCE_REQUIRED", "A non-null hourly rate requires its source and effective date.");
  }
}

function redactMachineCosts<T extends object>(value: T) {
  return {
    ...value,
    hourly_rate: null,
    hourly_rate_source: null,
    hourly_rate_effective_at: null,
    hourly_rate_is_override: false,
  };
}

export const listMachines = asyncHandler(async (req, res) => {
  const query = listMachinesQuerySchema.parse(req.query);
  const out = await svcListMachines(query);
  res.json(roleHasMachineCapability(req.user?.role, "costs") ? out : { ...out, items: out.items.map(redactMachineCosts) });
});

export const getMachine = asyncHandler(async (req, res) => {
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetMachine(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const intelligence = await svcGetMachineIntelligence(id);
  const detail = { ...out, ...(intelligence ?? {}) };
  res.json(roleHasMachineCapability(req.user?.role, "costs") ? detail : redactMachineCosts(detail));
});

export const createMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createMachineSchema.parse({ body: raw }).body;
  assertMachineRateProvenance(body);
  if (hasMachineCostMutation(body) && !roleHasMachineCapability(req.user?.role, "costs")) {
    throw new HttpError(403, "MACHINE_COST_FORBIDDEN", "Machine cost capability required.");
  }
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : null;
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : null;
  if (idempotencyKey && (idempotencyKey.length < 8 || idempotencyKey.length > 200)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 8 to 200 characters.");
  const out = await svcCreateMachine({ body, image_path: imagePath, idempotency_key: idempotencyKey, audit });
  res.status(201).json(roleHasMachineCapability(req.user?.role, "costs") ? out : redactMachineCosts(out));
});

export const createMachineOnboarding = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createMachineOnboardingSchema.parse({ body: raw }).body;
  assertMachineRateProvenance(body.machine);
  if (hasMachineCostMutation(body.machine) && !roleHasMachineCapability(req.user?.role, "costs")) {
    throw new HttpError(403, "MACHINE_COST_FORBIDDEN", "Machine cost capability required.");
  }
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : null;
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : null;
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "A stable Idempotency-Key containing 8 to 200 characters is required.");
  const out = await svcCreateMachineOnboarding({ body, image_path: imagePath, idempotency_key: idempotencyKey, audit });
  res.status(201).json(roleHasMachineCapability(req.user?.role, "costs") ? out : redactMachineCosts(out));
});

export const updateMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateMachineSchema.parse({ body: raw }).body;
  assertMachineRateProvenance(patch);
  if (hasMachineCostMutation(patch) && !roleHasMachineCapability(req.user?.role, "costs")) {
    throw new HttpError(403, "MACHINE_COST_FORBIDDEN", "Machine cost capability required.");
  }
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : undefined;
  const out = await svcUpdateMachine({ id, patch, image_path: imagePath, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(roleHasMachineCapability(req.user?.role, "costs") ? out : redactMachineCosts(out));
});

export const updateMachineOnboarding = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = updateMachineOnboardingSchema.parse({ body: raw }).body;
  assertMachineRateProvenance(body.machine);
  if (hasMachineCostMutation(body.machine) && !roleHasMachineCapability(req.user?.role, "costs")) {
    throw new HttpError(403, "MACHINE_COST_FORBIDDEN", "Machine cost capability required.");
  }
  if (body.update_shared_model && !roleHasMachineCapability(req.user?.role, "model_update")) {
    throw new HttpError(403, "MACHINE_MODEL_UPDATE_FORBIDDEN", "Shared machine model update capability required.");
  }
  const file = (req as Request & { file?: unknown }).file;
  const imagePath = isMulterFile(file) ? file.path : undefined;
  const out = await svcUpdateMachineOnboarding({ id, body, image_path: imagePath, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(roleHasMachineCapability(req.user?.role, "costs") ? out : redactMachineCosts(out));
});

export const archiveMachine = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = machineIdParamSchema.parse({ params: req.params }).params;
  const out = await svcArchiveMachine({ id, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

export const listPostes = asyncHandler(async (req, res) => {
  const query = listPostesQuerySchema.parse(req.query);
  const out = await svcListPostes(query);
  res.json(out);
});

export const getPoste = asyncHandler(async (req, res) => {
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetPoste(id);
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createPoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createPosteSchema.parse({ body: raw }).body;
  const out = await svcCreatePoste({ body, audit });
  res.status(201).json(out);
});

export const updatePoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updatePosteSchema.parse({ body: raw }).body;
  const out = await svcUpdatePoste({ id, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(200).json(out);
});

export const archivePoste = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = posteIdParamSchema.parse({ params: req.params }).params;
  const out = await svcArchivePoste({ id, audit });
  if (out === null) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.status(204).send();
});

// -------------------------
// OF
// -------------------------

export const listOrdresFabrication = asyncHandler(async (req, res) => {
  const query = listOfQuerySchema.parse(req.query);
  const out = await svcListOrdresFabrication(query);
  res.json(out);
});

export const getOrdreFabrication = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const userId = typeof req.user?.id === "number" ? req.user.id : undefined;
  const out = await svcGetOrdreFabrication({ id, user_id: userId });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const getOrdreFabricationTree = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetOrdreFabricationTree({ id });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

export const createOrdreFabrication = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = createOfSchema.parse({ body: raw }).body;
  const out = await svcCreateOrdreFabrication({ body, audit });
  emitOfChanged(req, { ofId: out.id, action: "created" });
  res.status(201).json(out);
});

export const updateOrdreFabrication = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateOfSchema.parse({ body: raw }).body;
  const out = await svcUpdateOrdreFabrication({ id, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitOfChanged(req, { ofId: id, action: "updated" });
  res.status(200).json(out);
});

export const updateOrdreFabricationOperation = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const patch = updateOfOperationSchema.parse({ body: raw }).body;
  const out = await svcUpdateOrdreFabricationOperation({ of_id: id, op_id: opId, patch, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitOfChanged(req, { ofId: id, action: "updated" });
  res.status(200).json(out);
});

export const startOfOperationTimeLog = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = startOfTimeLogSchema.parse({ body: raw }).body;
  const out = await svcStartOfOperationTimeLog({ of_id: id, op_id: opId, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitOfChanged(req, { ofId: id, action: "updated" });
  res.status(201).json(out);
});

// #170 — réordonnancement pré-lancement des opérations (DnD/clavier).
export const reorderOfOperations = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = reorderOfOperationsSchema.parse({ body: raw }).body;
  const out = await svcReorderOfOperations({ of_id: id, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitOfChanged(req, { ofId: id, action: "updated" });
  res.status(200).json(out);
});

// #170 — aperçu de génération sans effet de bord.
export const previewOfGeneration = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = previewOfGenerationSchema.parse({ body: raw }).body;
  const out = await withGenerationDependencyGuard(() => svcPreviewOfGeneration({ body, audit }));
  res.status(200).json(out);
});

// #170 — génération récursive confirmée (affaire ou manuel), idempotente.
export const generateOfs = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const raw = parseBody(req);
  const body = generateOfsSchema.parse({ body: raw }).body;
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : null;
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "A stable Idempotency-Key containing 8 to 200 characters is required.");
  }
  const out = await withGenerationDependencyGuard(() =>
    svcGenerateOfs({ body, idempotency_key: idempotencyKey, audit })
  );
  if (!out.idempotent_replay && out.root_of_id) {
    emitOfChanged(req, { ofId: out.root_of_id, action: "created" });
  }
  res.status(out.idempotent_replay ? 200 : 201).json(out);
});

// #170 — contenu figé du snapshot + définition courante (comparaison UI).
export const getOfTechnicalSnapshot = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetOfTechnicalSnapshot({ of_id: id });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  res.json(out);
});

// #170 §11 : une dépendance indisponible (pool PostgreSQL saturé/refusé) est un
// 503 explicite, pas un 500 générique.
async function withGenerationDependencyGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "57P01" || code === "53300") {
      throw new HttpError(503, "DEPENDENCY_UNAVAILABLE", "La base de données est momentanément indisponible. Réessayez.");
    }
    throw err;
  }
}

// -------------------------
// Phase 5 - OF -> Entree en stock
// -------------------------

export const getOfReceiptContext = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetOfReceiptContext({ of_id: id });
  const canDecideQuality = roleHasOfCapability(req.user?.role, "quality_decision");
  res.json({
    ...out,
    permissions: {
      can_receive: true,
      can_release: canDecideQuality,
      allowed_quality_statuses: canDecideQuality ? ["LIBERE", "QUARANTAINE", "BLOQUE"] : ["QUARANTAINE"],
    },
  });
});

export const createOfReceipt = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = createOfReceiptSchema.parse({ body: raw }).body;
  const idempotencyKey = typeof req.headers["idempotency-key"] === "string" ? req.headers["idempotency-key"].trim() : null;
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
    throw new HttpError(400, "IDEMPOTENCY_KEY_REQUIRED", "Une cle Idempotency-Key stable de 8 a 200 caracteres est requise.");
  }
  if (body.quality_status !== "QUARANTAINE" && !roleHasOfCapability(req.user?.role, "quality_decision")) {
    throw new HttpError(
      403,
      "OF_QUALITY_DECISION_FORBIDDEN",
      "Votre role peut receptionner en quarantaine, mais pas liberer ou bloquer le lot."
    );
  }
  const out = await svcCreateOfReceipt({ of_id: id, body, idempotency_key: idempotencyKey, audit });
  if (!out.idempotent_replay) {
    emitOfChanged(req, { ofId: id, action: "status_changed" });
  }
  res.status(out.idempotent_replay ? 200 : 201).json(out);
});

export const getOfTraceability = asyncHandler(async (req, res) => {
  const { id } = ofIdParamSchema.parse({ params: req.params }).params;
  const out = await svcGetOfTraceability({ of_id: id });
  res.json(out);
});

export const stopOfOperationTimeLog = asyncHandler(async (req, res) => {
  const audit = buildAuditContext(req);
  const { id, opId } = ofOperationIdParamSchema.parse({ params: req.params }).params;
  const raw = parseBody(req);
  const body = stopOfTimeLogSchema.parse({ body: raw }).body;
  const out = await svcStopOfOperationTimeLog({ of_id: id, op_id: opId, body, audit });
  if (!out) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  emitOfChanged(req, { ofId: id, action: "updated" });
  res.status(200).json(out);
});
