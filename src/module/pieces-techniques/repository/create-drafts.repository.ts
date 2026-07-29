// src/module/pieces-techniques/repository/create-drafts.repository.ts
// Issue #227 — brouillons du parcours de création « Nouvelle pièce technique ».
//
// POURQUOI EN BASE ET PAS DANS LE NAVIGATEUR
// Un brouillon perdu, c'est une saisie technique refaite. Le stocker côté serveur le rend
// reprenable depuis un autre poste, survivable à un rechargement, et auditable. Il reste
// STRICTEMENT privé à son auteur : aucune lecture croisée entre comptes.
import db from "../../../config/database";

type Queryer = Pick<import("pg").PoolClient, "query">;

export class DraftInfrastructureMissing extends Error {
  constructor() {
    super("#227: public.piece_technique_create_drafts absente — patch non appliqué");
    this.name = "DraftInfrastructureMissing";
  }
}

function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

export type PieceTechniqueDraft = {
  id: string;
  owner_user_id: number;
  title: string | null;
  payload: Record<string, unknown>;
  current_step: string | null;
  piece_technique_id: string | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
};

const DRAFT_COLUMNS = `
  id::text AS id, owner_user_id, title, payload, current_step,
  piece_technique_id::text AS piece_technique_id,
  created_at::text AS created_at, updated_at::text AS updated_at,
  submitted_at::text AS submitted_at
`;

export async function repoListDrafts(ownerUserId: number, tx: Queryer = db): Promise<PieceTechniqueDraft[]> {
  try {
    const res = await tx.query<PieceTechniqueDraft>(
      `SELECT ${DRAFT_COLUMNS}
         FROM public.piece_technique_create_drafts
        WHERE owner_user_id = $1 AND submitted_at IS NULL AND abandoned_at IS NULL
        ORDER BY updated_at DESC
        LIMIT 25`,
      [ownerUserId]
    );
    return res.rows;
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

export async function repoGetDraft(
  draftId: string,
  ownerUserId: number,
  tx: Queryer = db
): Promise<PieceTechniqueDraft | null> {
  try {
    // Le filtre sur le propriétaire est DANS la requête : un identifiant deviné ne doit
    // pas suffire à lire le brouillon d'un collègue.
    const res = await tx.query<PieceTechniqueDraft>(
      `SELECT ${DRAFT_COLUMNS}
         FROM public.piece_technique_create_drafts
        WHERE id = $1::uuid AND owner_user_id = $2 AND abandoned_at IS NULL`,
      [draftId, ownerUserId]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

export async function repoCreateDraft(
  ownerUserId: number,
  input: { title?: string | null; payload: Record<string, unknown>; current_step?: string | null },
  tx: Queryer = db
): Promise<PieceTechniqueDraft> {
  try {
    const res = await tx.query<PieceTechniqueDraft>(
      `INSERT INTO public.piece_technique_create_drafts (owner_user_id, title, payload, current_step)
       VALUES ($1, $2, $3::jsonb, $4)
       RETURNING ${DRAFT_COLUMNS}`,
      [ownerUserId, input.title ?? null, JSON.stringify(input.payload), input.current_step ?? null]
    );
    return res.rows[0];
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

export async function repoUpdateDraft(
  draftId: string,
  ownerUserId: number,
  input: { title?: string | null; payload: Record<string, unknown>; current_step?: string | null },
  tx: Queryer = db
): Promise<PieceTechniqueDraft | null> {
  try {
    const res = await tx.query<PieceTechniqueDraft>(
      `UPDATE public.piece_technique_create_drafts
          SET title        = $3,
              payload      = $4::jsonb,
              current_step = $5,
              updated_at   = now()
        WHERE id = $1::uuid AND owner_user_id = $2 AND submitted_at IS NULL AND abandoned_at IS NULL
        RETURNING ${DRAFT_COLUMNS}`,
      [draftId, ownerUserId, input.title ?? null, JSON.stringify(input.payload), input.current_step ?? null]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

/** Abandon logique : le brouillon sort des listes, rien n'est effacé de l'historique. */
export async function repoAbandonDraft(
  draftId: string,
  ownerUserId: number,
  tx: Queryer = db
): Promise<boolean> {
  try {
    const res = await tx.query<{ id: string }>(
      `UPDATE public.piece_technique_create_drafts
          SET abandoned_at = now(), updated_at = now()
        WHERE id = $1::uuid AND owner_user_id = $2 AND abandoned_at IS NULL
        RETURNING id::text AS id`,
      [draftId, ownerUserId]
    );
    return res.rows.length > 0;
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

/** Marque un brouillon comme abouti et le relie à la pièce réellement créée. */
export async function repoMarkDraftSubmitted(
  draftId: string,
  ownerUserId: number,
  pieceTechniqueId: string,
  tx: Queryer = db
): Promise<void> {
  try {
    await tx.query(
      `UPDATE public.piece_technique_create_drafts
          SET submitted_at = now(), piece_technique_id = $3::uuid, updated_at = now()
        WHERE id = $1::uuid AND owner_user_id = $2 AND submitted_at IS NULL`,
      [draftId, ownerUserId, pieceTechniqueId]
    );
  } catch (err) {
    if (isMissingRelation(err)) throw new DraftInfrastructureMissing();
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Idempotence de création                                                    */
/* -------------------------------------------------------------------------- */

export type IdempotentReplay = { piece_technique_id: string; request_hash: string };

export async function repoFindIdempotentPieceCreate(
  idempotencyKey: string,
  tx: Queryer = db
): Promise<IdempotentReplay | null> {
  try {
    const res = await tx.query<IdempotentReplay>(
      `SELECT piece_technique_id::text AS piece_technique_id, request_hash
         FROM public.piece_technique_create_idempotence
        WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    // Sans la table, l'idempotence est simplement inactive : la création reste possible.
    if (isMissingRelation(err)) return null;
    throw err;
  }
}

export async function repoRecordIdempotentPieceCreate(
  idempotencyKey: string,
  requestHash: string,
  pieceTechniqueId: string,
  tx: Queryer = db
): Promise<void> {
  try {
    await tx.query(
      `INSERT INTO public.piece_technique_create_idempotence (idempotency_key, request_hash, piece_technique_id)
       VALUES ($1, $2, $3::uuid)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [idempotencyKey, requestHash, pieceTechniqueId]
    );
  } catch (err) {
    if (isMissingRelation(err)) return;
    throw err;
  }
}
