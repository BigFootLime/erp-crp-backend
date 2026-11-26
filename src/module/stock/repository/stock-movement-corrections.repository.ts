import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { assertStockEntrySource } from "../domain/manual-entry-policy";
import { calculateStockAvailability, type StockLotQualityStatus } from "../domain/stock-availability";
import { hashStockCommand, normalizeIdempotencyKey } from "../domain/stock-command";
import type { StockMovementCompensationPreview, StockMovementDetail, StockMovementImpactPreview } from "../types/stock.types";
import type { CompensateMovementBodyDTO, CreateMovementBodyDTO, CreateMovementLineDTO } from "../validators/stock.validators";
import { assemblyComponentWithdrawalOwnsMovement } from "./assembly-component-movement-guard";
import { consumableWithdrawalOwnsMovement } from "./consumable-movement-guard";
import { previewMaterialBarCompensationTx } from "./material-bar-compensation.repository";
import { assertMaterialBarPostingInputs, readMaterialBarPostingScope, readMaterialBarTracking } from "./material-bar-posting.repository";
import {
  assertConsistentLocations,
  assertSameArticle,
  assertSameLotIfSet,
  assertStockConsumptionAllowed,
  beginStockCommand,
  completeStockCommand,
  ensureArticleStockManaged,
  ensureLotTrackingRespected,
  getEmplacementMapping,
  insertAuditLog,
  insertMovementEvent,
  repoCreateMovement,
  repoGetMovement,
  sumQty,
  type AuditContext,
  type LockedStockState,
} from "./stock-movement-core.repository";

export async function repoPreviewMovement(
  body: CreateMovementBodyDTO
): Promise<StockMovementImpactPreview> {
  assertStockEntrySource({ movementType: body.movement_type });
  assertSameArticle(body.lines);
  assertConsistentLocations(body.lines, body.movement_type);
  if (body.movement_type === "RESERVE" || body.movement_type === "UNRESERVE") {
    throw new HttpError(
      422,
      "USE_RESERVATION_API",
      "Reservations are non-physical allocations and must use the stock reservation API"
    );
  }

  const articleId = body.lines[0]?.article_id;
  const first = body.lines[0];
  if (!articleId || !first) throw new HttpError(400, "INVALID_MOVEMENT", "Missing movement lines");
  await ensureArticleStockManaged(db, articleId);
  await ensureLotTrackingRespected(db, articleId, body.lines);
  const lotId = assertSameLotIfSet(body.lines);
  const totalQty = sumQty(body.lines);
  if (!Number.isFinite(totalQty) || totalQty <= 0) {
    throw new HttpError(400, "INVALID_MOVEMENT", "Movement quantity must be positive");
  }

  let lotStatus: StockLotQualityStatus = null;
  if (lotId) {
    const lot = await db.query<{ lot_status: StockLotQualityStatus }>(
      `
        SELECT lot_status
        FROM public.lots
        WHERE id = $1::uuid
          AND article_id = $2::uuid
      `,
      [lotId, articleId]
    );
    const row = lot.rows[0] ?? null;
    if (!row) throw new HttpError(409, "LOT_ARTICLE_MISMATCH", "Lot does not belong to article");
    lotStatus = row.lot_status ?? "LIBERE";
  }

  const readState = async (locationId: string): Promise<LockedStockState> => {
    const state = await db.query<{
      stock_level_id: string;
      stock_batch_id: string | null;
      qty_on_hand: number;
      qty_reserved: number;
      qty_depreciated: number;
      lot_status: StockLotQualityStatus;
    }>(
      `
        SELECT
          stock_level_id::text AS stock_level_id,
          stock_batch_id::text AS stock_batch_id,
          qty_on_hand::float8 AS qty_on_hand,
          qty_reserved::float8 AS qty_reserved,
          qty_depreciated::float8 AS qty_depreciated,
          lot_status
        FROM public.v_stock_availability_225
        WHERE article_id = $1::uuid
          AND location_id = $2::uuid
          AND lot_id IS NOT DISTINCT FROM $3::uuid
        LIMIT 1
      `,
      [articleId, locationId, lotId]
    );
    return (
      state.rows[0] ?? {
        stock_level_id: "00000000-0000-0000-0000-000000000000",
        stock_batch_id: null,
        qty_on_hand: 0,
        qty_reserved: 0,
        qty_depreciated: 0,
        lot_status: lotStatus,
      }
    );
  };

  const impacts: StockMovementImpactPreview["impacts"] = [];
  const blockers: StockMovementImpactPreview["blockers"] = [];
  const batchIds: string[] = [];
  const addImpact = async (
    side: "SOURCE" | "DESTINATION",
    magasinId: string,
    emplacementId: number,
    effect:
      | "IN"
      | "OUT"
      | "DEPRECIATE"
      | "ADJUSTMENT_IN"
      | "ADJUSTMENT_OUT"
  ) => {
    const mapping = await getEmplacementMapping(
      db,
      magasinId,
      emplacementId,
      side === "SOURCE" ? "src" : "dst"
    );
    const state = await readState(mapping.location_id);
    if (state.stock_batch_id) batchIds.push(state.stock_batch_id);
    const before = calculateStockAvailability(state);
    if (side === "SOURCE") {
      try {
        assertStockConsumptionAllowed(state, {
          movement_type: body.movement_type,
          qty: effect === "ADJUSTMENT_OUT" ? -totalQty : totalQty,
        });
      } catch (error) {
        if (error instanceof HttpError) {
          blockers.push({ code: error.code, message: error.message });
        } else {
          throw error;
        }
      }
    }

    const afterInput = {
      qty_on_hand: state.qty_on_hand,
      qty_reserved: state.qty_reserved,
      qty_depreciated: state.qty_depreciated,
      lot_status: state.lot_status,
    };
    if (effect === "IN" || effect === "ADJUSTMENT_IN") {
      afterInput.qty_on_hand += totalQty;
    } else if (effect === "OUT" || effect === "ADJUSTMENT_OUT") {
      afterInput.qty_on_hand -= totalQty;
    } else if (effect === "DEPRECIATE") {
      afterInput.qty_depreciated += totalQty;
    }

    impacts.push({
      side,
      magasin_id: magasinId,
      emplacement_id: emplacementId,
      lot_id: lotId,
      before,
      after: calculateStockAvailability(afterInput),
    });
  };

  if (body.movement_type === "IN") {
    if (!first.dst_magasin_id || !first.dst_emplacement_id) {
      throw new HttpError(400, "INVALID_MOVEMENT", "IN requires destination location");
    }
    await addImpact("DESTINATION", first.dst_magasin_id, first.dst_emplacement_id, "IN");
  } else if (body.movement_type === "TRANSFER") {
    if (
      !first.src_magasin_id ||
      !first.src_emplacement_id ||
      !first.dst_magasin_id ||
      !first.dst_emplacement_id
    ) {
      throw new HttpError(400, "INVALID_MOVEMENT", "TRANSFER requires source and destination");
    }
    await addImpact("SOURCE", first.src_magasin_id, first.src_emplacement_id, "OUT");
    await addImpact("DESTINATION", first.dst_magasin_id, first.dst_emplacement_id, "IN");
  } else if (body.movement_type === "ADJUST" || body.movement_type === "ADJUSTMENT") {
    if (first.direction === "IN") {
      if (!first.dst_magasin_id || !first.dst_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT IN requires destination");
      }
      await addImpact(
        "DESTINATION",
        first.dst_magasin_id,
        first.dst_emplacement_id,
        "ADJUSTMENT_IN"
      );
    } else {
      if (!first.src_magasin_id || !first.src_emplacement_id) {
        throw new HttpError(400, "INVALID_MOVEMENT", "ADJUSTMENT OUT requires source");
      }
      await addImpact("SOURCE", first.src_magasin_id, first.src_emplacement_id, "ADJUSTMENT_OUT");
    }
  } else {
    if (!first.src_magasin_id || !first.src_emplacement_id) {
      throw new HttpError(400, "INVALID_MOVEMENT", `${body.movement_type} requires source`);
    }
    await addImpact(
      "SOURCE",
      first.src_magasin_id,
      first.src_emplacement_id,
      body.movement_type === "DEPRECIATE" || body.movement_type === "SCRAP"
        ? "DEPRECIATE"
        : "OUT"
    );
  }

  try {
    const scope = await readMaterialBarPostingScope(db, { articleId, explicit: false });
    if (scope.enabled && (scope.required || (batchIds.length > 0 && await readMaterialBarTracking(db, batchIds)))) {
      assertMaterialBarPostingInputs({ hasLotAtLocations: Boolean(lotId), hasGeometry: false });
    }
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    blockers.unshift({ code: error.code, message: error.message });
  }

  return {
    authoritative: true,
    as_of: new Date().toISOString(),
    movement_type: body.movement_type,
    qty_total: totalQty,
    can_post: blockers.length === 0,
    blockers,
    impacts,
  };
}

function buildCompensatingMovementBody(
  detail: StockMovementDetail,
  body: CompensateMovementBodyDTO
): {
  movement: CreateMovementBodyDTO | null;
  blockers: Array<{ code: string; message: string }>;
  prerequisites: StockMovementCompensationPreview["prerequisites"];
} {
  const blockers: Array<{ code: string; message: string }> = [];
  const prerequisites: StockMovementCompensationPreview["prerequisites"] = [];
  const addPrerequisite = (args: {
    code: string;
    label: string;
    satisfied: boolean;
    successMessage: string;
    failureMessage: string;
  }) => {
    const message = args.satisfied ? args.successMessage : args.failureMessage;
    prerequisites.push({
      code: args.code,
      label: args.label,
      satisfied: args.satisfied,
      message,
    });
    if (!args.satisfied) blockers.push({ code: args.code, message });
  };

  addPrerequisite({
    code: "INVALID_STATUS",
    label: "Mouvement comptabilisé",
    satisfied: detail.movement.status === "POSTED",
    successMessage: "Le mouvement d'origine est comptabilisé et reste immuable.",
    failureMessage:
      "Le mouvement doit être comptabilisé (statut POSTED) avant de préparer une compensation.",
  });

  const hasPostedAt = Boolean(detail.movement.posted_at);
  addPrerequisite({
    code: "POSTED_AT_MISSING",
    label: "Date de comptabilisation disponible",
    satisfied: hasPostedAt,
    successMessage: "La date de comptabilisation de l'écriture d'origine est disponible.",
    failureMessage:
      "La date de comptabilisation est absente. Rechargez le mouvement ou contactez le support Stock avant de continuer.",
  });

  if (detail.movement.posted_at) {
    const postingTimestampMatches =
      new Date(detail.movement.posted_at).getTime() ===
      new Date(body.expected_posted_at).getTime();
    addPrerequisite({
      code: "CONCURRENT_MODIFICATION",
      label: "Aperçu à jour",
      satisfied: postingTimestampMatches,
      successMessage: "Le mouvement n'a pas changé depuis son chargement.",
      failureMessage:
        "Le mouvement a changé depuis son chargement. Rechargez la fiche puis relancez la prévisualisation.",
    });
  }

  addPrerequisite({
    code: "MOVEMENT_LINES_MISSING",
    label: "Lignes de stock traçables",
    satisfied: detail.lines.length > 0,
    successMessage: "Les lignes de l'écriture d'origine sont traçables.",
    failureMessage:
      "Aucune ligne traçable n'est disponible. Vérifiez l'écriture d'origine avant de continuer.",
  });

  const movementType = detail.movement.movement_type;
  const movementTypePrerequisite = (() => {
    if (movementType === "SCRAP" || movementType === "DEPRECIATE") {
      return {
        code: "QUALITY_FLOW_REQUIRED",
        failureMessage:
          "Les rebuts et dépréciations se corrigent depuis le flux Qualité dédié.",
      };
    }
    if (movementType === "RESERVE" || movementType === "UNRESERVE") {
      return {
        code: "RESERVATION_FLOW_REQUIRED",
        failureMessage:
          "Les réservations se corrigent depuis leur cycle de vie dédié.",
      };
    }
    const supported = new Set(["IN", "OUT", "TRANSFER", "ADJUST", "ADJUSTMENT"]);
    return supported.has(movementType)
      ? null
      : {
          code: "MOVEMENT_NOT_COMPENSABLE",
          failureMessage:
            "Ce type de mouvement ne peut pas être compensé automatiquement. Contactez le responsable Stock.",
        };
  })();
  addPrerequisite({
    code: movementTypePrerequisite?.code ?? "MOVEMENT_TYPE_SUPPORTED",
    label: "Type de mouvement pris en charge",
    satisfied: movementTypePrerequisite === null,
    successMessage: "Le type de mouvement peut produire un brouillon inverse.",
    failureMessage:
      movementTypePrerequisite?.failureMessage ??
      "Ce type de mouvement ne peut pas être compensé automatiquement.",
  });

  if (blockers.length) return { movement: null, blockers, prerequisites };

  let reverseType: CreateMovementBodyDTO["movement_type"];
  switch (detail.movement.movement_type) {
    case "IN":
      reverseType = "OUT";
      break;
    case "OUT":
      reverseType = "IN";
      break;
    case "TRANSFER":
      reverseType = "TRANSFER";
      break;
    case "ADJUST":
    case "ADJUSTMENT":
      reverseType = "ADJUSTMENT";
      break;
    default:
      return {
        movement: null,
        blockers: [
          {
            code: "MOVEMENT_NOT_COMPENSABLE",
            message:
              "Ce type de mouvement ne peut pas être compensé automatiquement. Contactez le responsable Stock.",
          },
        ],
        prerequisites,
      };
  }

  const reverseLines: CreateMovementLineDTO[] = detail.lines.map((line) => {
    const base = {
      line_no: line.line_no,
      article_id: line.article_id,
      lot_id: line.lot_id,
      qty: Math.abs(line.qty),
      unite: line.unite,
      unit_cost: line.unit_cost,
      currency: line.currency,
      note: `Compensation ${detail.movement.movement_no ?? detail.movement.id}`,
    };
    if (reverseType === "OUT") {
      return {
        ...base,
        src_magasin_id: line.dst_magasin_id,
        src_emplacement_id: line.dst_emplacement_id,
        dst_magasin_id: null,
        dst_emplacement_id: null,
      };
    }
    if (reverseType === "IN") {
      return {
        ...base,
        src_magasin_id: null,
        src_emplacement_id: null,
        dst_magasin_id: line.src_magasin_id,
        dst_emplacement_id: line.src_emplacement_id,
      };
    }
    if (reverseType === "TRANSFER") {
      return {
        ...base,
        src_magasin_id: line.dst_magasin_id,
        src_emplacement_id: line.dst_emplacement_id,
        dst_magasin_id: line.src_magasin_id,
        dst_emplacement_id: line.src_emplacement_id,
      };
    }

    const originalWasInbound = detail.movement.qty > 0;
    return originalWasInbound
      ? {
          ...base,
          src_magasin_id: line.dst_magasin_id,
          src_emplacement_id: line.dst_emplacement_id,
          dst_magasin_id: null,
          dst_emplacement_id: null,
          direction: "OUT" as const,
        }
      : {
          ...base,
          src_magasin_id: null,
          src_emplacement_id: null,
          dst_magasin_id: line.src_magasin_id,
          dst_emplacement_id: line.src_emplacement_id,
          direction: "IN" as const,
        };
  });

  return {
    blockers,
    prerequisites,
    movement: {
      movement_type: reverseType,
      effective_at: new Date().toISOString(),
      source_document_type: "STOCK_COMPENSATION",
      source_document_id: detail.movement.id,
      reason_code: "COMPENSATION",
      notes:
        body.notes ??
        `${body.reason} — compensation de ${detail.movement.movement_no ?? detail.movement.id}`,
      idempotency_key: null,
      lines: reverseLines,
    },
  };
}

export async function repoPreviewMovementCompensation(
  id: string,
  body: CompensateMovementBodyDTO
): Promise<StockMovementCompensationPreview | null> {
  const detail = await repoGetMovement(id);
  if (!detail) return null;
  const existing = await db.query<{ id: string; movement_no: string | null; status: string }>(
    `
      SELECT id::text AS id, movement_no, status
      FROM public.stock_movements
      WHERE reversal_of_id = $1::uuid
        AND status::text <> 'CANCELLED'
      LIMIT 1
    `,
    [id]
  );
  const built = buildCompensatingMovementBody(detail, body);
  if(await consumableWithdrawalOwnsMovement(db,id))built.blockers.push({code:'CONSUMABLE_WITHDRAWAL_CORRECTION_REQUIRED',message:'Ce mouvement est lié à un prélèvement OF. Sa correction doit rapprocher la sortie et la réservation consommée.'});
  if (await assemblyComponentWithdrawalOwnsMovement(db, id)) built.blockers.push({ code: 'ASSEMBLY_COMPONENT_CORRECTION_REQUIRED', message: 'La correction doit rapprocher les composants mis en montage et leurs réservations consommées.' });
  const materialOwned=(await db.query(`SELECT 1 FROM public.production_material_debit_sources WHERE stock_movement_id=$1::uuid
    UNION ALL SELECT 1 FROM public.production_material_remnants WHERE stock_movement_id=$1::uuid LIMIT 1`,[id])).rows.length>0;
  if(materialOwned)built.blockers.push({code:'MATERIAL_DEBIT_CORRECTION_REQUIRED',message:'Corrigez ce mouvement depuis le débit matière de l’OF pour conserver ensemble stock, bruts et transferts.'});
  if (!built.blockers.length && detail.movement.stock_batch_id && !existing.rows.length) {
    const physicalPreview = await db.connect();
    try {
      await physicalPreview.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const eligible = await previewMaterialBarCompensationTx(physicalPreview, id);
      await physicalPreview.query('COMMIT');
      if (eligible) built.prerequisites.push({ code:'MATERIAL_BAR_COMPENSATION_READY',label:'Barres d’origine disponibles',
        satisfied:true,message:'Les barres seront reprises automatiquement depuis le mouvement d’origine.' });
    } catch (error) {
      await physicalPreview.query('ROLLBACK');
      if (!(error instanceof HttpError)) throw error;
      built.blockers.push({ code:error.code,message:error.message });
      built.prerequisites.push({ code:error.code,label:'Barres d’origine disponibles',satisfied:false,message:error.message });
    } finally { physicalPreview.release(); }
  }
  const existingCompensation = existing.rows[0] ?? null;
  const noExistingCompensation = !existingCompensation;
  const existingMessage = existingCompensation
    ? `La compensation ${existingCompensation.movement_no ?? existingCompensation.id} existe déjà au statut ${existingCompensation.status}. Ouvrez-la au lieu de créer un doublon.`
    : "Aucune compensation active n'existe pour ce mouvement.";
  built.prerequisites.push({
    code: "COMPENSATION_ALREADY_EXISTS",
    label: "Aucune compensation déjà active",
    satisfied: noExistingCompensation,
    message: existingMessage,
  });
  if (existingCompensation) {
    built.blockers.push({
      code: "COMPENSATION_ALREADY_EXISTS",
      message: existingMessage,
    });
  }
  const proposed = built.blockers.length === 0 && built.movement
    ? {
        movement_type: built.movement.movement_type,
        source_document_type: "STOCK_COMPENSATION" as const,
        source_document_id: id,
        reason_code: "COMPENSATION" as const,
        notes: built.movement.notes ?? body.reason,
        lines: built.movement.lines.map((line) => ({
          article_id: line.article_id,
          lot_id: line.lot_id ?? null,
          qty: line.qty,
          unite: line.unite ?? null,
          src_magasin_id: line.src_magasin_id ?? null,
          src_emplacement_id: line.src_emplacement_id ?? null,
          dst_magasin_id: line.dst_magasin_id ?? null,
          dst_emplacement_id: line.dst_emplacement_id ?? null,
          ...(line.direction ? { direction: line.direction } : {}),
        })),
      }
    : null;

  return {
    authoritative: true,
    as_of: new Date().toISOString(),
    original_movement_id: id,
    original_movement_no: detail.movement.movement_no,
    outcome: existingCompensation
      ? "ALREADY_COMPENSATED"
      : built.blockers.length === 0
        ? "ELIGIBLE"
        : "INELIGIBLE",
    compensable: built.blockers.length === 0,
    blockers: built.blockers,
    prerequisites: built.prerequisites,
    existing_compensation: existingCompensation,
    proposed_movement: proposed,
  };
}

export async function repoCompensateMovement(
  id: string,
  body: CompensateMovementBodyDTO,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  const key = normalizeIdempotencyKey(idempotencyKey);
  const lockClient = await db.connect();
  let sessionLockHeld = false;
  try {
    await lockClient.query(`SELECT pg_advisory_lock(hashtextextended($1, 0))`, [
      `stock-compensation:${id}`,
    ]);
    sessionLockHeld = true;

    await lockClient.query("BEGIN");
    const existingCommand = await beginStockCommand(lockClient, {
      audit,
      idempotency_key: key,
      command_type: "MOVEMENT_COMPENSATE",
      request_payload: { movement_id: id, ...body },
    });
    if (existingCommand.existing) {
      await lockClient.query("COMMIT");
      return repoGetMovement(existingCommand.existing.resource_id);
    }
    await lockClient.query("COMMIT");

    const preview = await repoPreviewMovementCompensation(id, body);
    if (!preview) return null;
    if (!preview.compensable || !preview.proposed_movement) {
      const blocker = preview.blockers[0] ?? {
        code: "MOVEMENT_NOT_COMPENSABLE",
        message: "Le mouvement ne peut pas être compensé.",
      };
      throw new HttpError(409, blocker.code, blocker.message, { blockers: preview.blockers });
    }

    const detail = await repoGetMovement(id);
    if (!detail) return null;
    const built = buildCompensatingMovementBody(detail, body);
    if (!built.movement) {
      throw new HttpError(
        409,
        "MOVEMENT_NOT_COMPENSABLE",
        "Le mouvement ne peut pas être compensé."
      );
    }
    const derivedKeyHash = hashStockCommand("MOVEMENT_COMPENSATION_CREATE_KEY", {
      actor_user_id: audit.user_id,
      idempotency_key: key,
    });
    const compensation = await repoCreateMovement(
      {
        ...built.movement,
        idempotency_key: `comp-create-${derivedKeyHash}`,
      },
      audit,
      { trusted_source_flow: true }
    );

    await lockClient.query("BEGIN");
    const command = await beginStockCommand(lockClient, {
      audit,
      idempotency_key: key,
      command_type: "MOVEMENT_COMPENSATE",
      request_payload: { movement_id: id, ...body },
    });
    if (command.existing) {
      await lockClient.query("COMMIT");
      return repoGetMovement(command.existing.resource_id);
    }

    const locked = await lockClient.query<{ original_status: string; compensation_status: string }>(
      `
        SELECT
          original.status::text AS original_status,
          compensation.status::text AS compensation_status
        FROM public.stock_movements original
        JOIN public.stock_movements compensation ON compensation.id = $2::uuid
        WHERE original.id = $1::uuid
        FOR UPDATE OF original, compensation
      `,
      [id, compensation.movement.id]
    );
    const state = locked.rows[0] ?? null;
    if (!state) throw new HttpError(409, "MOVEMENT_MISSING", "Movement disappeared during compensation");
    if (state.original_status !== "POSTED" || state.compensation_status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Compensation status changed concurrently");
    }

    await lockClient.query(
      `
        UPDATE public.stock_movements
        SET
          reversal_of_id = $2::uuid,
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $4
        WHERE id = $1::uuid
      `,
      [compensation.movement.id, id, command.correlation_id, audit.user_id]
    );
    await insertMovementEvent(lockClient, {
      movement_id: id,
      event_type: "COMPENSATION_PREPARED",
      old_values: null,
      new_values: {
        compensation_movement_id: compensation.movement.id,
        correlation_id: command.correlation_id,
      },
      user_id: audit.user_id,
    });
    await insertMovementEvent(lockClient, {
      movement_id: compensation.movement.id,
      event_type: "LINKED_AS_COMPENSATION",
      old_values: null,
      new_values: {
        reversal_of_id: id,
        correlation_id: command.correlation_id,
      },
      user_id: audit.user_id,
    });
    await insertAuditLog(lockClient, audit, {
      action: "stock.movements.compensation.prepare",
      entity_type: "stock_movements",
      entity_id: compensation.movement.id,
      details: {
        reversal_of_id: id,
        reason: body.reason,
        correlation_id: command.correlation_id,
      },
    });
    await completeStockCommand(lockClient, {
      audit,
      command,
      command_type: "MOVEMENT_COMPENSATE",
      resource_type: "stock_movement",
      resource_id: compensation.movement.id,
      result_payload: {
        compensation_movement_id: compensation.movement.id,
        reversal_of_id: id,
        status: "DRAFT",
      },
    });
    await lockClient.query("COMMIT");
    return repoGetMovement(compensation.movement.id);
  } catch (error) {
    await lockClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    if (sessionLockHeld) {
      await lockClient
        .query(`SELECT pg_advisory_unlock(hashtextextended($1, 0))`, [`stock-compensation:${id}`])
        .catch(() => undefined);
    }
    lockClient.release();
  }
}

export async function repoCancelMovement(
  id: string,
  audit: AuditContext,
  idempotencyKey: string
): Promise<StockMovementDetail | null> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const command = await beginStockCommand(client, {
      audit,
      idempotency_key: idempotencyKey,
      command_type: "MOVEMENT_CANCEL",
      request_payload: { movement_id: id },
    });
    if (command.existing) {
      const existingId = command.existing.resource_id;
      await client.query("COMMIT");
      return repoGetMovement(existingId);
    }

    const lock = await client.query<{ status: string; movement_no: string | null }>(
      `SELECT status, movement_no FROM public.stock_movements WHERE id = $1::uuid FOR UPDATE`,
      [id]
    );
    const m = lock.rows[0] ?? null;
    if (!m) {
      await client.query("ROLLBACK");
      return null;
    }
    if (m.status !== "DRAFT") {
      throw new HttpError(409, "INVALID_STATUS", "Only DRAFT movements can be cancelled");
    }

    await client.query(
      `
        UPDATE public.stock_movements
        SET
          status = 'CANCELLED',
          correlation_id = $3::uuid,
          updated_at = now(),
          updated_by = $2
        WHERE id = $1::uuid
      `,
      [id, audit.user_id, command.correlation_id]
    );

    await insertMovementEvent(client, {
      movement_id: id,
      event_type: "CANCELLED",
      old_values: { status: "DRAFT" },
      new_values: { status: "CANCELLED" },
      user_id: audit.user_id,
    });

    await insertAuditLog(client, audit, {
      action: "stock.movements.cancel",
      entity_type: "stock_movements",
      entity_id: id,
      details: { movement_no: m.movement_no },
    });

    await completeStockCommand(client, {
      audit,
      command,
      command_type: "MOVEMENT_CANCEL",
      resource_type: "stock_movement",
      resource_id: id,
      result_payload: {
        movement_id: id,
        status: "CANCELLED",
      },
    });

    await client.query("COMMIT");
    return repoGetMovement(id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
