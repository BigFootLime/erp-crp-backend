import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
/** Fixture clients use the ERP's three-character identifiers. Reserve an unused
 * one even when integration tests are replayed in the same local database. */
export async function createPilotFixtureClient(db: Pick<PoolClient, "query">, prefix: string, name: string) {
  if (!/^[A-Z]$/.test(prefix)) throw new Error("Expected a one-letter fixture prefix.");
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await db.query<{ client_id: string }>(`WITH candidates AS (
      SELECT $1::text || substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1+i/36, 1) ||
        substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 1+i%36, 1) AS code FROM generate_series(0,1295) i
      ) INSERT INTO public.clients(client_id,client_code,company_name)
      SELECT code,code,$2 FROM candidates
      WHERE NOT EXISTS(SELECT 1 FROM public.clients c WHERE c.client_id=code OR c.client_code=code)
      ORDER BY random() LIMIT 1 ON CONFLICT DO NOTHING RETURNING client_id`, [prefix, name]);
    if (result.rows[0]) return result.rows[0].client_id;
  }
  throw new Error("Unable to reserve a client code in this isolated database.");
}
/** Used only by tests guarded with the isolated CERP database check. Caller owns the transaction. */
export async function createPilotFixtureArticle(
  tx: PoolClient,
  clientId: string,
  actor: number,
  article: string,
  code: string,
  options: { publish?: boolean } = {},
) {
  const piece = randomUUID(),
    version = randomUUID();
  await tx.query(
    `INSERT INTO public.pieces_techniques(id,root_piece_technique_id,version_number,code_piece,name_piece,designation)
 VALUES($1,$1,1,$2,$2,$2)`,
    [piece, code],
  );
  await tx.query(
    `INSERT INTO public.piece_technique_versions(id,piece_technique_id,indice,statut,is_current,date_application,date_effet)
 VALUES($1,$2,'A',$3,true,CURRENT_DATE,CURRENT_DATE)`,
    [version, piece, options.publish === false ? "BROUILLON" : "APPLICABLE"],
  );
  await tx.query(
    `INSERT INTO public.articles(id,root_article_id,version_number,plan_index,code,designation,article_type,piece_technique_id,
 unite,article_category,status,commercial_scope,is_sold,stock_managed,family_code) VALUES($1,$1,1,1,$2,$2,'PIECE_TECHNIQUE',$3,'u','fabrique','VALIDE','CLIENTS',true,true,$2)`,
    [article, code, piece],
  );
  const family = (
    await tx.query<{ code: string }>(
      "SELECT code FROM public.articles_fabrique_families ORDER BY code LIMIT 1",
    )
  ).rows[0];
  if (!family)
    throw new Error("Seed the isolated fabricated article families first.");
  await tx.query(
    "INSERT INTO public.articles_fabrique(article_id,family_code,piece_technique_id) VALUES($1,$2,$3)",
    [article, family.code, piece],
  );
  await tx.query(
    "INSERT INTO public.article_client_links(article_id,client_id,created_by) VALUES($1,$2,$3)",
    [article, clientId, actor],
  );
  return { piece, version };
}
