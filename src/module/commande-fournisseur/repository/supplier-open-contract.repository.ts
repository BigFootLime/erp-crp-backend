import crypto from "node:crypto";
import type { PoolClient } from "pg";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { assertGedVersionParentReadable } from "../../ged/services/ged-parent-authorization.service";
import {
  freezeGeneralTerms,
  readTermsSelection,
  readTermsVersion,
} from "../../../shared/commercial-terms/commercial-terms.repository";
import {
  supplierContractsInstalled,
  readSupplierContractTermsTx,
} from "../../../shared/commercial-terms/supplier-contract-terms.repository";
import { withRealtimeOutboxTransaction } from "../../../shared/realtime/realtime-outbox-transaction";
import { enqueueEntityChanged } from "../../../shared/realtime/realtime-outbox.service";
import { roleHasCommandeFournisseurCapability } from "../domain/commande-fournisseur-rbac";
import { consultationSnapshotKey } from "../domain/supplier-consultation";
import {
  assertContractCapacity,
  assertContractWindow,
  type ContractEvidence,
  type ContractItem,
  type ContractRevision,
  type ContractSnapshot,
  type SupplierOpenContractCommand,
} from "../domain/supplier-open-contract";
import {
  assertDraft,
  assertOptimisticToken,
  insertAuditLog,
  lockHeader,
  type AuditContext,
} from "./commande-fournisseur.repository";
import { readConsultationTechnicalSourcesTx } from "./consultation-technical.repository";
import { readConsultationDocuments } from "./consultation-documents.repository";
import {
  CONTRACT_EVIDENCE_SQL,
  readContractRevisionTx,
  readContractUsageTx,
  readContractOrderSnapshotTx,
  type OrderLine,
  type OrderSnapshot,
} from "./supplier-open-contract-read.repository";

type Queryer = Pick<PoolClient, "query">;
export const CONTRACT_HOLD_SQL = `INSERT INTO public.ged_retention_holds(document_id,hold_type,reason,placed_by) VALUES($1::uuid,'LEGAL',$2,$3)`;
export const CONTRACT_DOCUMENT_HOLD_SQL = `INSERT INTO public.ged_retention_holds(document_id,hold_type,reason,placed_by) VALUES($1::uuid,'QUALITE',$2,$3)`;
function assertMatchingCall(
  order: OrderSnapshot,
  contract: ContractSnapshot,
  mappings: Array<{ line_id: string; contract_line_id: string }>,
): Array<{ line: OrderLine; item: ContractItem }> {
  const expectedHeader = {
    currency: contract.currency,
    incoterm: contract.incoterm,
    payment_terms: contract.payment_terms,
    transport_mode: contract.transport_mode,
  };
  const actualHeader = {
    currency: order.currency,
    incoterm: order.incoterm,
    payment_terms: order.payment_terms,
    transport_mode: order.transport_mode,
  };
  if (
    consultationSnapshotKey(expectedHeader) !==
    consultationSnapshotKey(actualHeader)
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_HEADER_MISMATCH",
      "La devise ou les conditions de ce brouillon diffèrent du contrat. Corrigez-les avant de rattacher l’appel.",
    );
  if (mappings.length !== order.lines.length || !order.lines.length)
    throw new HttpError(
      422,
      "OPEN_CONTRACT_LINE_MAPPING_REQUIRED",
      "Rattachez chaque ligne active à une ligne du contrat.",
    );
  return order.lines.map((line) => {
    const mapping = mappings.find((row) => row.line_id === line.id);
    const item = contract.items.find(
      (row) => row.key === mapping?.contract_line_id,
    );
    if (!item || line.unit_price_ht == null || !line.article_id)
      throw new HttpError(
        422,
        "OPEN_CONTRACT_LINE_INVALID",
        "Chaque ligne doit avoir un article, un prix et une correspondance contractuelle explicite.",
      );
    const {
      id: _id,
      quantity: _quantity,
      need_date: _date,
      designation: _designation,
      ...actual
    } = line;
    const { key: _key, limit: _limit, designation: _label, ...expected } = item;
    if (consultationSnapshotKey(actual) !== consultationSnapshotKey(expected))
      throw new HttpError(
        409,
        "OPEN_CONTRACT_LINE_MISMATCH",
        "L’article, l’unité, le prix ou les exigences de cette ligne diffèrent du contrat. Corrigez le brouillon avant l’appel.",
        { line_id: line.id },
      );
    return { line, item };
  });
}
async function retainProofTx(
  tx: Queryer,
  evidence: ContractEvidence,
  actor: number,
  reason: string,
) {
  await tx.query(CONTRACT_HOLD_SQL, [evidence.document_id, reason, actor]);
}
async function attachCallTx(
  tx: Queryer,
  orderId: string,
  contractId: string,
  revision: ContractRevision,
  mappings: Array<{ line_id: string; contract_line_id: string }>,
  actor: number,
  today: string,
  documentVersionIds: string[],
  role: string | null | undefined,
) {
  if (
    (
      await tx.query(
        "SELECT 1 FROM public.supplier_open_contract_calls WHERE order_id=$1::uuid",
        [orderId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_ALREADY_ATTACHED",
      "Cette commande est déjà un appel de contrat.",
    );
  if (
    (
      await tx.query(
        "SELECT 1 FROM public.commande_fournisseur_ligne WHERE commande_id=$1::uuid AND statut_ligne='ACTIVE' AND qty_annulee>0",
        [orderId],
      )
    ).rowCount
  )
    throw new HttpError(
      409,
      "OPEN_CONTRACT_CANCELLED_LINE",
      "Une ligne de ce brouillon est partiellement annulée. Créez un appel avec des lignes actives non annulées.",
    );
  const order = await readContractOrderSnapshotTx(tx, orderId);
  const matches = assertMatchingCall(order, revision.snapshot, mappings);
  assertContractWindow(
    revision.valid_from,
    revision.valid_to,
    today,
    order.lines.map((line) => line.need_date),
  );
  const usage = await readContractUsageTx(tx, contractId, revision);
  for (const item of revision.snapshot.items) {
    const additional = matches
      .filter((match) => match.item.key === item.key)
      .reduce((sum, match) => sum + match.line.quantity, 0);
    assertContractCapacity(
      item.limit,
      usage.find((row) => row.key === item.key)?.committed ?? 0,
      additional,
    );
  }
  const technicalSources = await readConsultationTechnicalSourcesTx(
    tx,
    orderId,
    true,
  );
  const callId = crypto.randomUUID();
  const documents = documentVersionIds.length
    ? await readConsultationDocuments(
        tx,
        orderId,
        { user_id: actor, role },
        documentVersionIds,
      )
    : [];
  await tx.query(
    `INSERT INTO public.supplier_open_contract_calls(id,contract_id,revision_id,order_id,technical_sources,documents,order_snapshot,created_by)
    VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::jsonb,$8::jsonb,$6::jsonb,$7)`,
    [
      callId,
      contractId,
      revision.id,
      orderId,
      JSON.stringify(technicalSources),
      JSON.stringify(order),
      actor,
      JSON.stringify(documents),
    ],
  );
  for (const document of documents)
    await tx.query(CONTRACT_DOCUMENT_HOLD_SQL, [
      document.document_id,
      `CONTRAT:${contractId}:APPEL:${callId}:VERSION:${document.version_id}`,
      actor,
    ]);
  for (const match of matches)
    await tx.query(
      `INSERT INTO public.supplier_open_contract_call_lines(call_id,line_id,contract_line_id,quantity) VALUES($1::uuid,$2::uuid,$3::uuid,$4)`,
      [callId, match.line.id, match.item.key, match.line.quantity],
    );
  await readSupplierContractTermsTx(tx, orderId, true);
  const terms = revision.snapshot.general_terms;
  const selection = await readTermsSelection(
    tx,
    "commande-fournisseur",
    orderId,
  );
  if (
    !selection ||
    consultationSnapshotKey(selection.snapshot) !==
      consultationSnapshotKey(terms)
  ) {
    await tx.query(
      `INSERT INTO public.commercial_general_terms_selections(entity_type,entity_id,revision,document_id,version_id,snapshot,reason,created_by,idempotency_key,request_hash)
      VALUES('commande-fournisseur',$1,$2,$3::uuid,$4::uuid,$5::jsonb,$6,$7,$8::uuid,$9)`,
      [
        orderId,
        (selection?.revision ?? 0) + 1,
        terms.document_id,
        terms.version_id,
        JSON.stringify(terms),
        `Conditions convenues du contrat ${contractId}, révision ${revision.revision}`,
        actor,
        crypto.randomUUID(),
        crypto
          .createHash("sha256")
          .update(consultationSnapshotKey({ callId, terms }))
          .digest("hex"),
      ],
    );
  }
  await retainProofTx(
    tx,
    terms,
    actor,
    `CONTRAT:${contractId}:APPEL:${callId}:CGA`,
  );
  return callId;
}
export async function repoCommandSupplierOpenContract(
  orderId: string,
  body: SupplierOpenContractCommand,
  audit: AuditContext,
) {
  const capability = body.action === "ATTACH" ? "update_draft" : "approve";
  if (
    !roleHasCommandeFournisseurCapability(audit.role, capability) ||
    !roleHasCommandeFournisseurCapability(audit.role, "prices")
  )
    throw new HttpError(
      403,
      "FORBIDDEN",
      "Votre rôle ne permet pas cette action sur les contrats fournisseurs.",
    );
  return withRealtimeOutboxTransaction(await db.connect(), async (tx) => {
    if (!(await supplierContractsInstalled(tx)))
      throw new HttpError(
        409,
        "OPEN_CONTRACT_DISABLED",
        "La gestion des contrats ouverts n’est pas encore disponible sur cette base.",
      );
    await tx.query(
      "SELECT revision FROM public.planning_central_settings WHERE singleton FOR UPDATE",
    );
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `supplier-contract:${body.idempotency_key}`,
    ]);
    const hash = crypto
      .createHash("sha256")
      .update(consultationSnapshotKey({ orderId, body, actor: audit.user_id }))
      .digest("hex");
    const replay = (
      await tx.query<{
        actor_id: number;
        request_hash: string;
        result: {
          contract_id: string;
          revision_id: string;
          call_id?: string;
          action: string;
        };
      }>(
        "SELECT actor_id,request_hash,result FROM public.supplier_open_contract_commands WHERE idempotency_key=$1::uuid",
        [body.idempotency_key],
      )
    ).rows[0];
    if (replay) {
      if (replay.actor_id !== audit.user_id || replay.request_hash !== hash)
        throw new HttpError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "Cette demande a déjà été utilisée avec un autre contenu.",
        );
      return replay.result;
    }
    let contractId: string;
    let current: ContractRevision | null = null;
    let contractSupplier: string | null = null;
    if (body.action !== "CREATE") {
      contractId = body.contract_id;
      const contract = (
        await tx.query<{ supplier_id: string; closed_at: string | null }>(
          "SELECT supplier_id::text,closed_at::text FROM public.supplier_open_contracts WHERE id=$1::uuid FOR UPDATE",
          [contractId],
        )
      ).rows[0];
      if (!contract)
        throw new HttpError(
          404,
          "OPEN_CONTRACT_NOT_FOUND",
          "Contrat fournisseur introuvable.",
        );
      contractSupplier = contract.supplier_id;
      if (contract.closed_at)
        throw new HttpError(
          409,
          "OPEN_CONTRACT_CLOSED",
          "Ce contrat est clôturé. Son historique reste disponible.",
        );
      current = await readContractRevisionTx(tx, contractId);
      if (current?.id !== body.expected_revision_id)
        throw new HttpError(
          409,
          "OPEN_CONTRACT_CHANGED",
          "Le contrat a changé. Actualisez avant de confirmer.",
        );
    } else contractId = crypto.randomUUID();
    const header = await lockHeader(tx, orderId);
    assertOptimisticToken(body.expected_updated_at, header.updated_at_token);
    if (contractSupplier && contractSupplier !== header.fournisseur_id)
      throw new HttpError(
        404,
        "OPEN_CONTRACT_NOT_FOUND",
        "Contrat fournisseur introuvable.",
      );
    const today = (
      await tx.query<{ today: string }>("SELECT CURRENT_DATE::text AS today")
    ).rows[0].today;
    let revisionId = current?.id ?? "";
    let callId: string | undefined;
    if (body.action === "CREATE" || body.action === "AMEND") {
      if (body.action === "CREATE") assertDraft(header.statut);
      const order = await readContractOrderSnapshotTx(tx, orderId);
      const items: ContractItem[] =
        body.action === "CREATE"
          ? order.lines.map((line) => {
              const envelope = body.envelopes.find(
                (row) => row.line_id === line.id,
              );
              if (
                !envelope ||
                !line.article_id ||
                !line.unit ||
                line.unit_price_ht == null ||
                line.quantity <= 0
              )
                throw new HttpError(
                  422,
                  "OPEN_CONTRACT_LINE_INVALID",
                  "Complétez article, unité, prix et enveloppe pour chaque ligne active.",
                );
              const { id, quantity: _q, need_date: _d, ...terms } = line;
              return {
                ...terms,
                key: id,
                limit: envelope.limit,
                unit_price_ht: envelope.unit_price_ht,
              };
            })
          : current!.snapshot.items.map((item) => {
              const envelope = body.envelopes.find(
                (row) => row.line_id === item.key,
              );
              if (!envelope)
                throw new HttpError(
                  422,
                  "OPEN_CONTRACT_ENVELOPE_MISSING",
                  "Conservez toutes les lignes du contrat dans l’avenant.",
                );
              return {
                ...item,
                limit: envelope.limit,
                unit_price_ht: envelope.unit_price_ht,
              };
            });
      if (!items.length || body.envelopes.length !== items.length)
        throw new HttpError(
          422,
          "OPEN_CONTRACT_ENVELOPE_INVALID",
          "Une enveloppe est requise par ligne du contrat.",
        );
      const evidence = (
        await tx.query<ContractEvidence>(
          CONTRACT_EVIDENCE_SQL + " FOR SHARE OF d,v,b",
          [header.fournisseur_id, body.evidence_version_id],
        )
      ).rows[0];
      if (!evidence)
        throw new HttpError(
          422,
          "OPEN_CONTRACT_EVIDENCE_REQUIRED",
          "Choisissez le contrat ou l’avenant signé, approuvé dans la GED du fournisseur.",
        );
      await assertGedVersionParentReadable(audit.user_id, evidence.document_id);
      const terms = body.general_terms_version_id
        ? await readTermsVersion(
            tx,
            "commande-fournisseur",
            body.general_terms_version_id,
            true,
          )
        : body.action === "CREATE"
          ? await freezeGeneralTerms(tx, "commande-fournisseur", orderId, true)
          : current!.snapshot.general_terms;
      if (!terms)
        throw new HttpError(
          422,
          "OPEN_CONTRACT_TERMS_REQUIRED",
          "Sélectionnez les CGA approuvées avant l’enregistrement du contrat.",
        );
      if (body.general_terms_version_id)
        await assertGedVersionParentReadable(audit.user_id, terms.document_id);
      if (
        body.action === "AMEND" &&
        evidence.version_id === current!.evidence.version_id
      )
        throw new HttpError(
          422,
          "OPEN_CONTRACT_AMENDMENT_EVIDENCE_REQUIRED",
          "Publiez une nouvelle version approuvée de l’avenant signé. Le justificatif précédent ne prouve pas la modification.",
        );
      const snapshot: ContractSnapshot =
        body.action === "CREATE"
          ? {
              currency: order.currency,
              incoterm: order.incoterm,
              payment_terms: order.payment_terms,
              transport_mode: order.transport_mode,
              general_terms: terms,
              items,
            }
          : { ...current!.snapshot, items };
      if (body.action === "AMEND") {
        const usage = await readContractUsageTx(tx, contractId, current!);
        for (const item of items)
          assertContractCapacity(
            item.limit,
            usage.find((row) => row.key === item.key)?.committed ?? 0,
            0,
          );
      } else
        await tx.query(
          "INSERT INTO public.supplier_open_contracts(id,supplier_id,reference,created_by) VALUES($1::uuid,$2::uuid,$3,$4)",
          [contractId, header.fournisseur_id, body.reference, audit.user_id],
        );
      const nextRevision = (current?.revision ?? 0) + 1;
      revisionId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO public.supplier_open_contract_revisions(id,contract_id,revision,valid_from,valid_to,snapshot,evidence_version_id,evidence_snapshot,reason,created_by)
        VALUES($1::uuid,$2::uuid,$3,$4::date,$5::date,$6::jsonb,$7::uuid,$8::jsonb,$9,$10)`,
        [
          revisionId,
          contractId,
          nextRevision,
          body.valid_from,
          body.valid_to,
          JSON.stringify(snapshot),
          evidence.version_id,
          JSON.stringify(evidence),
          body.reason,
          audit.user_id,
        ],
      );
      await retainProofTx(
        tx,
        evidence,
        audit.user_id,
        `CONTRAT:${contractId}:REVISION:${nextRevision}`,
      );
      await retainProofTx(
        tx,
        terms,
        audit.user_id,
        `CONTRAT:${contractId}:REVISION:${nextRevision}:CGA`,
      );
      if (body.action === "CREATE")
        callId = await attachCallTx(
          tx,
          orderId,
          contractId,
          {
            id: revisionId,
            revision: nextRevision,
            valid_from: body.valid_from,
            valid_to: body.valid_to,
            snapshot,
            evidence,
            reason: body.reason,
            created_at: "",
          },
          items.map((item) => ({
            line_id: item.key,
            contract_line_id: item.key,
          })),
          audit.user_id,
          today,
          body.document_version_ids ?? [],
          audit.role,
        );
    } else if (body.action === "ATTACH") {
      assertDraft(header.statut);
      callId = await attachCallTx(
        tx,
        orderId,
        contractId,
        current!,
        body.mappings,
        audit.user_id,
        today,
        body.document_version_ids ?? [],
        audit.role,
      );
    } else
      await tx.query(
        "UPDATE public.supplier_open_contracts SET closed_at=now(),closed_by=$2,close_reason=$3 WHERE id=$1::uuid",
        [contractId, audit.user_id, body.reason],
      );
    const result = {
      contract_id: contractId,
      revision_id: revisionId,
      call_id: callId,
      action: body.action,
    };
    await tx.query(
      "INSERT INTO public.supplier_open_contract_commands(idempotency_key,actor_id,request_hash,result) VALUES($1::uuid,$2,$3,$4::jsonb)",
      [body.idempotency_key, audit.user_id, hash, JSON.stringify(result)],
    );
    await insertAuditLog(tx, audit, {
      action: `commandes_fournisseurs.contract.${body.action.toLowerCase()}`,
      entity_type: "commande_fournisseur",
      entity_id: orderId,
      details: { ...result, reason: body.reason },
    });
    await tx.query(
      "UPDATE public.commande_fournisseur SET updated_at=clock_timestamp(),updated_by=$2 WHERE id=$1::uuid",
      [orderId, audit.user_id],
    );
    await enqueueEntityChanged(
      tx,
      {
        entityType: "COMMANDE_FOURNISSEUR",
        entityId: orderId,
        module: "commandes-fournisseurs",
        action: "updated",
        at: new Date().toISOString(),
        invalidateKeys: [`achats:detail:${orderId}`],
      },
      {
        deduplicationKey: `supplier-contract:${audit.user_id}:${body.idempotency_key}`,
      },
    );
    return result;
  });
}
