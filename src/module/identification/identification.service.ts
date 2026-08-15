import crypto from "node:crypto";
import bwipjs from "bwip-js";

import { resolveAccessProfile } from "../access-control/services/access-control.service";
import { HttpError } from "../../utils/httpError";
import {
  buildHumanCode,
  buildIdentificationPayload,
  entityModule,
  FLOW_ENTITY_TYPES,
  forbiddenStatusReason,
  IDENTIFICATION_CONTRACT_VERSION,
  IDENTIFICATION_ENTITY_TYPES,
  IDENTIFICATION_HARDWARE_POLICY,
  parseIdentificationPayload,
  roleCanManageEntity,
  roleCanReadEntity,
  scanReplayIdentityMatches,
  targetRoute,
  validateClientScanTimestamp,
  type IdentificationEntityType,
  type IdentificationSymbology,
} from "./domain/identification";
import type {
  IssueIdentificationLabelDTO,
  PrintIdentificationLabelDTO,
  ResolveIdentificationDTO,
} from "./identification.validators";
import {
  identificationPayloadHash,
  repoAcquireReceipt,
  repoFindActiveLabel,
  repoFindEntity,
  repoFindLabelById,
  repoFindLabelByPublicId,
  repoFindScanEvent,
  repoInsertAudit,
  repoInsertLabel,
  repoInsertPrintEvent,
  repoInsertScanEvent,
  repoInvalidateLabel,
  repoListLabels,
  repoPrintCount,
  repoSaveReceipt,
  withIdentificationTransaction,
  type IdentificationActor,
  type IdentificationLabelRow,
  type StoredScanEvent,
} from "./identification.repository";

type ScanResult = {
  ok: boolean;
  event_id: string;
  result_code: string;
  message: string;
  idempotent_replay: boolean;
  requires_online_confirmation: boolean;
  target_route?: string;
  label?: ReturnType<typeof presentLabel>;
  entity?: { type: IdentificationEntityType; id: string; code: string; label: string; status: string | null };
};

function presentLabel(label: IdentificationLabelRow) {
  return {
    ...label,
    payload: buildIdentificationPayload(label.public_id),
    source: "identification_labels",
    reliability: "VERIFIED" as const,
    freshness_at: label.invalidated_at ?? label.issued_at,
  };
}

function assertActor(actor: IdentificationActor): void {
  if (!Number.isSafeInteger(actor.user_id) || actor.user_id <= 0) throw new HttpError(401, "UNAUTHORIZED", "Authentification requise.");
}

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new HttpError(422, "IDEMPOTENCY_KEY_REQUIRED", "Un en-tête Idempotency-Key UUID est requis.");
  }
  return key.toLowerCase();
}

async function accountModuleDecision(userId: number, moduleKey: string): Promise<{ allowed: boolean; superadmin: boolean }> {
  const profile = await resolveAccessProfile(userId);
  if (profile === null) return { allowed: true, superadmin: false };
  if (profile.is_superadmin) return { allowed: true, superadmin: true };
  return { allowed: profile.modules.some((entry) => entry.module_key === moduleKey && entry.allowed), superadmin: false };
}

async function canRead(actor: IdentificationActor, entityType: IdentificationEntityType): Promise<boolean> {
  const moduleDecision = await accountModuleDecision(actor.user_id, entityModule(entityType));
  return moduleDecision.superadmin || (roleCanReadEntity(actor.role, entityType) && moduleDecision.allowed);
}

async function canManage(actor: IdentificationActor, entityType: IdentificationEntityType): Promise<boolean> {
  const moduleDecision = await accountModuleDecision(actor.user_id, entityModule(entityType));
  return moduleDecision.superadmin || (roleCanManageEntity(actor.role, entityType) && moduleDecision.allowed);
}

async function assertCanRead(actor: IdentificationActor, entityType: IdentificationEntityType): Promise<void> {
  if (!(await canRead(actor, entityType))) throw new HttpError(403, "IDENTIFICATION_PERMISSION_REQUIRED", "Vous n'avez pas accès à ce type d'entité.");
}

async function assertCanManage(actor: IdentificationActor, entityType: IdentificationEntityType): Promise<void> {
  if (!(await canManage(actor, entityType))) throw new HttpError(403, "IDENTIFICATION_MANAGE_PERMISSION_REQUIRED", "Vous ne pouvez pas créer ou gérer cette étiquette.");
}

function barcodeSvg(symbology: IdentificationSymbology, payload: string, profile: string): string {
  const small = profile === "SMALL_30X15";
  const bcid = symbology === "QR_CODE" ? "qrcode" : symbology === "CODE_128" ? "code128" : "datamatrix";
  return bwipjs.toSVG({
    bcid,
    text: payload,
    scale: small ? 2 : 3,
    height: symbology === "CODE_128" ? (small ? 8 : 12) : undefined,
    includetext: false,
    paddingwidth: 2,
    paddingheight: 2,
  });
}

function printResponse(label: IdentificationLabelRow, body: PrintIdentificationLabelDTO, eventType: "PRINT" | "REPRINT", idempotentReplay: boolean) {
  const payload = buildIdentificationPayload(label.public_id);
  return {
    label: presentLabel(label),
    print: {
      event_type: eventType,
      symbology: body.symbology,
      label_profile: body.label_profile,
      media: body.label_profile === "STANDARD_50X30" ? "50 x 30 mm" : body.label_profile === "SMALL_30X15" ? "30 x 15 mm" : "A4",
      svg: barcodeSvg(body.symbology, payload, body.label_profile),
      content_type: "image/svg+xml",
      hardware_policy: IDENTIFICATION_HARDWARE_POLICY[body.symbology],
      generated_at: new Date().toISOString(),
    },
    idempotent_replay: idempotentReplay,
  };
}

export async function identificationCapabilities(actor: IdentificationActor) {
  assertActor(actor);
  const entities = await Promise.all(IDENTIFICATION_ENTITY_TYPES.map(async (entityType) => ({
    entity_type: entityType,
    module_key: entityModule(entityType),
    can_scan: await canRead(actor, entityType),
    can_manage_labels: await canManage(actor, entityType),
  })));
  return {
    contract_version: IDENTIFICATION_CONTRACT_VERSION,
    payload_format: "CERP:1:<public UUID>",
    entities,
    flows: FLOW_ENTITY_TYPES,
    symbologies: IDENTIFICATION_HARDWARE_POLICY,
    offline: { max_age_hours: 168, future_clock_skew_minutes: 5, writes_business_data: false, confirmation_required: true },
  };
}

export async function issueLabel(params: { body: IssueIdentificationLabelDTO; actor: IdentificationActor; idempotencyKey?: string }) {
  assertActor(params.actor);
  await assertCanManage(params.actor, params.body.entity_type);
  const key = requireIdempotencyKey(params.idempotencyKey);
  const result = await withIdentificationTransaction(async (client) => {
    const receipt = await repoAcquireReceipt(client, { actor: params.actor, key, command_type: "LABEL_ISSUE", payload: params.body });
    if (receipt.replay) return { ...(receipt.replay as { label: ReturnType<typeof presentLabel> }), idempotent_replay: true };
    const entity = await repoFindEntity(params.body.entity_type, params.body.entity_id, client);
    const forbidden = forbiddenStatusReason(entity.entity_type, entity.status, "TRACEABILITY");
    if (forbidden) throw new HttpError(409, "IDENTIFICATION_ENTITY_STATUS_FORBIDDEN", `${forbidden} : aucune nouvelle étiquette ne peut être émise.`);
    if (await repoFindActiveLabel(entity.entity_type, entity.entity_id, client)) {
      throw new HttpError(409, "IDENTIFICATION_LABEL_ALREADY_ACTIVE", "Une étiquette active existe déjà. Réimprimez-la ou remplacez-la.");
    }
    const label = await repoInsertLabel(client, {
      public_id: crypto.randomUUID(), entity, human_code: buildHumanCode(entity.entity_type, entity.canonical_code),
      actor: params.actor,
    });
    const response = { label: presentLabel(label), idempotent_replay: false };
    await repoInsertAudit(client, { actor: params.actor, action: "IDENTIFICATION_LABEL_ISSUED", entity_type: entity.entity_type, entity_id: entity.entity_id, label_id: label.id, details: { public_id: label.public_id, contract_version: 1, site_code: label.site_code } });
    await repoSaveReceipt(client, { actor: params.actor, key, command_type: "LABEL_ISSUE", hash: receipt.hash, aggregate_id: label.id, result: response });
    return response;
  });
  return result;
}

export async function listLabels(params: { filters: { entity_type?: IdentificationEntityType; entity_id?: string; status?: string; limit: number }; actor: IdentificationActor }) {
  assertActor(params.actor);
  if (params.filters.entity_type) await assertCanRead(params.actor, params.filters.entity_type);
  const rows = await repoListLabels(params.filters);
  const allowed: IdentificationLabelRow[] = [];
  for (const row of rows) if (await canRead(params.actor, row.entity_type)) allowed.push(row);
  return { items: allowed.map(presentLabel) };
}

export async function printLabel(params: { labelId: string; body: PrintIdentificationLabelDTO; actor: IdentificationActor; idempotencyKey?: string }) {
  assertActor(params.actor);
  const initial = await repoFindLabelById(params.labelId);
  if (!initial) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
  await assertCanManage(params.actor, initial.entity_type);
  const key = requireIdempotencyKey(params.idempotencyKey);
  const stored = await withIdentificationTransaction(async (client) => {
    const receipt = await repoAcquireReceipt(client, { actor: params.actor, key, command_type: "LABEL_PRINT", payload: { label_id: params.labelId, ...params.body } });
    if (receipt.replay) return { ...(receipt.replay as { label_id: string; event_type: "PRINT" | "REPRINT"; body: PrintIdentificationLabelDTO }), idempotent_replay: true };
    const label = await repoFindLabelById(params.labelId, client, true);
    if (!label) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
    if (label.status !== "ACTIVE") throw new HttpError(410, "IDENTIFICATION_LABEL_INVALIDATED", "Cette étiquette n'est plus active.");
    const eventType: "PRINT" | "REPRINT" = (await repoPrintCount(label.id, client)) === 0 ? "PRINT" : "REPRINT";
    if (eventType === "REPRINT" && !params.body.reason) throw new HttpError(422, "IDENTIFICATION_REPRINT_REASON_REQUIRED", "Le motif de réimpression est obligatoire.");
    await repoInsertPrintEvent(client, { label_id: label.id, event_type: eventType, symbology: params.body.symbology, label_profile: params.body.label_profile, reason: params.body.reason, actor: params.actor });
    await repoInsertAudit(client, { actor: params.actor, action: eventType === "PRINT" ? "IDENTIFICATION_LABEL_PRINTED" : "IDENTIFICATION_LABEL_REPRINTED", entity_type: label.entity_type, entity_id: label.entity_id, label_id: label.id, details: { symbology: params.body.symbology, label_profile: params.body.label_profile, reason: params.body.reason ?? null } });
    const receiptResult = { label_id: label.id, event_type: eventType, body: params.body };
    await repoSaveReceipt(client, { actor: params.actor, key, command_type: "LABEL_PRINT", hash: receipt.hash, aggregate_id: label.id, result: receiptResult });
    return { ...receiptResult, idempotent_replay: false };
  });
  const label = await repoFindLabelById(stored.label_id);
  if (!label) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
  return printResponse(label, stored.body, stored.event_type, stored.idempotent_replay);
}

export async function invalidateLabel(params: { labelId: string; reason: string; actor: IdentificationActor; idempotencyKey?: string }) {
  assertActor(params.actor);
  const initial = await repoFindLabelById(params.labelId);
  if (!initial) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
  await assertCanManage(params.actor, initial.entity_type);
  const key = requireIdempotencyKey(params.idempotencyKey);
  return withIdentificationTransaction(async (client) => {
    const receipt = await repoAcquireReceipt(client, { actor: params.actor, key, command_type: "LABEL_INVALIDATE", payload: { label_id: params.labelId, reason: params.reason } });
    if (receipt.replay) return { ...(receipt.replay as { label: ReturnType<typeof presentLabel> }), idempotent_replay: true };
    const label = await repoFindLabelById(params.labelId, client, true);
    if (!label) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
    if (label.status !== "ACTIVE") throw new HttpError(409, "IDENTIFICATION_LABEL_NOT_ACTIVE", "L'étiquette a déjà été invalidée ou remplacée.");
    const updated = await repoInvalidateLabel(client, { label, actor: params.actor, reason: params.reason });
    const response = { label: presentLabel(updated), idempotent_replay: false };
    await repoInsertAudit(client, { actor: params.actor, action: "IDENTIFICATION_LABEL_INVALIDATED", entity_type: label.entity_type, entity_id: label.entity_id, label_id: label.id, details: { reason: params.reason } });
    await repoSaveReceipt(client, { actor: params.actor, key, command_type: "LABEL_INVALIDATE", hash: receipt.hash, aggregate_id: label.id, result: response });
    return response;
  });
}

export async function replaceLabel(params: { labelId: string; reason: string; actor: IdentificationActor; idempotencyKey?: string }) {
  assertActor(params.actor);
  const initial = await repoFindLabelById(params.labelId);
  if (!initial) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
  await assertCanManage(params.actor, initial.entity_type);
  const key = requireIdempotencyKey(params.idempotencyKey);
  return withIdentificationTransaction(async (client) => {
    const receipt = await repoAcquireReceipt(client, { actor: params.actor, key, command_type: "LABEL_REPLACE", payload: { label_id: params.labelId, reason: params.reason } });
    if (receipt.replay) return { ...(receipt.replay as { previous_label: ReturnType<typeof presentLabel>; label: ReturnType<typeof presentLabel> }), idempotent_replay: true };
    const oldLabel = await repoFindLabelById(params.labelId, client, true);
    if (!oldLabel) throw new HttpError(404, "IDENTIFICATION_LABEL_NOT_FOUND", "Étiquette introuvable.");
    if (oldLabel.status !== "ACTIVE") throw new HttpError(409, "IDENTIFICATION_LABEL_NOT_ACTIVE", "Seule une étiquette active peut être remplacée.");
    const entity = await repoFindEntity(oldLabel.entity_type, oldLabel.entity_id, client);
    await repoInvalidateLabel(client, { label: oldLabel, actor: params.actor, reason: params.reason });
    const newLabel = await repoInsertLabel(client, { public_id: crypto.randomUUID(), entity, human_code: oldLabel.human_code, site_code: oldLabel.site_code ?? undefined, actor: params.actor });
    const previous = await repoInvalidateLabel(client, { label: oldLabel, actor: params.actor, reason: params.reason, replacementId: newLabel.id });
    const response = { previous_label: presentLabel(previous), label: presentLabel(newLabel), idempotent_replay: false };
    await repoInsertAudit(client, { actor: params.actor, action: "IDENTIFICATION_LABEL_REPLACED", entity_type: oldLabel.entity_type, entity_id: oldLabel.entity_id, label_id: oldLabel.id, details: { reason: params.reason, replacement_label_id: newLabel.id, replacement_public_id: newLabel.public_id } });
    await repoSaveReceipt(client, { actor: params.actor, key, command_type: "LABEL_REPLACE", hash: receipt.hash, aggregate_id: newLabel.id, result: response });
    return response;
  });
}

function storedToResult(stored: StoredScanEvent, replay: boolean): ScanResult {
  const response = (stored.details.response ?? {}) as Partial<ScanResult>;
  return {
    ok: stored.result_code === "RESOLVED",
    event_id: stored.event_id,
    result_code: stored.result_code,
    message: typeof response.message === "string" ? response.message : stored.result_code,
    requires_online_confirmation: true,
    ...response,
    idempotent_replay: replay,
  };
}

function assertScanReplayMatches(stored: StoredScanEvent, input: ResolveIdentificationDTO, actor: IdentificationActor, hash: string): void {
  if (!scanReplayIdentityMatches(stored, {
    actor_user_id: actor.user_id,
    payload_sha256: hash,
    flow: input.flow,
    source: input.source,
    client_scanned_at: input.client_scanned_at,
    expected_entity_types: input.expected_entity_types,
    device_id: input.device_id,
  })) {
    throw new HttpError(409, "IDENTIFICATION_EVENT_ID_REUSED", "Cet event_id a déjà été utilisé avec une autre lecture.");
  }
}

async function recordScan(input: ResolveIdentificationDTO, actor: IdentificationActor, result: Omit<ScanResult, "event_id" | "idempotent_replay"> & { label_id?: string; entity_type?: IdentificationEntityType; entity_id?: string }): Promise<ScanResult> {
  const payloadHash = identificationPayloadHash(input.code.trim());
  const { label_id, entity_type, entity_id, ...publicResult } = result;
  const response: ScanResult = { event_id: input.event_id, idempotent_replay: false, ...publicResult };
  const stored = await repoInsertScanEvent({
    event_id: input.event_id, payload_sha256: payloadHash, source: input.source, flow: input.flow,
    expected_entity_types: input.expected_entity_types, result_code: result.result_code,
    label_id, entity_type, entity_id,
    actor, client_scanned_at: input.client_scanned_at, device_id: input.device_id,
    details: { response },
  });
  assertScanReplayMatches(stored.event, input, actor, payloadHash);
  if (!stored.inserted) return storedToResult(stored.event, true);
  return response;
}

export async function resolveIdentification(input: ResolveIdentificationDTO, actor: IdentificationActor): Promise<ScanResult> {
  assertActor(actor);
  const hash = identificationPayloadHash(input.code.trim());
  const prior = await repoFindScanEvent(input.event_id);
  if (prior) { assertScanReplayMatches(prior, input, actor, hash); return storedToResult(prior, true); }

  const timestampResult = validateClientScanTimestamp(new Date(input.client_scanned_at));
  if (timestampResult !== "OK") return recordScan(input, actor, { ok: false, result_code: timestampResult, message: timestampResult === "FUTURE_TIMESTAMP" ? "L'horloge du terminal est en avance de plus de cinq minutes." : "La lecture hors ligne date de plus de sept jours.", requires_online_confirmation: true });

  let publicId: string;
  try { publicId = parseIdentificationPayload(input.code); }
  catch {
    return recordScan(input, actor, { ok: false, result_code: "INVALID_PAYLOAD", message: "Code non reconnu. Aucun identifiant métier n'a été interprété.", requires_online_confirmation: true });
  }
  const label = await repoFindLabelByPublicId(publicId);
  if (!label) return recordScan(input, actor, { ok: false, result_code: "UNKNOWN", message: "Identifiant inconnu. Isolez l'objet et demandez une vérification.", requires_online_confirmation: true });
  if (label.status !== "ACTIVE") return recordScan(input, actor, { ok: false, result_code: "INVALIDATED", message: "Étiquette invalidée ou remplacée. Utilisez l'étiquette active.", requires_online_confirmation: true, label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id });
  if (!FLOW_ENTITY_TYPES[input.flow].includes(label.entity_type) || (input.expected_entity_types.length > 0 && !input.expected_entity_types.includes(label.entity_type))) {
    return recordScan(input, actor, { ok: false, result_code: "WRONG_ENTITY_TYPE", message: `Le flux ${input.flow} n'accepte pas ce type d'entité.`, requires_online_confirmation: true, label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id });
  }
  if (!(await canRead(actor, label.entity_type))) {
    return recordScan(input, actor, { ok: false, result_code: "INSUFFICIENT_PERMISSION", message: "Accès insuffisant pour cette entité.", requires_online_confirmation: true, label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id });
  }
  let entity;
  try { entity = await repoFindEntity(label.entity_type, label.entity_id); }
  catch (error) {
    if (error instanceof HttpError && error.status === 404) return recordScan(input, actor, { ok: false, result_code: "ENTITY_NOT_FOUND", message: "L'étiquette est connue mais l'entité métier n'existe plus. N'utilisez pas cet objet.", requires_online_confirmation: true, label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id });
    throw error;
  }
  const forbidden = forbiddenStatusReason(label.entity_type, entity.status, input.flow);
  if (forbidden) return recordScan(input, actor, { ok: false, result_code: "FORBIDDEN_STATUS", message: `${forbidden} : l'action demandée est interdite.`, requires_online_confirmation: true, label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id });
  return recordScan(input, actor, {
    ok: true, result_code: "RESOLVED", message: "Identifiant vérifié. Confirmez l'action dans le module métier.",
    requires_online_confirmation: true, target_route: targetRoute(label.entity_type, label.entity_id),
    label: presentLabel(label), entity: { type: entity.entity_type, id: entity.entity_id, code: entity.canonical_code, label: entity.label, status: entity.status },
    label_id: label.id, entity_type: label.entity_type, entity_id: label.entity_id,
  });
}

export async function syncOfflineIdentification(events: ResolveIdentificationDTO[], actor: IdentificationActor) {
  const results: ScanResult[] = [];
  for (const event of events) results.push(await resolveIdentification(event, actor));
  return {
    contract_version: 1,
    writes_business_data: false,
    confirmation_required: true,
    processed: results.length,
    resolved: results.filter((item) => item.ok).length,
    rejected: results.filter((item) => !item.ok).length,
    results,
  };
}
