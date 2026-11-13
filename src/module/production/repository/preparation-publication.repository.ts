import type { PoolClient } from 'pg';
import { HttpError } from '../../../utils/httpError';
import { publishGammeTx } from '../../gammes/repository/gamme-operations.repository';
import { publishVersionTx } from '../../pieces-techniques/repository/versions.repository';
import { activatePreparedPieceTx } from '../../pieces-techniques/repository/pieces-techniques.repository';
import type { AuditContext } from './production.repository';

/** Publish only the selected technical definition, in the same transaction as the OF freeze. */
export async function publishPreparationDefinitionTx(tx: PoolClient, pieceId: string, versionId: string, audit: AuditContext) {
  await activatePreparedPieceTx(tx,pieceId,audit);
  const version = (await tx.query<{statut:string;effective:boolean}>(`SELECT statut,
    date_effet IS NULL OR date_effet<=CURRENT_DATE AS effective FROM public.piece_technique_versions
    WHERE id=$1::uuid AND piece_technique_id=$2::uuid FOR UPDATE`, [versionId,pieceId])).rows[0];
  if (!version || version.statut === 'OBSOLETE' || !version.effective)
    throw new HttpError(422,'VERSION_NOT_PUBLISHABLE','L’indice sélectionné est obsolète ou sa date d’effet est future.');
  const gamme = (await tx.query<{id:string;statut:string;updated_at:string}>(`SELECT id::text,statut,updated_at::text
    FROM public.gammes WHERE piece_technique_version_id=$1::uuid AND is_current
    ORDER BY created_at DESC,id LIMIT 1 FOR UPDATE`, [versionId])).rows[0];
  if (!gamme) throw new HttpError(422,'GAMME_REQUIRED','Complétez la gamme avant de valider le dossier.');
  if (gamme.statut !== 'APPLICABLE') await publishGammeTx(tx,gamme.id,gamme.updated_at,audit);
  const published = await publishVersionTx(tx,pieceId,versionId,{date_application:null,
    commentaire_validation:'Validation du dossier de préparation OF.'},audit);
  if (!published) throw new HttpError(404,'VERSION_NOT_FOUND','Indice introuvable.');
  return {versionId,gammeId:gamme.id};
}
