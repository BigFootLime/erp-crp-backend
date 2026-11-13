import { forecastForFirmDraft } from "../repository/demand-forecast-conversion";
import { createHash } from "node:crypto";
import pool from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { repoCreateCommandeDraftTx } from "../../commande-client/repository/commande-client.repository";
import type { CreateCommandeInput } from "../../commande-client/types/commande-client.types";
import type { FirmDraftInput } from "../validators/demand-pilot-firm-draft.validators";
const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const current = `NOT EXISTS(SELECT 1 FROM public.demand_pilot_revisions n WHERE n.client_id=r.client_id AND n.external_site=r.external_site AND n.external_order_key=r.external_order_key AND n.external_line_key=r.external_line_key AND n.external_schedule_key=r.external_schedule_key AND n.revision_no>r.revision_no)`;
/** Creates one canonical order for a homogeneous external order.  The advisory
 * lock and immutable crosswalk make retries and concurrent ADV clicks safe. */
export async function prepareFirmDraft(
  input: FirmDraftInput,
  actorId: number,
  intentKey: string,
) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const requestHash = digest(input);
    const replay = await tx.query<any>(
      "SELECT commande_id::text,request_hash FROM public.demand_pilot_firm_drafts WHERE intent_key=$1::uuid FOR UPDATE",
      [intentKey],
    );
    if (replay.rowCount) {
      if (replay.rows[0].request_hash !== requestHash)
        throw new HttpError(
          409,
          "DEMAND_FIRM_DRAFT_IDEMPOTENCY_CONFLICT",
          "Cette clé d’intention correspond à une autre préparation.",
        );
      await tx.query("COMMIT");
      return {
        replayed: true,
        commande_id: Number(replay.rows[0].commande_id),
      };
    }
    const ids = [...input.revision_ids].sort();
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext('demand-firm-draft'),hashtext($1))",
      [`${input.client_id}:${ids.join(",")}`],
    );
    const revisions = (
      await tx.query<any>(
        `SELECT r.id::text,r.client_id,r.external_site,r.external_order_key,r.kind,r.status,r.diff_type,r.quantity::float8,r.quantity_basis,r.unit,r.need_date::text,r.article_id::text,r.article_code,r.contract_id::text,r.contract_line_id::text,r.revision_no,
    article.piece_technique_id::text AS piece_technique_id,contract_line.configured_piece_technique_version_id::text AS piece_technique_version_id,
    EXISTS(SELECT 1 FROM public.demand_pilot_firm_draft_lines dl WHERE dl.revision_id=r.id) AS drafted,
    EXISTS(SELECT 1 FROM public.demand_pilot_firm_bindings b JOIN public.delivery_promise_parts p ON p.root_id=b.promise_root_id JOIN public.delivery_promise_shipments s ON s.part_id=p.id WHERE b.revision_id=r.id) AS shipped
    FROM public.demand_pilot_revisions r
    LEFT JOIN public.articles article ON article.id=r.article_id
    LEFT JOIN public.client_contract_lines contract_line ON contract_line.id=r.contract_line_id
    WHERE r.id=ANY($1::uuid[]) AND r.client_id=$2 FOR UPDATE OF r`,
        [ids, input.client_id],
      )
    ).rows;
    if (revisions.length !== ids.length)
      throw new HttpError(
        404,
        "DEMAND_PILOT_NOT_FOUND",
        "Une révision sélectionnée est introuvable.",
      );
    const scope = new Set(
      revisions.map(
        (r: any) =>
          `${r.client_id}\u0000${r.external_site}\u0000${r.external_order_key}`,
      ),
    );
    if (scope.size !== 1)
      throw new HttpError(
        422,
        "DEMAND_FIRM_DRAFT_SCOPE",
        "Les révisions doivent partager le client, le site et la commande externe.",
      );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[JSON.stringify(["firm-draft",input.client_id,revisions[0].external_site,revisions[0].external_order_key])]);
    const existingDraft = (
      await tx.query<any>(
        "SELECT commande_id::text FROM public.demand_pilot_firm_drafts WHERE client_id=$1 AND external_site=$2 AND external_order_key=$3 FOR UPDATE",
        [
          input.client_id,
          revisions[0].external_site,
          revisions[0].external_order_key,
        ],
      )
    ).rows[0];
    if (existingDraft) {
      const linked=await tx.query("SELECT dl.revision_id FROM public.demand_pilot_firm_draft_lines dl JOIN public.demand_pilot_firm_drafts d ON d.id=dl.draft_id WHERE d.commande_id=$1 AND dl.revision_id=ANY($2::uuid[])",[existingDraft.commande_id,ids]);
      if (linked.rowCount!==ids.length)
        throw new HttpError(409,"DEMAND_EXISTING_ORDER_REVIEW","Cette commande existe déjà. Rapprochez les nouvelles échéances avec ses lignes avant de continuer.");
      await tx.query("COMMIT");
      const commandeId = Number(existingDraft.commande_id);
      return {
        replayed: false,
        existing_draft: true,
        commande_id: commandeId,
        review_url: `/commandes/${commandeId}`,
        ar_url: `/commandes/${commandeId}/acknowledgements`,
      };
    }
    for (const r of revisions) {
      if (
        r.kind !== "FIRM" ||
        r.status === "REJECTED" ||
        r.diff_type === "REMOVED" ||
        r.drafted ||
        r.shipped ||
        !r.article_id
      )
        throw new HttpError(
          409,
          "DEMAND_FIRM_DRAFT_INELIGIBLE",
          "Révision ferme annulée, ancienne, liée ou non résolue.",
        );
      const newer = await tx.query(
        `SELECT 1 FROM public.demand_pilot_revisions r WHERE r.id=$1::uuid AND ${current}`,
        [r.id],
      );
      if (!newer.rowCount)
        throw new HttpError(
          409,
          "DEMAND_PILOT_STALE",
          "Une révision a été remplacée.",
        );
    }
    const client = (
      await tx.query<any>(
        "SELECT client_id FROM public.clients WHERE client_id=$1 FOR SHARE",
        [input.client_id],
      )
    ).rows[0];
    if (!client)
      throw new HttpError(
        422,
        "DEMAND_FIRM_DRAFT_CLIENT",
        "Client commercial introuvable.",
      );
    const byId = new Map(input.lines.map((l) => [l.revision_id, l]));
    const contractIds = new Set(
      revisions
        .map((revision: any) => revision.contract_id as string | null)
        .filter((contractId): contractId is string => contractId !== null),
    );
    let contractCall = input.client_contract_call ?? null;
    if (contractIds.size && !contractCall) {
      const contractId = [...contractIds][0];
      const contract = (
        await tx.query<{ version: number }>(
          "SELECT version FROM public.client_contracts WHERE id=$1::uuid AND client_id=$2 AND status='ACTIVE' FOR SHARE",
          [contractId, input.client_id],
        )
      ).rows[0];
      if (!contract)
        throw new HttpError(
          409,
          "DEMAND_FIRM_DRAFT_CONTRACT_INACTIVE",
          "Le contrat de cette demande ferme n’est plus actif.",
        );
      contractCall = {
        contract_id: contractId,
        expected_version: contract.version,
        idempotency_key: intentKey,
      };
    }
    if (
      contractCall &&
      (contractIds.size !== 1 ||
        !contractIds.has(contractCall.contract_id))
    )
      throw new HttpError(
        422,
        "DEMAND_FIRM_DRAFT_CONTRACT_SCOPE",
        "Les révisions sélectionnées ne correspondent pas au contrat choisi.",
      );
    const allocations=new Map<string,Awaited<ReturnType<typeof forecastForFirmDraft>>>();
    for(const revision of revisions) {
      if(revision.contract_line_id) allocations.set(revision.id,await forecastForFirmDraft(tx,revision.id));
    }
    const lines = revisions
      .sort((a: any, b: any) => a.need_date.localeCompare(b.need_date) || a.id.localeCompare(b.id))
      .map((r: any) => {
        const l = byId.get(r.id)!;
        return {
          article_id: r.article_id,
          piece_technique_id: r.piece_technique_id ?? null,
          piece_technique_version_id: r.piece_technique_version_id ?? null,
          client_contract_line_id: r.contract_line_id ?? null,
          client_forecast_allocations: allocations.get(r.id) ?? [],
          designation: l.designation,
          code_piece: r.article_code,
          quantite: r.quantity,
          unite: r.unit,
          prix_unitaire_ht: l.prix_unitaire_ht,
          taux_tva: l.taux_tva,
          remise_ligne: l.remise_ligne,
          delai_client: r.need_date,
          reference_price_decision: "SET" as const,
          reference_price_quote_line_id:
            l.reference_price_quote_line_id ?? null,
        };
      });
    const totalHt = lines.reduce(
        (n, l) =>
          n + l.quantite * l.prix_unitaire_ht * (1 - l.remise_ligne / 100),
        0,
      ),
      totalTtc = lines.reduce(
        (n, l) =>
          n +
          l.quantite *
            l.prix_unitaire_ht *
            (1 - l.remise_ligne / 100) *
            (1 + l.taux_tva / 100),
        0,
      );
    const command: CreateCommandeInput = {
      client_id: input.client_id,
      code_client: input.client_id,
      date_commande: new Date().toISOString().slice(0, 10),
      order_type: "FERME",
      commentaire:
        input.commentaire ??
        `Préparation ADV programme ferme ${revisions[0].external_order_key}`,
      mode_reglement_id: input.mode_reglement_id ?? null,
      conditions_paiement_id: input.conditions_paiement_id ?? null,
      biller_id: input.biller_id ?? null,
      compte_vente_id: input.compte_vente_id ?? null,
      total_ht: totalHt,
      total_ttc: totalTtc,
      lignes: lines,
      client_contract_call: contractCall,
    };
    const created = await repoCreateCommandeDraftTx(tx, command, actorId, "client_demand");
    const draft = (
      await tx.query<any>(
        `INSERT INTO public.demand_pilot_firm_drafts(intent_key,request_hash,client_id,external_site,external_order_key,commande_id,created_by_user_id) VALUES($1::uuid,$2,$3,$4,$5,$6::bigint,$7) RETURNING id::text`,
        [
          intentKey,
          requestHash,
          input.client_id,
          revisions[0].external_site,
          revisions[0].external_order_key,
          created.id,
          actorId,
        ],
      )
    ).rows[0];
    const orderLines = (
      await tx.query<any>(
        "SELECT id::text,article_id::text,delai_client::text FROM public.commande_ligne WHERE commande_id=$1::bigint ORDER BY id",
        [created.id],
      )
    ).rows;
    // The native writer inserts lines sequentially in payload order. Two distinct
    // customer schedules can share both article and date.
    if(orderLines.length!==revisions.length) throw new Error("DEMAND_FIRM_DRAFT_LINE_CROSSWALK_FAILED");
    for (const [index,r] of revisions.entries()) {
      const matched=orderLines[index];
      if (matched.article_id!==r.article_id || matched.delai_client!==r.need_date) throw new Error("DEMAND_FIRM_DRAFT_LINE_CROSSWALK_FAILED");
      await tx.query(
        "INSERT INTO public.demand_pilot_firm_draft_lines(revision_id,draft_id,commande_ligne_id,source_revision_no) VALUES($1::uuid,$2::uuid,$3::bigint,$4)",
        [r.id, draft.id, matched.id, r.revision_no],
      );
    }
    await tx.query("COMMIT");
    return {
      replayed: false,
      commande_id: created.id,
      numero: created.numero,
      review_url: `/commandes/${created.id}`,
      ar_url: `/commandes/${created.id}/acknowledgements`,
    };
  } catch (e) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    tx.release();
  }
}
