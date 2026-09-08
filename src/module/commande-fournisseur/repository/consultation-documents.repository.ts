import type {PoolClient} from 'pg';
import {HttpError} from '../../../utils/httpError';
import {assertGedCapability,roleHasGedCapability} from '../../ged/domain/ged-policy';
import {assertGedVersionParentReadable} from '../../ged/services/ged-parent-authorization.service';

export type ConsultationDocument={document_id:string;version_id:string;code:string;title:string;original_name:string;version_number:number;sha256:string};
type Actor={user_id:number;role?:string|null};
/** References only: bytes and access remain owned by GED. Never add a second
 * parent link to a technical document merely because it is consulted. */
export async function readConsultationDocuments(tx:Pick<PoolClient,'query'>,commandeId:string,actor:Actor,selected?:string[]){
  if(selected?.length)assertGedCapability(actor.role,'download');
  if(!roleHasGedCapability(actor.role,'read')||!actor.user_id)return [];
  if(selected && !selected.length)return [];
  const rows=(await tx.query<ConsultationDocument>(`WITH recipients AS (
    SELECT l.of_id FROM public.commande_fournisseur_ligne l WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' AND l.of_id IS NOT NULL
    UNION SELECT b.of_id FROM public.commande_fournisseur_ligne_besoin b JOIN public.commande_fournisseur_ligne l ON l.id=b.ligne_id
      WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE' AND NOT b.annule AND b.of_id IS NOT NULL
  ), scope AS (
    SELECT 'COMMANDE_FOURNISSEUR'::text AS entity_type,$1::text AS entity_id
    UNION SELECT 'ORDRE_FABRICATION',of_id::text FROM recipients
    UNION SELECT 'OF',of_id::text FROM recipients
    UNION SELECT 'PIECE_TECHNIQUE_VERSION',o.piece_technique_version_id::text FROM recipients r JOIN public.ordres_fabrication o ON o.id=r.of_id
    UNION SELECT 'ARTICLE',l.article_id::text FROM public.commande_fournisseur_ligne l WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE'
    UNION SELECT 'STOCK_ARTICLE',l.article_id::text FROM public.commande_fournisseur_ligne l WHERE l.commande_id=$1::uuid AND l.statut_ligne='ACTIVE'
  ) SELECT d.id::text AS document_id,v.id::text AS version_id,d.code,d.title,v.original_name,v.version_number::int,b.sha256
    FROM public.ged_documents d JOIN public.ged_document_versions v ON v.id=d.current_version_id
    JOIN public.ged_blobs b ON b.id=v.blob_id
    LEFT JOIN public.ged_upload_sessions us ON us.id=v.upload_session_id
    WHERE d.archived_at IS NULL AND v.status='APPLICABLE'
      AND (us.scan_status IS NULL OR us.scan_status='clean') AND us.quarantine_status IS DISTINCT FROM 'quarantined'
      AND ($2::uuid[] IS NULL OR v.id=ANY($2::uuid[]))
      AND EXISTS(SELECT 1 FROM public.ged_document_links link JOIN scope s ON s.entity_type=link.entity_type AND s.entity_id=link.entity_id WHERE link.document_id=d.id)
      AND NOT EXISTS(SELECT 1 FROM recipients r JOIN public.ordres_fabrication o ON o.id=r.of_id
        JOIN public.ged_document_links link ON link.document_id=d.id AND link.entity_type='PIECE_TECHNIQUE_VERSION' AND link.entity_id=o.piece_technique_version_id::text
        WHERE o.technical_snapshot_sha256 IS NOT NULL AND NOT EXISTS(
          SELECT 1 FROM jsonb_array_elements(COALESCE(o.technical_snapshot->'preparation_evidence'->'documents',o.technical_snapshot->'documents','[]'::jsonb)) evidence
          WHERE evidence->>'version_id'=v.id::text))
    ORDER BY d.code,v.id LIMIT 201${selected?' FOR SHARE OF d,v':''}`,[commandeId,selected??null])).rows;
  if(rows.length>200)throw new HttpError(409,'CONSULTATION_DOCUMENT_LIMIT','Plus de 200 documents sont liés à ces besoins. Faites revoir le classement documentaire.');
  const readable:ConsultationDocument[]=[];
  for(const row of rows){
    try{await assertGedVersionParentReadable(actor.user_id,row.document_id);readable.push(row);}
    catch(error){if(error instanceof HttpError&&error.status===404){if(selected)throw error;}else throw error;}
  }
  if(selected&&(new Set(selected).size!==selected.length||readable.length!==selected.length))
    throw new HttpError(409,'CONSULTATION_DOCUMENT_CHANGED','Un document choisi n’est plus applicable ou accessible pour ces besoins. Relisez les documents avant de préparer la demande.');
  return readable;
}
