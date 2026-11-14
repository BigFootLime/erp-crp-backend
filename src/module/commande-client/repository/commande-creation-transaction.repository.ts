import type { PoolClient } from "pg";
import { HttpError } from "../../../utils/httpError";
import type { AppNotification } from "../../notifications/types/notifications.types";
import type { AuditContext as PurchaseAuditContext } from "../../commande-fournisseur/repository/commande-fournisseur.repository";
import type { CreateCommandeInput, UploadedDocument } from "../types/commande-client.types";
import type { CommandeWorkflowStatus } from "../workflow/commande-client-workflow.definition";

type EventParams = { commande_id: number; event_type: string; old_values?: unknown | null; new_values?: unknown | null; user_id?: number | null };
type WorkflowNotificationParams = { commande: { id: number; numero: string; client_id: string | null; order_type: string | null; fulfilment_mode?: string | null; statut: CommandeWorkflowStatus; raw_statut: string | null }; role: string; kind: string; title: string; message: string; severity?: "info" | "success" | "warning" | "error"; checkpoint_code: string | null; dedupe_key: string };
type InsertLinesOptions = { officialize_preparatory_data: boolean; commande_id_int: number; actor_user_id: number | null; creation_flow_version: 1 | 2; save_intent: "DRAFT" | "VALIDATE"; fulfilment_mode?: string; existing_line_ids?: ReadonlySet<number>; skip_sale_price_reference?: boolean };
type DropshipPurchaseOrderParams = { buyerCompanyId: string; buyerSalesOrderId: number; mappingIds: string[]; audit: PurchaseAuditContext };

export type CommandeCreationRepositoryDependencies<ContractCall, DocumentMove> = {
  prepareContractCall: (client: PoolClient, input: CreateCommandeInput, actorUserId: number | null, documents: UploadedDocument[]) => Promise<ContractCall>;
  assertDevisDraftIsFresh: (client: PoolClient, devisId: number | null | undefined, expectedUpdatedAt: string | null | undefined) => Promise<unknown>;
  toInt: (value: string | number, label?: string) => number;
  generateCommandeCode: (client: PoolClient, options: { client_code: string; date?: Date }) => Promise<string>;
  resolveIntercompanyDeliveryAddress: (client: PoolClient, input: CreateCommandeInput) => Promise<unknown>;
  repoCreateDropshipPurchaseOrderTx: (client: PoolClient, params: DropshipPurchaseOrderParams) => Promise<unknown>;
  insertCommandeLignes: (client: PoolClient, commandeId: string, lignes: CreateCommandeInput["lignes"], options: InsertLinesOptions) => Promise<unknown>;
  recordContractCall: (client: PoolClient, contractCall: ContractCall, commandeId: string, input: CreateCommandeInput) => Promise<unknown>;
  insertCommandeEcheances: (client: PoolClient, commandeId: string, echeances: NonNullable<CreateCommandeInput["echeances"]>) => Promise<unknown>;
  insertCommandeDocuments: (client: PoolClient, commandeId: string, documents: UploadedDocument[], movedDocuments: DocumentMove[]) => Promise<unknown>;
  transitionLinkedDevisArticlesToValide: (client: PoolClient, commandeId: number, devisId: number | null | undefined) => Promise<unknown>;
  repoEnsureCommandeWorkflowCheckpoints: (client: PoolClient, commandeId: number, status: CommandeWorkflowStatus) => Promise<unknown>;
  insertCommandeEvent: (client: PoolClient, params: EventParams) => Promise<unknown>;
  notifyWorkflowRole: (client: PoolClient, params: WorkflowNotificationParams) => Promise<AppNotification[]>;
  enqueueAppNotificationCreated: (client: PoolClient, userId: number, notification: AppNotification, options: { deduplicationKey: string }) => Promise<unknown>;
  queueCommandeCreationPdf: (client: PoolClient, params: { commandeId: string; actorUserId: number | null }) => Promise<void>;
};

/** Owns the two transaction-scoped customer-order creation sequences. */
export function createCommandeCreationRepository<ContractCall, DocumentMove>(dependencies: CommandeCreationRepositoryDependencies<ContractCall, DocumentMove>) {
  const {
    prepareContractCall,
    assertDevisDraftIsFresh,
    toInt,
    generateCommandeCode,
    resolveIntercompanyDeliveryAddress,
    repoCreateDropshipPurchaseOrderTx,
    insertCommandeLignes,
    recordContractCall,
    insertCommandeEcheances,
    insertCommandeDocuments,
    transitionLinkedDevisArticlesToValide,
    repoEnsureCommandeWorkflowCheckpoints,
    insertCommandeEvent,
    notifyWorkflowRole,
    enqueueAppNotificationCreated,
    queueCommandeCreationPdf,
  } = dependencies;

  async function repoCreateCommandeDraftTx(
    client: PoolClient,
    input: CreateCommandeInput,
    actorUserId: number,
    origin: "cutover" | "client_demand" = "cutover",
  ): Promise<{ id: number; numero: string }> {
    const contractCall = await prepareContractCall(client, input, actorUserId, []);
    await assertDevisDraftIsFresh(client, input.devis_id ?? null, input.source_devis_updated_at ?? null);
    const idRes = await client.query<{ id: string }>("SELECT nextval('public.commande_client_id_seq')::bigint::text AS id");
    const rawId = idRes.rows[0]?.id;
    if (!rawId) throw new Error("Failed to allocate commande id");
    const commandeIdInt = toInt(rawId, "commande_client.id");
    const numero = await generateCommandeCode(client, { client_code: input.code_client ?? input.client_id ?? "CMD", date: input.date_commande ? new Date(input.date_commande) : undefined });
    const orderType = input.order_type ?? "FERME";
    const initialWorkflowStatus: CommandeWorkflowStatus = origin === "client_demand" ? "BROUILLON" : "ATTENTE_TECHNIQUE";
    const inserted = await client.query<{ id: string }>(`
      INSERT INTO commande_client (id,numero,client_id,contact_id,destinataire_id,adresse_facturation_id,emetteur,code_client,date_commande,arc_edi,arc_date_envoi,compteur_affaire_id,type_affaire,order_type,cadre_start_date,cadre_end_date,dest_stock_magasin_id,dest_stock_emplacement_id,mode_port_id,mode_reglement_id,conditions_paiement_id,biller_id,compte_vente_id,commentaire,remise_globale,total_ht,total_ttc,devis_id,source_devis_version_id,creation_flow_version,delivery_prepayment_requirement)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING id::text AS id`, [
        commandeIdInt, numero, input.client_id ?? null, input.contact_id ?? null, input.destinataire_id ?? null, input.adresse_facturation_id ?? null, input.emetteur ?? null, input.code_client ?? null, input.date_commande, input.arc_edi ?? false, input.arc_date_envoi ?? null, input.compteur_affaire_id ?? null, "livraison", orderType, input.cadre_start_date ?? null, input.cadre_end_date ?? null, input.dest_stock_magasin_id ?? null, input.dest_stock_emplacement_id ?? null, input.mode_port_id ?? null, input.mode_reglement_id ?? null, input.conditions_paiement_id ?? null, input.biller_id ?? null, input.compte_vente_id ?? null, input.commentaire ?? null, input.remise_globale ?? 0, input.total_ht ?? 0, input.total_ttc ?? 0, input.devis_id ?? null, input.source_devis_version_id ?? input.devis_id ?? null, input.creation_flow_version ?? 1, orderType === "INTERNE" ? "NOT_REQUIRED" : input.delivery_prepayment_requirement ?? "NOT_REQUIRED",
      ]);
    const commandeId = inserted.rows[0]?.id;
    if (!commandeId) throw new Error("Failed to create commande");
    await insertCommandeLignes(client, commandeId, input.lignes, { officialize_preparatory_data: input.officialize_preparatory_data ?? false, commande_id_int: commandeIdInt, actor_user_id: actorUserId, creation_flow_version: input.creation_flow_version ?? 1, save_intent: "DRAFT", skip_sale_price_reference: orderType === "INTERNE" });
    await recordContractCall(client, contractCall, commandeId, input);
    await insertCommandeEcheances(client, commandeId, input.echeances ?? []);
    await transitionLinkedDevisArticlesToValide(client, commandeIdInt, input.devis_id ?? null);
    await repoEnsureCommandeWorkflowCheckpoints(client, commandeIdInt, initialWorkflowStatus);
    await client.query("INSERT INTO commande_historique (commande_id,user_id,ancien_statut,nouveau_statut,commentaire) VALUES ($1,$2,$3,$4,$5)", [commandeIdInt, actorUserId, null, initialWorkflowStatus, origin === "client_demand" ? "Brouillon issu du programme client, à vérifier par l’ADV" : "Commande de reprise creee - brouillon a verifier"]);
    await insertCommandeEvent(client, { commande_id: commandeIdInt, event_type: "WORKFLOW_INITIALIZED", old_values: { statut: null }, new_values: { statut: initialWorkflowStatus, active_checkpoint: origin === "client_demand" ? "order_intake" : "technical_analysis", cutover_draft: origin === "cutover" }, user_id: actorUserId });
    return { id: commandeIdInt, numero };
  }

  async function repoCreateCommandeNativeTx(
    client: PoolClient,
    input: CreateCommandeInput,
    actorUserId: number | null,
    documents: UploadedDocument[] = [],
    movedDocuments: DocumentMove[] = [],
  ): Promise<{ id: number; numero: string }> {
    let notifications: AppNotification[] = [];
      const contractCall=await prepareContractCall(client,input,actorUserId,documents);
  
      await assertDevisDraftIsFresh(client, input.devis_id ?? null, input.source_devis_updated_at ?? null);
  
      const idRes = await client.query<{ id: string }>(
        `SELECT nextval('public.commande_client_id_seq')::bigint::text AS id`
      );
      const rawId = idRes.rows[0]?.id;
      if (!rawId) throw new Error("Failed to allocate commande id");
      const commandeIdInt = toInt(rawId, "commande_client.id");
  
      // The business number is allocated in this transaction.  A client-provided
      // value is intentionally ignored: it must never become a relational key.
      const numeroForInsert = await generateCommandeCode(client, {
        client_code: input.code_client ?? input.client_id ?? "CMD",
        date: input.date_commande ? new Date(input.date_commande) : undefined,
      });
  
      const orderType = input.order_type ?? "FERME";
  
      // A commercial company may submit its normal customer-order form without a
      // special dropship address field. Resolve that customer's persisted delivery
      // address while this transaction owns the creation, then persist the exact
      // structured snapshot before the supplier PO/outbox is created.
      const resolvedIntercompanyDeliveryAddress = input.fulfilment_mode === "SUPPLIER_DROPSHIP"
        ? await resolveIntercompanyDeliveryAddress(client, input)
        : input.intercompany_delivery_address ?? null;
  
      const initialWorkflowStatus: CommandeWorkflowStatus = input.fulfilment_mode === "SUPPLIER_DROPSHIP" ? "ATTENTE_FOURNISSEUR" : orderType === "INTERNE" ? "ATTENTE_OF" : "ATTENTE_STOCK";
      const insertSql = `
        INSERT INTO commande_client (
          id,
          numero,
          client_id,
          contact_id,
          destinataire_id,
          adresse_facturation_id,
          emetteur,
          code_client,
          date_commande,
          arc_edi,
          arc_date_envoi,
          compteur_affaire_id,
          type_affaire,
          order_type,
          cadre_start_date,
          cadre_end_date,
          dest_stock_magasin_id,
          dest_stock_emplacement_id,
          mode_port_id,
          mode_reglement_id,
          conditions_paiement_id,
          biller_id,
          compte_vente_id,
          commentaire,
          remise_globale,
          total_ht,
          total_ttc,
          devis_id,
          source_devis_version_id,
          creation_flow_version,
          delivery_prepayment_requirement,
          fulfilment_mode,
          intercompany_delivery_address
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb
        )
        RETURNING id::text AS id
      `;
      const insertParams = [
        commandeIdInt,
        numeroForInsert,
        input.client_id ?? null,
        input.contact_id ?? null,
        input.destinataire_id ?? null,
        input.adresse_facturation_id ?? null,
        input.emetteur ?? null,
        input.code_client ?? null,
        input.date_commande,
        input.arc_edi ?? false,
        input.arc_date_envoi ?? null,
        input.compteur_affaire_id ?? null,
        "livraison",
        orderType,
        input.cadre_start_date ?? null,
        input.cadre_end_date ?? null,
        input.dest_stock_magasin_id ?? null,
        input.dest_stock_emplacement_id ?? null,
        input.mode_port_id ?? null,
        input.mode_reglement_id ?? null,
        input.conditions_paiement_id ?? null,
        input.biller_id ?? null,
        input.compte_vente_id ?? null,
        input.commentaire ?? null,
        input.remise_globale ?? 0,
        input.total_ht ?? 0,
        input.total_ttc ?? 0,
        input.devis_id ?? null,
        input.source_devis_version_id ?? input.devis_id ?? null,
        input.creation_flow_version ?? 1,
        orderType === "INTERNE" ? "NOT_REQUIRED" : input.delivery_prepayment_requirement ?? "NOT_REQUIRED",
        input.fulfilment_mode ?? "STANDARD",
        JSON.stringify(resolvedIntercompanyDeliveryAddress),
      ];
      const ins = await client.query<{ id: string }>(insertSql, insertParams);
      const commandeId = ins.rows[0]?.id;
      if (!commandeId) throw new Error("Failed to create commande");
  
      await insertCommandeLignes(client, commandeId, input.lignes, {
        officialize_preparatory_data: input.officialize_preparatory_data ?? false,
        commande_id_int: commandeIdInt,
        actor_user_id: actorUserId,
        creation_flow_version: input.creation_flow_version ?? 1,
        save_intent: input.save_intent ?? "VALIDATE",
        fulfilment_mode: input.fulfilment_mode,
      });
      if (input.fulfilment_mode === "SUPPLIER_DROPSHIP") {
        if (actorUserId == null) throw new HttpError(401, "UNAUTHORIZED", "Un acteur authentifié est requis pour une commande fournisseur directe.");
        const runtime = (await import("../../entreprises/runtime/company-runtime.config")).companyRuntimeConfiguration();
        if (!runtime.enabled) throw new HttpError(409, "INTERCOMPANY_RUNTIME_REQUIRED", "Le flux fournisseur direct exige une instance entreprise configurée.");
        await repoCreateDropshipPurchaseOrderTx(client, {
          buyerCompanyId: runtime.company_id,
          buyerSalesOrderId: commandeIdInt,
          mappingIds: input.lignes.map(line => line.intercompany_catalogue_mapping_id!).filter(Boolean),
          audit: { user_id: actorUserId, role: null, ip: null, user_agent: null, device_type: null, os: null, browser: null, path: null, page_key: "commandes", client_session_id: null },
        });
      }
      await recordContractCall(client,contractCall,commandeId,input);
      await insertCommandeEcheances(client, commandeId, input.echeances ?? []);
      await insertCommandeDocuments(client, commandeId, documents, movedDocuments);
      await transitionLinkedDevisArticlesToValide(client, commandeIdInt, input.devis_id ?? null);
      if (input.fulfilment_mode !== "SUPPLIER_DROPSHIP") await repoEnsureCommandeWorkflowCheckpoints(client, commandeIdInt, initialWorkflowStatus);
  
      await client.query(
        `
          INSERT INTO commande_historique (commande_id, user_id, ancien_statut, nouveau_statut, commentaire)
          VALUES ($1, $2, $3, $4, $5)
        `,
        [commandeIdInt, null, null, initialWorkflowStatus, input.fulfilment_mode === "SUPPLIER_DROPSHIP" ? "Commande créée — attente preuve d'expédition fournisseur" : "Commande créée — contrôle stock et lancement à préparer"]
      );
  
      await insertCommandeEvent(client, {
        commande_id: commandeIdInt,
        event_type: "WORKFLOW_INITIALIZED",
        old_values: { statut: null },
        new_values: {
          statut: initialWorkflowStatus,
          active_checkpoint: input.fulfilment_mode === "SUPPLIER_DROPSHIP" ? "supplier_shipment_sync" : orderType === "INTERNE" ? "of_generation" : "stock_check",
        },
        user_id: null,
      });
  
      if (input.fulfilment_mode !== "SUPPLIER_DROPSHIP") notifications = await notifyWorkflowRole(client, {
        commande: {
          id: commandeIdInt,
          numero: numeroForInsert,
          client_id: input.client_id ?? null,
          order_type: input.order_type ?? null,
          statut: initialWorkflowStatus,
          raw_statut: initialWorkflowStatus,
        },
        role: "technique",
        kind: "commande.workflow.created",
        title: `Commande ${numeroForInsert}: ${orderType === "INTERNE" ? "Lancement à préparer" : "Contrôle du stock"}`,
        message: "Commande créée — contrôles techniques à effectuer dans le dossier OF.",
        severity: "info",
        checkpoint_code: orderType === "INTERNE" ? "of_generation" : "stock_check",
        dedupe_key: `commande:${commandeIdInt}:checkpoint:launch-preparation:created`,
      });
  
      for (const notification of notifications) {
        await enqueueAppNotificationCreated(client, notification.user_id, notification, {
          deduplicationKey: `notification:${notification.id}`,
        });
      }
  
      // This is deliberately last in the business transaction: the snapshot contains
      // the persisted header and dependants, and a queue failure aborts the order
      // together with any uploaded files.  It is an internal creation record, not an
      // acknowledgement de réception (which has its own document kind and workflow).
      await queueCommandeCreationPdf(client, {
        commandeId,
        actorUserId: null,
      });
  
      return { id: toInt(commandeId, "commande.id"), numero: numeroForInsert };
  }

  return { repoCreateCommandeDraftTx, repoCreateCommandeNativeTx };
}

