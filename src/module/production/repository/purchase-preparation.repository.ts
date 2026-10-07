import type { PoolClient } from 'pg';
import { materialPropertiesFingerprint } from '../domain/of-material';
import type { PurchasePreparation, SavedPurchasePreparation } from '../domain/purchase-preparation';
import type { AuditContext } from './production.repository';

type Db = Pick<PoolClient, 'query'>;
type Row = { id: string; scope_key: string; snapshot: PurchasePreparation; content_hash: string; status: string; updated_at: string; of_id?:string|null };

/** Prepared demand never allocates stock or supplier order quantities. */
export async function readPurchasePreparationsTx(tx: Db, proposals: PurchasePreparation[],ofId:number,kind:PurchasePreparation['kind']): Promise<{items:SavedPurchasePreparation[];requiresSync:boolean}> {
  const rows = (await tx.query<Row>(`SELECT id::text,scope_key,snapshot,content_hash,status,updated_at::text,of_id::text
    FROM public.production_purchase_preparations WHERE scope_key=ANY($1::text[]) OR (of_id=$2 AND kind=$3 AND status<>'PERIMEE')`,
    [proposals.map(p => p.scopeKey),ofId,kind])).rows;
  const items=proposals.map(proposal => {
    const row = rows.find(r => r.scope_key === proposal.scopeKey);
    return { ...proposal, id: row?.id ?? null, saved: row?.status === proposal.status && row?.content_hash === materialPropertiesFingerprint(proposal), updatedAt: row?.updated_at ?? null };
  });
  const keys=new Set(proposals.map(p=>p.scopeKey));
  return {items,requiresSync:rows.some(row=>row.of_id===String(ofId)&&row.status!=='PERIMEE'&&!keys.has(row.scope_key))||
    items.some(item=>!item.saved&&(item.status!=='COUVERTE'||!!item.id))};
}

/** Caller holds planning then OF locks; global consumables share one article scope. */
export async function savePurchasePreparationsTx(tx: PoolClient, inputProposals: PurchasePreparation[], kind: PurchasePreparation['kind'], ofId: number,
  sourceVersion: string, audit: AuditContext): Promise<void> {
  const proposals=inputProposals.map(raw=>{
    const {id: _id,saved: _saved,updatedAt: _updatedAt,...proposal}=raw as SavedPurchasePreparation;
    return proposal;
  });
  // Keep disappeared/changed sources as history; a new revision gets a distinct identity.
  const expired = (await tx.query<Row>(`UPDATE public.production_purchase_preparations SET status='PERIMEE',updated_at=now(),updated_by=$4,
    row_version=row_version+1 WHERE of_id=$1 AND kind=$2 AND scope_key<>ALL($3::text[]) AND status<>'PERIMEE'
    RETURNING id::text,scope_key,snapshot,content_hash,status,updated_at::text`, [ofId, kind, proposals.map(p => p.scopeKey), audit.user_id])).rows;
  for (const row of expired) await tx.query(`INSERT INTO public.production_purchase_preparation_events(preparation_id,actor_id,event_type,snapshot)
    VALUES($1::uuid,$2,'SUPERSEDED',$3::jsonb)`, [row.id, audit.user_id, JSON.stringify(row.snapshot)]);
  for (const proposal of proposals) {
    const hash = materialPropertiesFingerprint(proposal);
    const previous = (await tx.query<Row>(`SELECT id::text,scope_key,snapshot,content_hash,status,updated_at::text
      FROM public.production_purchase_preparations WHERE scope_key=$1 FOR UPDATE`, [proposal.scopeKey])).rows[0];
    if (previous?.status === proposal.status && previous?.content_hash === hash) continue;
    // Do not create an empty request just because a covered OF was opened.
    if (!previous && proposal.status === 'COUVERTE') continue;
    const row = (await tx.query<{ id: string }>(`INSERT INTO public.production_purchase_preparations
      (scope_key,kind,mode,of_id,source_ref,need_id,article_id,destination_id,supplier_id,technical_version_id,technical_hash,of_revision_id,
       designation,unit,missing_qty,ordered_qty,status,actions,snapshot,content_hash,source_version,created_by,updated_by)
      VALUES($1,$2,$3,$4,$5::uuid,$6::uuid,$7::uuid,$8::uuid,$9::uuid,$10::uuid,$11,$12::uuid,$13,$14,$15,$16,$17,$18::jsonb,$19::jsonb,$20,$21,$22,$22)
      ON CONFLICT(scope_key) DO UPDATE SET need_id=EXCLUDED.need_id,article_id=EXCLUDED.article_id,destination_id=EXCLUDED.destination_id,
        supplier_id=EXCLUDED.supplier_id,designation=EXCLUDED.designation,unit=EXCLUDED.unit,missing_qty=EXCLUDED.missing_qty,
        ordered_qty=EXCLUDED.ordered_qty,status=EXCLUDED.status,actions=EXCLUDED.actions,snapshot=EXCLUDED.snapshot,content_hash=EXCLUDED.content_hash,
        source_version=EXCLUDED.source_version,updated_by=EXCLUDED.updated_by,updated_at=now(),row_version=production_purchase_preparations.row_version+1
      RETURNING id::text`, [proposal.scopeKey, kind, proposal.mode, proposal.ofId, proposal.sourceRef, proposal.needId, proposal.articleId,
      proposal.destinationId, proposal.supplierId, proposal.technicalVersion, proposal.technicalHash, proposal.ofRevisionId,
      proposal.designation, proposal.unit, proposal.missing, proposal.ordered, proposal.status, JSON.stringify(proposal.actions),
      JSON.stringify(proposal), hash, sourceVersion, audit.user_id])).rows[0];
    await tx.query(`INSERT INTO public.production_purchase_preparation_events(preparation_id,actor_id,event_type,snapshot)
      VALUES($1::uuid,$2,$3,$4::jsonb)`, [row.id, audit.user_id, previous ? 'REFRESHED' : 'PREPARED', JSON.stringify(proposal)]);
  }
}
