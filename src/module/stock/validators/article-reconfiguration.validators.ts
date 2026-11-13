import { z } from "zod";
import { createArticleSchema } from "./stock.validators";
import { stockArticleFinishConfirmBodySchema } from "../../surface-finish/validators/surface-finish.validators";

export const articleReconfigurationSchema = z.object({
  expected_row_version: z.number().int().positive(),
  action: z.enum(["REPLACE_ALL", "ARCHIVE_OLD", "KEEP_BOTH"]),
  article: createArticleSchema.shape.body.optional(),
  finish: stockArticleFinishConfirmBodySchema.optional(),
}).strict().superRefine((body, ctx) => {
  if (Boolean(body.article) === Boolean(body.finish)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Choisissez une configuration article ou finition.", path: ["article"] });
  }
  if (body.article?.article_category === "traitement") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Les procédés spéciaux utilisent le configurateur de finition.", path: ["finish"] });
  }
  if (body.article?.article_categories?.includes("sous_traitance") && !body.article.subcontract_definition) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "La définition de sous-traitance est obligatoire.", path: ["article", "subcontract_definition"] });
  }
});
export type ArticleReconfiguration = z.infer<typeof articleReconfigurationSchema>;
