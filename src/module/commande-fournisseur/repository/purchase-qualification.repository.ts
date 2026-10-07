import type { PoolClient } from "pg";
import db from "../../../config/database";
import { HttpError } from "../../../utils/httpError";
import { lockSupplierQualificationTx } from "../../fournisseurs/repository/purchase-homologation.repository";
import { readPurchaseClientContextsTx } from "./purchase-client-context.repository";
import { readApprovalPoliciesTx } from "../../fournisseurs/repository/client-supplier-approval.repository";
import {
  assertClientApprovals,
  evaluateClientApproval,
  type PurchaseClientContext,
} from "../../fournisseurs/domain/client-supplier-approval";
import {
  assertPurchaseQualification,
  purchaseLineDomains,
  qualificationScope,
  type PurchaseQualification,
  type PurchaseScopeLine,
  type QualificationDecision,
} from "../../fournisseurs/domain/purchase-qualification";

type Queryer = Pick<PoolClient, "query">;

export async function readPurchaseQualificationTx(
  tx: Queryer,
  orderId: string,
  enforce = false,
): Promise<PurchaseQualification> {
  const header = (
    await tx.query<{
      fournisseur_id: string;
      today: string;
      checked_at: string;
    }>(
      `
    SELECT fournisseur_id::text, (statement_timestamp() AT TIME ZONE 'Europe/Paris')::date::text AS today,
           statement_timestamp()::text AS checked_at
    FROM public.commande_fournisseur WHERE id=$1::uuid`,
      [orderId],
    )
  ).rows[0];
  if (!header)
    throw new HttpError(
      404,
      "COMMANDE_FOURNISSEUR_NOT_FOUND",
      "Commande fournisseur introuvable.",
    );
  const contexts = await readPurchaseClientContextsTx(tx, orderId);
  const clientIds = [
    ...new Set(contexts.map((context) => context.client_id)),
  ].sort();
  // Policy writers lock clients before suppliers. Keep the same order here.
  if (enforce && clientIds.length)
    await tx.query(
      "SELECT client_id FROM public.clients WHERE client_id=ANY($1::text[]) ORDER BY client_id FOR SHARE",
      [clientIds],
    );
  if (
    enforce &&
    !(await lockSupplierQualificationTx(tx, header.fournisseur_id))
  ) {
    throw new HttpError(
      404,
      "FOURNISSEUR_NOT_FOUND",
      "Fournisseur introuvable.",
    );
  }
  const lines = (
    await tx.query<PurchaseScopeLine>(
      `
    SELECT l.id::text,l.position::int,l.type,c.type AS catalogue_type,
      ARRAY(SELECT ac.category_code FROM public.article_category_link ac
            WHERE ac.article_id=COALESCE(l.article_id,c.article_id) ORDER BY ac.category_code) AS categories
    FROM public.commande_fournisseur_ligne l LEFT JOIN public.fournisseur_catalogue c ON c.id=l.catalogue_id
    WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' ORDER BY l.position,l.id`,
      [orderId],
    )
  ).rows;
  return readSupplierPurchaseQualificationTx(tx, {
    supplierId: header.fournisseur_id,
    today: header.today,
    checkedAt: header.checked_at,
    lines,
    contexts,
    enforce,
  });
}

/** One evaluator for an order and a prospective OF purchase. The order reader
 * retains the client-before-supplier lock order before an actual engagement. */
export async function readSupplierPurchaseQualificationTx(
  tx: Queryer,
  input: {
    supplierId: string;
    today: string;
    checkedAt: string;
    lines: PurchaseScopeLine[];
    contexts: Omit<PurchaseClientContext, "domains">[];
    enforce?: boolean;
  },
): Promise<PurchaseQualification> {
  const { lines, contexts, enforce = false } = input;
  const clientIds = [...new Set(contexts.map(context => context.client_id))].sort();
  const domainLines = new Map<string, string[]>();
  const unmapped: string[] = [];
  for (const line of lines) {
    const domains = purchaseLineDomains(line);
    if (!domains.length) unmapped.push(line.id);
    for (const domain of domains)
      domainLines.set(domain, [...(domainLines.get(domain) ?? []), line.id]);
  }
  const decisions = (
    await tx.query<QualificationDecision>(
      `
    SELECT id::text,version,statut,domaine_code,valid_from::text,valid_to::text,document_id::text,
           reference,organisme,perimetre,updated_at::text
    FROM public.fournisseur_homologations WHERE fournisseur_id=$1::uuid AND is_current
      AND (domaine_code IS NULL OR domaine_code=ANY($2::text[])) ORDER BY domaine_code NULLS FIRST
    ${enforce ? "FOR SHARE" : ""}`,
      [input.supplierId, [...domainLines.keys()]],
    )
  ).rows;
  const global = qualificationScope(
    null,
    lines.map((line) => line.id),
    decisions.find((row) => row.domaine_code === null) ?? null,
    input.today,
  );
  const domains = [...domainLines.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([domain, ids]) =>
      qualificationScope(
        domain,
        ids,
        decisions.find((row) => row.domaine_code === domain) ?? null,
        input.today,
      ),
    );
  const policies = await readApprovalPoliciesTx(tx, clientIds, enforce);
  const lineDomains = new Map(
    lines.map((line) => [line.id, purchaseLineDomains(line)]),
  );
  const clientApprovals = contexts.flatMap((context) =>
    (lineDomains.get(context.line_id) ?? []).map((domain) =>
      evaluateClientApproval(
        { ...context, domains: lineDomains.get(context.line_id) ?? [] },
        domain,
        input.supplierId,
        policies,
        input.today,
      ),
    ),
  );
  const state: PurchaseQualification = {
    supplier_id: input.supplierId,
    checked_at: input.checkedAt,
    today: input.today,
    global,
    domains,
    unmapped_line_ids: unmapped,
    client_approvals: clientApprovals,
    lines_without_client: lines
      .filter(
        (line) => !contexts.some((context) => context.line_id === line.id),
      )
      .map((line) => line.id),
    can_engage:
      ![global, ...domains].some((scope) => scope.status === "BLOCKED") &&
      !clientApprovals.some((check) => check.status === "BLOCKED"),
  };
  if (enforce) {
    assertPurchaseQualification(state);
    assertClientApprovals(clientApprovals);
  }
  return state;
}

/** A read-only consistent diagnostic; mutations re-evaluate under supplier/aggregate locks. */
export async function repoReadPurchaseQualification(
  orderId: string,
): Promise<PurchaseQualification> {
  const client = await db.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const state = await readPurchaseQualificationTx(client, orderId);
    await client.query("COMMIT");
    return state;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
