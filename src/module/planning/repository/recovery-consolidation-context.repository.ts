import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import type { RecoveryGroupingOf, RecoveryGroupingIssue } from '../domain/recovery-consolidation-preview';

type Db=Pick<PoolClient,'query'>;
type Context={recovery_id:string;request_id:string;request_status:string;request_version:number;recovery_of_id:number;
  quantity:number;donor_allocation_id:number;protected_before:string;initial_before:string;grouping_id:string;producer_of_id:number;grouping_state:string;enabled:boolean;
  donor_snapshot:{commande_id:number;commande_ligne_id:number;livraison_affaire_id:number;piece_technique_id:string;technical_version_id:string};};
export type RecoveryGroupingDefinition=Omit<RecoveryGroupingOf,'ready'|'operationIds'>&{
  commande_id:number|null;commande_ligne_id:number|null;affaire_id:number|null;root_of_id:number;
  covered:boolean;producer:boolean;updated_at:string;
};

export async function readRecoveryConsolidationContextTx(tx:Db,recoveryId:string,groupingId:string){
  const context=(await tx.query<Context>(`SELECT recovery.id::text AS recovery_id,recovery.request_id::text,request.status AS request_status,
    request.version AS request_version,recovery.recovery_of_id::int,recovery.quantity::float8,recovery.donor_allocation_id::int,recovery.donor_snapshot,
    (recovery.protected_due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS protected_before,
    (recovery.initial_ar_due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS initial_before,
    grouping.id::text AS grouping_id,grouping.producer_of_id::int,grouping.state AS grouping_state,
    COALESCE((SELECT enabled FROM public.app_feature_flags WHERE key='PRODUCTION_CONSOLIDATION'),false) AS enabled
    FROM public.delivery_urgency_recoveries recovery JOIN public.delivery_urgency_requests request ON request.id=recovery.request_id
    CROSS JOIN public.production_consolidations grouping WHERE recovery.id=$1::uuid AND grouping.id=$2::uuid`,[recoveryId,groupingId])).rows[0];
  if(!context)throw new HttpError(404,'RECOVERY_GROUPING_NOT_FOUND','Récupération ou regroupement introuvable.');
  if(!context.enabled)throw new HttpError(409,'CONSOLIDATION_DISABLED','Le regroupement de production n’est pas encore activé.');
  const definitions=(await tx.query<RecoveryGroupingDefinition>(`SELECT o.id::int,o.numero AS number,o.client_id::text AS "clientId",
    o.article_id::text AS "articleId",o.piece_technique_id::text AS "pieceId",o.piece_technique_version_id::text AS "versionId",
    o.technical_snapshot_sha256 AS "technicalHash",o.quantite_lancee::float8 AS quantity,o.statut::text AS status,
    o.commande_id::int,o.commande_ligne_id::int,o.affaire_id::int,COALESCE(o.root_of_id,o.id)::int AS root_of_id,o.updated_at::text,
    EXISTS(SELECT 1 FROM public.production_consolidation_allocations a WHERE a.source_of_id=o.id AND a.state='ACTIVE') AS covered,
    EXISTS(SELECT 1 FROM public.production_consolidations c WHERE c.producer_of_id=o.id) AS producer
    FROM public.ordres_fabrication o WHERE o.id=ANY($1::bigint[]) ORDER BY o.id`,[[context.recovery_of_id,context.producer_of_id]])).rows;
  const recovery=definitions.find(o=>o.id===context.recovery_of_id),producer=definitions.find(o=>o.id===context.producer_of_id);
  if(!recovery||!producer)throw new HttpError(409,'RECOVERY_GROUPING_OF_MISSING','Un OF de cette proposition est introuvable.');
  const sources=(await tx.query<{id:number;number:string;client_id:string|null;quantity:number;received:number;before:string|null;current_before:string|null;initial_before:string|null;active:boolean;requires_promise:boolean}>(`
    SELECT source.id::int,source.numero AS number,source.client_id::text,part.quantity::float8,part.received_quantity::float8 AS received,
      (part.due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS before,
      (promise.due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS current_before,
      (promise.initial_due_date::timestamp AT TIME ZONE 'Europe/Paris')::text AS initial_before,
      (source.statut::text<>'ANNULE' AND COALESCE(affair.statut::text,'') NOT IN('ANNULE','ANNULEE','CANCELLED')
        AND COALESCE((SELECT history.nouveau_statut::text FROM public.commande_historique history
          WHERE history.commande_id=source.commande_id ORDER BY history.date_action DESC,history.id DESC LIMIT 1),'BROUILLON')
          NOT IN('ANNULE','ANNULEE','CANCELLED')) AS active,
      COALESCE(command.order_type<>'INTERNE',true) AS requires_promise
    FROM public.production_consolidation_allocations part JOIN public.ordres_fabrication source ON source.id=part.source_of_id
    LEFT JOIN public.commande_client command ON command.id=source.commande_id
    LEFT JOIN public.affaire affair ON affair.id=source.affaire_id
    LEFT JOIN LATERAL(SELECT min(active.due_date) AS due_date,min(root.initial_due_date) AS initial_due_date FROM public.commande_ligne_affaire_allocation allocation
      JOIN public.delivery_promise_roots root ON root.allocation_id=allocation.id
      JOIN public.delivery_promise_parts active ON active.root_id=root.id AND active.retired_at IS NULL
      WHERE allocation.commande_ligne_id=source.commande_ligne_id AND allocation.livraison_affaire_id=source.affaire_id
        AND active.quantity>COALESCE((SELECT sum(shipped.quantity) FROM public.delivery_promise_shipments shipped WHERE shipped.part_id=active.id),0)) promise ON true
    WHERE part.consolidation_id=$1::uuid AND part.state='ACTIVE' ORDER BY source.id`,[groupingId])).rows;
  const donor=(await tx.query<{before:string|null;commande_id:number;commande_ligne_id:number;affaire_id:number;client_id:string;article_id:string;piece_id:string;version_id:string;active:boolean}>(`
    SELECT allocation.commande_id::int,allocation.commande_ligne_id::int,allocation.livraison_affaire_id::int AS affaire_id,
      command.client_id::text,line.article_id::text,technical.piece_technique_id::text AS piece_id,technical.id::text AS version_id,
      (affair.statut::text NOT IN('ANNULE','ANNULEE','CANCELLED') AND command.order_type<>'INTERNE'
        AND COALESCE((SELECT history.nouveau_statut::text FROM public.commande_historique history
          WHERE history.commande_id=command.id ORDER BY history.date_action DESC,history.id DESC LIMIT 1),'BROUILLON')
          NOT IN('ANNULE','ANNULEE','CANCELLED')) AS active,
      ((SELECT min(part.due_date) FROM public.delivery_promise_roots root JOIN public.delivery_promise_parts part ON part.root_id=root.id
        WHERE root.allocation_id=allocation.id AND part.retired_at IS NULL
        AND part.quantity>COALESCE((SELECT sum(shipped.quantity) FROM public.delivery_promise_shipments shipped WHERE shipped.part_id=part.id),0))
        ::timestamp AT TIME ZONE 'Europe/Paris')::text AS before
    FROM public.commande_ligne_affaire_allocation allocation JOIN public.commande_client command ON command.id=allocation.commande_id
    JOIN public.commande_ligne line ON line.id=allocation.commande_ligne_id AND line.commande_id=command.id
    JOIN public.affaire affair ON affair.id=allocation.livraison_affaire_id
    JOIN public.piece_technique_versions technical ON technical.id=line.piece_technique_version_id
    WHERE allocation.id=$1`,[context.donor_allocation_id])).rows[0];
  const original=context.donor_snapshot;
  const originalIdentityMatches=!!donor?.active&&recovery.commande_id===original.commande_id&&recovery.commande_ligne_id===original.commande_ligne_id
    &&recovery.affaire_id===original.livraison_affaire_id&&recovery.pieceId===original.piece_technique_id&&recovery.versionId===original.technical_version_id
    &&recovery.root_of_id===recovery.id&&recovery.quantity===context.quantity&&!recovery.producer
    &&donor.commande_id===recovery.commande_id&&donor.commande_ligne_id===recovery.commande_ligne_id&&donor.affaire_id===recovery.affaire_id
    &&donor.client_id===recovery.clientId&&donor.article_id===recovery.articleId&&donor.piece_id===recovery.pieceId&&donor.version_id===recovery.versionId;
  const issues:RecoveryGroupingIssue[]=sources.filter(s=>!s.active).map(s=>({code:'GROUPING_SOURCE_CANCELLED',of_id:s.id,
    message:`${s.number} : réconciliez la commande ou l’affaire annulée avant cet ajout.`}));
  const deadlines=[{of_id:recovery.id,label:'Affaire donneuse — AR initial',before:context.initial_before},
    {of_id:recovery.id,label:'Affaire donneuse — engagement protégé',before:context.protected_before},
    {of_id:recovery.id,label:'Affaire donneuse — délai courant',before:donor?.before??null},
    ...sources.filter(s=>s.quantity>s.received).map(s=>({of_id:s.id,label:s.number,before:
      s.requires_promise&&!s.current_before?null:[s.before,s.current_before,s.initial_before].filter((v):v is string=>!!v).sort((a,b)=>Date.parse(a)-Date.parse(b))[0]??null}))];
  return {context,recovery,producer,sources,deadlines,issues,originalIdentityMatches,
    sameClientSources:sources.length>0&&sources.every(s=>s.client_id===recovery.clientId)};
}
