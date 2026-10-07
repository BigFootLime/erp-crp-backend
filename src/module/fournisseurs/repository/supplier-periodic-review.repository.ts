import crypto from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoInsertAuditLog } from "../../audit-logs/repository/audit-logs.repository";
import { lockSupplierQualificationTx } from "./purchase-homologation.repository";
import { readReviewEvidence } from "./supplier-periodic-review-read.repository";
import type { SupplierReviewCommand } from "../domain/supplier-periodic-review";

export async function repoSupplierReviewCommand(
  supplierId: string,
  input: SupplierReviewCommand,
  actor: number,
) {
  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ supplierId, input, actor }))
    .digest("hex");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `supplier-review:${input.idempotency_key}`,
    ]);
    const replay = (
      await tx.query(
        "SELECT request_hash,result FROM public.supplier_review_commands WHERE idempotency_key=$1::uuid",
        [input.idempotency_key],
      )
    ).rows[0];
    if (replay) {
      if (replay.request_hash !== hash)
        throw new HttpError(
          409,
          "SUPPLIER_REVIEW_REQUEST_CONFLICT",
          "Cette demande a déjà été utilisée avec un autre contenu.",
        );
      await tx.query("COMMIT");
      return replay.result;
    }
    if (!(await lockSupplierQualificationTx(tx, supplierId)))
      throw new HttpError(
        404,
        "FOURNISSEUR_NOT_FOUND",
        "Fournisseur introuvable.",
      );
    let result: Record<string, unknown>;
    if (input.action === "CONFIGURE") {
      if (
        !(
          await tx.query(
            `SELECT id FROM public.users WHERE id=$1 AND COALESCE(NULLIF(lower(trim(status)),''),'active') NOT IN ('inactive','blocked','suspended') FOR SHARE`,
            [input.owner_id],
          )
        ).rows.length
      )
        throw new HttpError(
          422,
          "SUPPLIER_REVIEW_OWNER_INVALID",
          "Choisissez un responsable actif.",
        );
      if (
        input.domaine_code &&
        !(
          await tx.query(
            "SELECT code FROM public.fournisseur_domaines WHERE code=$1 AND is_active FOR SHARE",
            [input.domaine_code],
          )
        ).rows.length
      )
        throw new HttpError(
          422,
          "SUPPLIER_REVIEW_DOMAIN_INVALID",
          "Choisissez un domaine actif.",
        );
      let scope = (
        await tx.query(
          "SELECT id::text FROM public.supplier_review_scopes WHERE supplier_id=$1::uuid AND domaine_code IS NOT DISTINCT FROM $2::text",
          [supplierId, input.domaine_code],
        )
      ).rows[0];
      if (!scope)
        scope = (
          await tx.query(
            "INSERT INTO public.supplier_review_scopes(supplier_id,domaine_code,created_by)VALUES($1::uuid,$2,$3)RETURNING id::text",
            [supplierId, input.domaine_code, actor],
          )
        ).rows[0];
      const policy = (
        await tx.query(
          `INSERT INTO public.supplier_review_policies(scope_id,revision,enabled,cadence_months,first_due,owner_id,reason,created_by)
 SELECT $1::uuid,COALESCE(max(revision),0)+1,$2,$3,$4::date,$5,$6,$7 FROM public.supplier_review_policies WHERE scope_id=$1::uuid RETURNING id::text,revision`,
          [
            scope.id,
            input.enabled,
            input.cadence_months,
            input.first_due,
            input.owner_id,
            input.reason,
            actor,
          ],
        )
      ).rows[0];
      result = {
        scope_id: scope.id,
        policy_id: policy.id,
        revision: policy.revision,
      };
    } else {
      const policy = (
        await tx.query(
          `SELECT p.*,s.supplier_id::text,(statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today FROM public.supplier_review_scopes s JOIN LATERAL(SELECT * FROM public.supplier_review_policies x WHERE x.scope_id=s.id ORDER BY revision DESC LIMIT 1)p ON true WHERE s.id=$1::uuid AND s.supplier_id=$2::uuid`,
          [input.scope_id, supplierId],
        )
      ).rows[0];
      if (!policy)
        throw new HttpError(
          404,
          "SUPPLIER_REVIEW_SCOPE_NOT_FOUND",
          "Programme d’évaluation introuvable.",
        );
      if (policy.id !== input.expected_policy_id)
        throw new HttpError(
          409,
          "SUPPLIER_REVIEW_POLICY_CHANGED",
          "Le programme a changé. Rechargez avant d’enregistrer.",
        );
      if (!policy.enabled)
        throw new HttpError(
          409,
          "SUPPLIER_REVIEW_DISABLED",
          "Réactivez le programme avant d’enregistrer une évaluation.",
        );
      if (input.evaluated_on > policy.today)
        throw new HttpError(
          422,
          "SUPPLIER_REVIEW_FUTURE_EVALUATION",
          "Une évaluation ne peut pas être datée dans le futur.",
        );
      const evidence = await readReviewEvidence(
        tx,
        supplierId,
        input.version_id,
      );
      if (!evidence)
        throw new HttpError(
          422,
          "SUPPLIER_REVIEW_EVIDENCE_REQUIRED",
          "Choisissez un PDF d’évaluation fournisseur approuvé et applicable dans la GED de ce fournisseur.",
        );
      if (input.supersedes_id) {
        const old = (
          await tx.query(
            "SELECT *,period_from::text AS period_from_text,period_to::text AS period_to_text FROM public.supplier_review_evaluations WHERE id=$1::uuid AND scope_id=$2::uuid",
            [input.supersedes_id, input.scope_id],
          )
        ).rows[0];
        if (
          !old ||
          (
            await tx.query(
              "SELECT id FROM public.supplier_review_evaluations WHERE supersedes_id=$1::uuid",
              [input.supersedes_id],
            )
          ).rows.length
        )
          throw new HttpError(
            409,
            "SUPPLIER_REVIEW_CORRECTION_INVALID",
            "Cette évaluation est introuvable ou déjà remplacée.",
          );
        if (
          old.period_from_text !== input.period_from ||
          old.period_to_text !== input.period_to
        )
          throw new HttpError(
            422,
            "SUPPLIER_REVIEW_CORRECTION_PERIOD_INVALID",
            "Une correction conserve la période examinée.",
          );
        if (old.version_id === input.version_id)
          throw new HttpError(
            422,
            "SUPPLIER_REVIEW_NEW_EVIDENCE_REQUIRED",
            "La correction doit utiliser une nouvelle version approuvée de la preuve.",
          );
      } else if (
        (
          await tx.query(
            `SELECT id FROM public.supplier_review_evaluations e WHERE scope_id=$1::uuid AND period_from=$2::date AND period_to=$3::date AND NOT EXISTS(SELECT 1 FROM public.supplier_review_evaluations x WHERE x.supersedes_id=e.id)`,
            [input.scope_id, input.period_from, input.period_to],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          "SUPPLIER_REVIEW_PERIOD_EXISTS",
          "Cette période est déjà évaluée. Utilisez une correction motivée.",
        );
      const evaluation = (
        await tx.query(
          `INSERT INTO public.supplier_review_evaluations(policy_id,scope_id,period_from,period_to,evaluated_on,next_due,outcome,quality_score,delivery_score,responsiveness_score,observations,actions,document_id,version_id,evidence_snapshot,supersedes_id,correction_reason,created_by)
 VALUES($1::uuid,$2::uuid,$3::date,$4::date,$5::date,$6::date,$7,$8,$9,$10,$11,$12,$13::uuid,$14::uuid,$15::jsonb,$16::uuid,$17,$18)RETURNING id::text`,
          [
            policy.id,
            input.scope_id,
            input.period_from,
            input.period_to,
            input.evaluated_on,
            input.next_due,
            input.outcome,
            input.quality_score,
            input.delivery_score,
            input.responsiveness_score,
            input.observations,
            input.actions,
            evidence.document_id,
            evidence.version_id,
            JSON.stringify(evidence),
            input.supersedes_id,
            input.correction_reason,
            actor,
          ],
        )
      ).rows[0];
      await tx.query(
        "INSERT INTO public.ged_retention_holds(document_id,hold_type,reason,placed_by)VALUES($1::uuid,'QUALITE',$2,$3)",
        [evidence.document_id, `Supplier review ${evaluation.id}`, actor],
      );
      result = { scope_id: input.scope_id, evaluation_id: evaluation.id };
    }
    await tx.query(
      "INSERT INTO public.supplier_review_commands(idempotency_key,actor_id,request_hash,result)VALUES($1::uuid,$2,$3,$4::jsonb)",
      [input.idempotency_key, actor, hash, JSON.stringify(result)],
    );
    await repoInsertAuditLog({
      tx,
      user_id: actor,
      ip: null,
      user_agent: null,
      device_type: null,
      os: null,
      browser: null,
      body: {
        event_type: "ACTION",
        action:
          input.action === "CONFIGURE"
            ? "SUPPLIER_REVIEW_PROGRAM_REVISED"
            : "SUPPLIER_REVIEW_RECORDED",
        entity_type: "FOURNISSEUR",
        entity_id: supplierId,
        details: { ...result, input },
      },
    });
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
