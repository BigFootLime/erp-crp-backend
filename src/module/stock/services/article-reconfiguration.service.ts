import { assertSurfaceFinishCapability } from "../../surface-finish/domain/surface-finish-policy";
import { repoReconfigureArticle } from "../repository/article-reconfiguration.repository";
import type { AuditContext } from "../repository/stock.repository";
import type { ArticleReconfiguration } from "../validators/article-reconfiguration.validators";

export async function reconfigureArticle(
  id: string, body: ArticleReconfiguration, audit: AuditContext,
  actor: { role: string | null }, key: string, includeCosts: boolean,
) {
  if (body.finish) assertSurfaceFinishCapability(actor.role, "article_resolve");
  return repoReconfigureArticle(id, body, audit, actor, key, includeCosts);
}
