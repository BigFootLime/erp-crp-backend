import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { WipMaterialCheckpointResolver, WipOpeningInput } from "../wip-opening/wip-opening.types";
import type {
  PreparedWipMaterialOpening,
  ValidatedWipMaterialOpening,
  WipMaterialOpeningBinding,
  WipMaterialOpeningInput,
  WipMaterialOpeningInspectionInput,
  WipMaterialOpeningProjection,
} from "./wip-material-opening.types";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WIP_MATERIAL_QUANTITY_MAX = 9_999_999_999.9999;
const decimal = (value: number, code: string, message: string) => {
  const rounded = Number.isFinite(value) ? Number(value.toFixed(4)) : value;
  const precisionError = Number.isFinite(value) ? Math.abs(value - rounded) : Infinity;
  const toleratedFloatError = Number.isFinite(value) ? Math.max(1e-9, Math.abs(value) * Number.EPSILON * 4) : 0;
  if (!Number.isFinite(value) || value < 0 || value > WIP_MATERIAL_QUANTITY_MAX || precisionError > toleratedFloatError) {
    throw new HttpError(422, code, message);
  }
};
const text = (value: string | null | undefined, code: string, message: string, max = 500) => {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) throw new HttpError(422, code, message);
  return normalized;
};
const canonical = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonical)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
    : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

type ExpectedRequirement = {
  technicalPurchaseId: string;
  articleId: string;
  articleCode: string | null;
  unit: string;
  requiredQuantity: number;
  designation: string;
  phase: number | null;
  expectedOwnerClientId: string | null;
};

type CheckpointRow = {
  id: string;
  material_state: WipMaterialOpeningInput["materialState"];
  requirements_hash: string;
  source_hash: string;
  physical_batch_reference: string;
  article_id: string;
  piece_technique_id: string;
  historical_version_id: string;
};

function assertIds(input: WipMaterialOpeningInput) {
  for (const [value, label] of [
    [input.openingStateId, "l’état d’ouverture"], [input.batchId, "le lot de reprise"], [input.rowId, "la fiche"],
    [input.articleId, "l’article"], [input.pieceTechniqueId, "la pièce technique"], [input.historicalVersionId, "la version technique"],
  ] as const) if (!uuid.test(value)) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_IDENTIFIER_INVALID", `Identifiant invalide pour ${label}.`);
  if (!Number.isInteger(input.actorId) || input.actorId <= 0) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_ACTOR_INVALID", "L’auteur de la reprise matière est invalide.");
  decimal(input.quantityLaunched, "CUTOVER_WIP_MATERIAL_QUANTITY_INVALID", "La quantité de cohorte matière est invalide.");
  if (input.quantityLaunched <= 0) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_QUANTITY_REQUIRED", "La cohorte matière doit être strictement positive.");
  text(input.physicalBatchReference, "CUTOVER_WIP_MATERIAL_BATCH_REQUIRED", "La cohorte physique matière doit être identifiée.", 200);
}

function assertInspectionContext(input: WipMaterialOpeningInspectionInput) {
  for (const [value, label] of [[input.articleId, "l’article"], [input.pieceTechniqueId, "la pièce technique"], [input.historicalVersionId, "la version technique"]] as const)
    if (!uuid.test(value)) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_IDENTIFIER_INVALID", `Identifiant invalide pour ${label}.`);
  decimal(input.quantityLaunched, "CUTOVER_WIP_MATERIAL_QUANTITY_INVALID", "La quantité de cohorte matière est invalide.");
  if (input.quantityLaunched <= 0) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_QUANTITY_REQUIRED", "La cohorte matière doit être strictement positive.");
  text(input.physicalBatchReference, "CUTOVER_WIP_MATERIAL_BATCH_REQUIRED", "La cohorte physique matière doit être identifiée.", 200);
}

async function expectedRequirementsTx(tx: Pick<PoolClient, "query">, input: Pick<WipMaterialOpeningInput, "pieceTechniqueId" | "historicalVersionId" | "quantityLaunched">): Promise<ExpectedRequirement[]> {
  const version = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM public.piece_technique_versions
      WHERE id=$1::uuid AND piece_technique_id=$2::uuid AND statut IN ('APPLICABLE','OBSOLETE') FOR KEY SHARE`,
    [input.historicalVersionId, input.pieceTechniqueId],
  );
  if (!version.rows[0]) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_VERSION_CHANGED", "La version technique historique ne correspond plus à la pièce reprise.");
  const rows = await tx.query<{ id: string; article_id: string | null; article_code: string | null; purchase_unit: string | null; stock_unit: string | null; quantity: number; quantity_pieces: number | null; designation: string | null; phase: number | null; expected_owner_client_id: string | null }>(
    `SELECT purchase.id::text AS id,purchase.article_id::text AS article_id,
            article.code AS article_code,NULLIF(btrim(purchase.unite_prix),'')::text AS purchase_unit,
            NULLIF(btrim(article.unite),'')::text AS stock_unit,purchase.quantite::float8 AS quantity,
            purchase.quantite_pieces::float8 AS quantity_pieces,
            COALESCE(NULLIF(btrim(purchase.designation),''),NULLIF(btrim(purchase.nom),''),article.code,'Matière') AS designation,
            purchase.phase::int AS phase,matter.client_proprietaire_id::text AS expected_owner_client_id
       FROM public.pieces_techniques_achats purchase
       LEFT JOIN public.articles article ON article.id=purchase.article_id
       LEFT JOIN public.articles_matiere matter ON matter.article_id=article.id
      WHERE purchase.piece_technique_id=$1::uuid
        AND (purchase.piece_technique_version_id=$2::uuid OR (purchase.piece_technique_version_id IS NULL AND NOT EXISTS(
          SELECT 1 FROM public.pieces_techniques_achats scoped WHERE scoped.piece_technique_version_id=$2::uuid
        )))
        AND purchase.type_achat='MATIERE'
      ORDER BY purchase.id`,
    [input.pieceTechniqueId, input.historicalVersionId],
  );
  return rows.rows.map((row) => {
    if (!row.article_id || !row.purchase_unit?.trim() || !row.stock_unit?.trim() || row.purchase_unit.trim().toUpperCase() !== row.stock_unit.trim().toUpperCase() || !Number.isFinite(row.quantity) || row.quantity < 0) {
      throw new HttpError(409, "CUTOVER_WIP_MATERIAL_REQUIREMENT_INCOMPLETE", "La version technique contient une exigence matière incomplète. Corrigez-la avant la reprise.", { technicalPurchaseId: row.id });
    }
    if (row.quantity_pieces !== null) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_QUANTITY_CONVERSION_REQUIRED", "La quantité matière exige une conversion documentée. Ne la déduisez pas pendant la reprise.", { technicalPurchaseId: row.id });
    const required = row.quantity * input.quantityLaunched;
    const rounded = Number.isFinite(required) ? Number(required.toFixed(4)) : required;
    const precisionError = Number.isFinite(required) ? Math.abs(required - rounded) : Infinity;
    const toleratedFloatError = Number.isFinite(required) ? Math.max(1e-9, Math.abs(required) * Number.EPSILON * 4) : 0;
    if (!Number.isFinite(required) || required > WIP_MATERIAL_QUANTITY_MAX || precisionError > toleratedFloatError)
      throw new HttpError(409, "CUTOVER_WIP_MATERIAL_PRECISION_REQUIRED", "La quantité matière dépasse la précision ou la capacité de la reprise. Confirmez la conversion avant la reprise.", { technicalPurchaseId: row.id });
    return {
      technicalPurchaseId: row.id,
      articleId: row.article_id,
      articleCode: row.article_code,
      unit: row.stock_unit.trim(),
      requiredQuantity: required,
      designation: row.designation ?? "Matière",
      phase: row.phase,
      expectedOwnerClientId: row.expected_owner_client_id,
    };
  });
}

/** Safe context for the guided UI. Prices and supplier data are intentionally absent. */
export async function readWipMaterialRequirementsTx(
  tx: PoolClient,
  input: Pick<WipMaterialOpeningInput, "pieceTechniqueId" | "historicalVersionId" | "articleId" | "quantityLaunched">,
): Promise<PreparedWipMaterialOpening> {
  if (!uuid.test(input.articleId) || !uuid.test(input.pieceTechniqueId) || !uuid.test(input.historicalVersionId))
    throw new HttpError(422, "CUTOVER_WIP_MATERIAL_IDENTIFIER_INVALID", "Le contexte technique de la matière est invalide.");
  decimal(input.quantityLaunched, "CUTOVER_WIP_MATERIAL_QUANTITY_INVALID", "La quantité de cohorte matière est invalide.");
  if (input.quantityLaunched <= 0) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_QUANTITY_REQUIRED", "La cohorte matière doit être strictement positive.");
  const expectedRequirements = await expectedRequirementsTx(tx, input);
  return { requirementsHash: fingerprint(expectedRequirements), requiresMaterial: expectedRequirements.length > 0, expectedRequirements };
}

function validateInputAgainstExpected(input: Pick<WipMaterialOpeningInput, "materialState" | "requirements">, expected: ExpectedRequirement[]) {
  if (!expected.length) {
    if (input.materialState !== "NONE_CONSUMED" || input.requirements.length) {
      throw new HttpError(422, "CUTOVER_WIP_MATERIAL_NONE_REQUIRED", "Aucune exigence matière n’existe pour cette version : la portée matière doit rester vide.");
    }
    return;
  }
  if (input.requirements.length !== expected.length) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_LINES_REQUIRED", "Chaque exigence matière de la version doit être confirmée, y compris celles non encore consommées.");
  const expectedById = new Map(expected.map((item) => [item.technicalPurchaseId, item]));
  const seen = new Set<string>();
  let positive = 0;
  let all = true;
  for (const line of input.requirements) {
    if (!uuid.test(line.technicalPurchaseId) || seen.has(line.technicalPurchaseId)) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_REQUIREMENT_INVALID", "Chaque exigence matière doit être présente une seule fois.");
    seen.add(line.technicalPurchaseId);
    const reference = expectedById.get(line.technicalPurchaseId);
    if (!reference || line.articleId !== reference.articleId || line.unit.trim().toUpperCase() !== reference.unit.toUpperCase()) {
      throw new HttpError(409, "CUTOVER_WIP_MATERIAL_REQUIREMENT_CHANGED", "Une exigence matière ne correspond plus à la version technique confirmée.");
    }
    if (reference.expectedOwnerClientId && line.ownerClientId !== reference.expectedOwnerClientId) {
      throw new HttpError(409, "CUTOVER_WIP_MATERIAL_OWNER_REQUIRED", "La propriété client exigée par la matière doit être confirmée.");
    }
    decimal(line.quantityConsumed, "CUTOVER_WIP_MATERIAL_CONSUMED_INVALID", "La quantité matière déjà consommée est invalide.");
    if (line.quantityConsumed > reference.requiredQuantity + 1e-9) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_CONSUMED_EXCEEDS_REQUIREMENT", "La quantité déjà consommée dépasse le besoin de la cohorte reprise.", { technicalPurchaseId: line.technicalPurchaseId });
    text(line.evidenceReference, "CUTOVER_WIP_MATERIAL_EVIDENCE_REQUIRED", "Chaque exigence matière exige un justificatif.");
    if (line.quantityConsumed > 0) {
      positive++;
      const hasLot = !!line.physicalLotId;
      if (hasLot && !uuid.test(line.physicalLotId!)) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_LOT_INVALID", "Le lot matière sélectionné est invalide.");
      if (!hasLot) {
        text(line.historicalTraceReference, "CUTOVER_WIP_MATERIAL_TRACE_REQUIRED", "Sans lot CERP existant, renseignez la référence de traçabilité historique.");
        text(line.qualityEvidenceReference, "CUTOVER_WIP_MATERIAL_QUALITY_EVIDENCE_REQUIRED", "Sans lot CERP existant, conservez la preuve de qualité historique.");
        text(line.certificateReference, "CUTOVER_WIP_MATERIAL_CERTIFICATE_REQUIRED", "Sans lot CERP existant, conservez la référence certificat/coulée historique.");
        text(line.heatReference, "CUTOVER_WIP_MATERIAL_HEAT_REQUIRED", "Sans lot CERP existant, renseignez la coulée ou le lot historique.");
        text(line.materialCategory, "CUTOVER_WIP_MATERIAL_CATEGORY_REQUIRED", "Sans lot CERP existant, confirmez la catégorie matière historique.");
      }
      if (!line.qualityStatus?.trim()) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_QUALITY_REQUIRED", "Confirmez l’état qualité de la matière consommée.");
      if (Math.abs(line.quantityConsumed - reference.requiredQuantity) > 1e-9) all = false;
    } else all = false;
  }
  const state = positive === 0 ? "NONE_CONSUMED" : all ? "ALL_ALREADY_CONSUMED" : "PARTIAL";
  if (input.materialState !== state) throw new HttpError(422, "CUTOVER_WIP_MATERIAL_STATE_INCONSISTENT", "L’état de consommation matière ne correspond pas aux quantités confirmées.");
  // A paper trace is an immutable opening fact, not a native lot.  The normal
  // reservation policy correctly refuses to mix it with a future reservation,
  // but that refusal used to happen only after the resumed OF existed.  Stop
  // the preparation earlier whenever a partial opening would necessarily need
  // a later reservation; a fully consumed requirement remains auditable.
  if (state === "PARTIAL" && input.requirements.some((line) => line.quantityConsumed > 0 && !line.physicalLotId)) {
    throw new HttpError(409, "CUTOVER_WIP_MATERIAL_PARTIAL_TRACE_BLOCKED", "Une matière partiellement consommée sans lot CERP bloquerait les réservations restantes. Rapprochez un lot CERP traçable ou conservez cet encours hors reprise jusqu’à justification complète.");
  }
}

async function assertOpeningOwnershipTx(tx: Pick<PoolClient, "query">, input: WipMaterialOpeningInput) {
  const opening = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM public.data_cutover_opening_states
      WHERE id=$1::uuid AND batch_id=$2::uuid AND row_id=$3::uuid AND opening_kind='WIP' AND domain='WIP'
      FOR KEY SHARE`,
    [input.openingStateId, input.batchId, input.rowId],
  );
  if (!opening.rows[0]) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_OPENING_CHANGED", "L’état d’ouverture matière ne correspond plus au lot d’encours sélectionné.");
}

async function assertPhysicalLotsTx(tx: Pick<PoolClient, "query">, input: Pick<WipMaterialOpeningInput, "requirements">) {
  for (const line of input.requirements.filter((item) => item.quantityConsumed > 0 && item.physicalLotId)) {
    const result = await tx.query<{ id: string; article_id: string; owner_client_id: string | null; quality: string | null }>(
      `SELECT lot.id::text AS id,lot.article_id::text AS article_id,lot.client_proprietaire_id::text AS owner_client_id,lot.lot_status::text AS quality
         FROM public.lots lot WHERE lot.id=$1::uuid FOR KEY SHARE`, [line.physicalLotId],
    );
    const lot = result.rows[0];
    if (!lot || lot.article_id !== line.articleId) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_LOT_MISMATCH", "Le lot physique ne correspond pas à l’exigence matière.");
    if (line.ownerClientId !== undefined && line.ownerClientId !== lot.owner_client_id) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_OWNER_MISMATCH", "La propriété du lot ne correspond pas à la preuve de reprise.");
    if (line.qualityStatus && lot.quality && line.qualityStatus.trim().toUpperCase() !== lot.quality.trim().toUpperCase()) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_QUALITY_MISMATCH", "L’état qualité du lot ne correspond pas à la preuve de reprise.");
  }
}

export async function inspectWipMaterialDeclarationTx(tx: PoolClient, input: WipMaterialOpeningInspectionInput): Promise<PreparedWipMaterialOpening> {
  assertInspectionContext(input);
  const expectedRequirements = await expectedRequirementsTx(tx, input);
  validateInputAgainstExpected(input, expectedRequirements);
  await assertPhysicalLotsTx(tx, input);
  return { requirementsHash: fingerprint(expectedRequirements), requiresMaterial: expectedRequirements.length > 0, expectedRequirements };
}

export async function prepareWipMaterialOpeningTx(tx: PoolClient, input: WipMaterialOpeningInput): Promise<PreparedWipMaterialOpening> {
  assertIds(input);
  await assertOpeningOwnershipTx(tx, input);
  return inspectWipMaterialDeclarationTx(tx, input);
}

export async function validateWipMaterialOpeningTx(tx: PoolClient, input: WipMaterialOpeningInput): Promise<ValidatedWipMaterialOpening> {
  const prepared = await prepareWipMaterialOpeningTx(tx, input);
  if (!prepared.requiresMaterial) return { ...prepared, checkpointId: null, materialState: "NONE_CONSUMED" };
  const sourceHash = fingerprint({ input: { ...input, actorId: undefined }, requirementsHash: prepared.requirementsHash });
  const existing = await tx.query<CheckpointRow>(
    `SELECT id::text,material_state,requirements_hash,source_hash,physical_batch_reference,article_id::text,piece_technique_id::text,historical_version_id::text
       FROM public.data_cutover_wip_material_checkpoints WHERE opening_state_id=$1::uuid FOR UPDATE`, [input.openingStateId],
  );
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.source_hash !== sourceHash || row.requirements_hash !== prepared.requirementsHash) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_CHECKPOINT_IMMUTABLE", "Le checkpoint matière a déjà été validé avec un autre contenu.");
    return { ...prepared, checkpointId: row.id, materialState: row.material_state };
  }
  const checkpointId = randomUUID();
  await tx.query(
    `INSERT INTO public.data_cutover_wip_material_checkpoints(id,batch_id,row_id,opening_state_id,article_id,piece_technique_id,historical_version_id,quantity_launched,physical_batch_reference,material_state,requirements_hash,source_hash,created_by)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,$7::uuid,$8,$9,$10,$11,$12,$13)`,
    [checkpointId, input.batchId, input.rowId, input.openingStateId, input.articleId, input.pieceTechniqueId, input.historicalVersionId, input.quantityLaunched, input.physicalBatchReference, input.materialState, prepared.requirementsHash, sourceHash, input.actorId],
  );
  for (const line of input.requirements) await tx.query(
      `INSERT INTO public.data_cutover_wip_material_checkpoint_lines(checkpoint_id,technical_purchase_id,article_id,unit,quantity_consumed,physical_lot_id,historical_trace_reference,owner_client_id,quality_status,quality_evidence_reference,certificate_reference,heat_reference,material_category,evidence_reference,created_by)
     VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [checkpointId, line.technicalPurchaseId, line.articleId, line.unit.trim(), line.quantityConsumed, line.physicalLotId ?? null, line.historicalTraceReference?.trim() ?? null, line.ownerClientId ?? null, line.qualityStatus?.trim() ?? null, line.qualityEvidenceReference?.trim() ?? null, line.certificateReference?.trim() ?? null, line.heatReference?.trim() ?? null, line.materialCategory?.trim() ?? null, line.evidenceReference.trim(), input.actorId],
  );
  return { ...prepared, checkpointId, materialState: input.materialState };
}

export const resolveWipMaterialCheckpointTx: WipMaterialCheckpointResolver = async (tx, input) => {
  const expected = await expectedRequirementsTx(tx, input);
  if (!expected.length) return { requiresMaterial: false, checkpointId: null, physicalBatchReference: null };
  const checkpoint = await tx.query<CheckpointRow>(
    `SELECT id::text,material_state,requirements_hash,source_hash,physical_batch_reference,article_id::text,piece_technique_id::text,historical_version_id::text
       FROM public.data_cutover_wip_material_checkpoints
      WHERE id=$1::uuid AND opening_state_id=$2::uuid AND batch_id=$3::uuid AND row_id=$4::uuid
      FOR KEY SHARE`,
    [input.materialCheckpointId ?? null, input.openingStateId, input.batchId, input.rowId],
  );
  const row = checkpoint.rows[0];
  if (!row || row.article_id !== input.articleId || row.piece_technique_id !== input.pieceTechniqueId || row.historical_version_id !== input.historicalVersionId || row.physical_batch_reference !== input.physicalBatchReference || row.requirements_hash !== fingerprint(expected)) {
    throw new HttpError(409, "CUTOVER_WIP_MATERIAL_CHECKPOINT_CHANGED", "Le checkpoint matière validé ne correspond plus à l’encours repris.");
  }
  return { requiresMaterial: true, checkpointId: row.id, physicalBatchReference: row.physical_batch_reference };
};

export async function bindWipMaterialOpeningTx(tx: PoolClient, input: WipOpeningInput, ofId: number): Promise<WipMaterialOpeningBinding> {
  if (input.materialScope === "NONE") return { checkpointId: "", ofId, boundNeedIds: [] };
  if (!input.materialCheckpointId || !uuid.test(input.materialCheckpointId)) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_CHECKPOINT_REQUIRED", "Le checkpoint matière validé est requis avant le rattachement à l’OF.");
  const checkpoint = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM public.data_cutover_wip_material_checkpoints
      WHERE id=$1::uuid AND opening_state_id=$2::uuid AND batch_id=$3::uuid AND row_id=$4::uuid
      FOR KEY SHARE`, [input.materialCheckpointId, input.openingStateId, input.batchId, input.rowId],
  );
  if (!checkpoint.rows[0]) throw new HttpError(409, "CUTOVER_WIP_MATERIAL_CHECKPOINT_CHANGED", "Le checkpoint matière n’est plus disponible.");
  const lines = await tx.query<{ technical_purchase_id: string; quantity_consumed: number }>(
    `SELECT technical_purchase_id::text,quantity_consumed::float8 FROM public.data_cutover_wip_material_checkpoint_lines WHERE checkpoint_id=$1::uuid ORDER BY technical_purchase_id FOR KEY SHARE`, [input.materialCheckpointId],
  );
  // The resumed OF is deliberately still BROUILLON. Native material needs are
  // configured only afterwards; binding to their technical source preserves
  // that workflow instead of inventing debit rules, reservations or quality.
  const of = await tx.query<{ id: string; version_id: string }>(
    `SELECT id::text,piece_technique_version_id::text AS version_id FROM public.ordres_fabrication
      WHERE id=$1::bigint FOR KEY SHARE`, [ofId],
  );
  if (!of.rows[0] || of.rows[0].version_id !== input.historicalVersionId)
    throw new HttpError(409, "CUTOVER_WIP_MATERIAL_OF_CHANGED", "L’OF créé ne correspond plus à la version technique de l’encours.");
  const priorBinding = await tx.query<{ of_id: string }>(
    `SELECT of_id::text FROM public.data_cutover_wip_material_opening_bindings
      WHERE checkpoint_id=$1::uuid FOR KEY SHARE`, [input.materialCheckpointId],
  );
  if (priorBinding.rows.some((row) => Number(row.of_id) !== ofId))
    throw new HttpError(409, "CUTOVER_WIP_MATERIAL_ALREADY_BOUND", "Ce checkpoint matière est déjà rattaché à un autre OF.");
  const boundNeedIds: string[] = [];
  for (const line of lines.rows) {
    await tx.query(
      `INSERT INTO public.data_cutover_wip_material_opening_bindings(checkpoint_id,of_id,technical_purchase_id,quantity_consumed)
       VALUES($1::uuid,$2::bigint,$3::uuid,$4)
       ON CONFLICT(checkpoint_id,technical_purchase_id) DO NOTHING`,
      [input.materialCheckpointId, ofId, line.technical_purchase_id, line.quantity_consumed],
    );
    boundNeedIds.push(line.technical_purchase_id);
  }
  return { checkpointId: input.materialCheckpointId, ofId, boundNeedIds };
}

/** Read-only opening facts used by the normal material projection. */
export async function readWipMaterialOpeningProjectionTx(tx: Pick<PoolClient, "query">, ofId: number): Promise<WipMaterialOpeningProjection[]> {
  const installed = await tx.query<{ installed: boolean }>("SELECT to_regclass('public.data_cutover_wip_material_opening_bindings') IS NOT NULL AS installed");
  if (!installed.rows[0]?.installed) return [];
  const result = await tx.query<{ need_id: string | null; source_ref: string; consumed: number; checkpoint_id: string }>(
    `SELECT need.id::text AS need_id,binding.technical_purchase_id::text AS source_ref,
            binding.quantity_consumed::float8 AS consumed,binding.checkpoint_id::text
       FROM public.data_cutover_wip_material_opening_bindings binding
       LEFT JOIN public.of_material_needs need ON need.of_id=binding.of_id
         AND need.source_ref=binding.technical_purchase_id::text
         AND need.need_kind='MATIERE' AND need.superseded_at IS NULL
      WHERE binding.of_id=$1::bigint
      ORDER BY binding.technical_purchase_id,binding.checkpoint_id`, [ofId],
  );
  return result.rows.map((row) => ({ needId: row.need_id, sourceRef: row.source_ref, consumed: row.consumed, origin: "CUTOVER_OPENING", checkpointId: row.checkpoint_id }));
}
