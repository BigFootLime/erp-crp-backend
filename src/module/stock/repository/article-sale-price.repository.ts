import type { PoolClient } from "pg";

import { HttpError } from "../../../utils/httpError";

export type SalePriceSource = "ARTICLE_SHEET" | "QUOTE" | "CUSTOMER_ORDER";
export type OrderSalePriceDecision = "KEEP" | "SET" | "OVERWRITE";

type Queryable = Pick<PoolClient, "query">;

type LockedArticlePrice = {
  sale_price_reference: number | null;
  sale_price_currency: string;
  sale_price_source: SalePriceSource | null;
};

export type AppliedOrderSalePrice = {
  reference_price: number | null;
  reference_source: SalePriceSource | null;
  decision: OrderSalePriceDecision;
  history_id: string | null;
};

const PRICE_EPSILON = 0.00005;

function pricesEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) < PRICE_EPSILON;
}

async function lockArticlePrice(tx: Queryable, articleId: string): Promise<LockedArticlePrice> {
  const result = await tx.query<LockedArticlePrice>(
    `SELECT sale_price_reference::float8 AS sale_price_reference,
            sale_price_currency,
            sale_price_source
       FROM public.articles
      WHERE id = $1::uuid
      FOR UPDATE`,
    [articleId]
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(400, "UNKNOWN_ARTICLE", `Unknown article ${articleId}`);
  return row;
}

async function persistPriceChange(
  tx: Queryable,
  input: {
    article_id: string;
    previous_price: number | null;
    new_price: number | null;
    source: SalePriceSource;
    source_entity_type: string | null;
    source_entity_id: string | null;
    decision: "SET" | "OVERWRITE" | "CLEAR";
    reason: string | null;
    actor_user_id: number | null;
    bump_row_version: boolean;
  }
): Promise<string> {
  const history = await tx.query<{ id: string }>(
    `INSERT INTO public.article_sale_price_history (
       article_id, previous_price, new_price, currency, source,
       source_entity_type, source_entity_id, decision, reason, actor_user_id
     ) VALUES ($1::uuid,$2,$3,'EUR',$4,$5,$6,$7,$8,$9)
     RETURNING id::text AS id`,
    [
      input.article_id,
      input.previous_price,
      input.new_price,
      input.source,
      input.source_entity_type,
      input.source_entity_id,
      input.decision,
      input.reason,
      input.actor_user_id,
    ]
  );
  const historyId = history.rows[0]?.id;
  if (!historyId) throw new Error("ARTICLE_SALE_PRICE_HISTORY_INSERT_FAILED");

  await tx.query(
    `UPDATE public.articles
        SET sale_price_reference = $2,
            sale_price_currency = 'EUR',
            sale_price_source = $3,
            sale_price_source_entity_type = $4,
            sale_price_source_entity_id = $5,
            sale_price_updated_at = now(),
            sale_price_updated_by = $6,
            updated_at = now(),
            updated_by = COALESCE($6, updated_by)
            ${input.bump_row_version ? ", row_version = row_version + 1" : ""}
      WHERE id = $1::uuid`,
    [
      input.article_id,
      input.new_price,
      input.source,
      input.source_entity_type,
      input.source_entity_id,
      input.actor_user_id,
    ]
  );
  return historyId;
}

export async function applyOrderLineSalePriceTx(
  tx: Queryable,
  input: {
    article_id: string;
    proposed_price: number;
    decision?: OrderSalePriceDecision | null;
    source: SalePriceSource;
    source_entity_type: string;
    source_entity_id: string;
    actor_user_id: number | null;
    line_index: number;
  }
): Promise<AppliedOrderSalePrice> {
  const current = await lockArticlePrice(tx, input.article_id);
  const proposed = Number(input.proposed_price);
  if (!Number.isFinite(proposed) || proposed < 0) {
    throw new HttpError(400, "INVALID_SALE_PRICE", "Le prix de vente de la ligne est invalide.");
  }

  // A zero on a newly opened line is a UI default, not evidence that the
  // article's commercial reference is actually free of charge.
  if (current.sale_price_reference === null && proposed <= 0) {
    return {
      reference_price: null,
      reference_source: null,
      decision: "KEEP",
      history_id: null,
    };
  }

  if (current.sale_price_reference === null) {
    const historyId = await persistPriceChange(tx, {
      article_id: input.article_id,
      previous_price: null,
      new_price: proposed,
      source: input.source,
      source_entity_type: input.source_entity_type,
      source_entity_id: input.source_entity_id,
      decision: "SET",
      reason: "Première validation d'une ligne de commande client",
      actor_user_id: input.actor_user_id,
      bump_row_version: true,
    });
    return {
      reference_price: proposed,
      reference_source: input.source,
      decision: "SET",
      history_id: historyId,
    };
  }

  if (pricesEqual(current.sale_price_reference, proposed)) {
    return {
      reference_price: current.sale_price_reference,
      reference_source: current.sale_price_source,
      decision: "KEEP",
      history_id: null,
    };
  }

  if (input.decision !== "KEEP" && input.decision !== "OVERWRITE") {
    throw new HttpError(
      409,
      "ARTICLE_SALE_PRICE_DECISION_REQUIRED",
      "Le prix saisi diffère du prix de référence de l'article. Confirmez si l'ancien prix doit être remplacé.",
      {
        line_index: input.line_index,
        article_id: input.article_id,
        current_reference_price: current.sale_price_reference,
        proposed_price: proposed,
      }
    );
  }

  if (input.decision === "KEEP") {
    return {
      reference_price: current.sale_price_reference,
      reference_source: current.sale_price_source,
      decision: "KEEP",
      history_id: null,
    };
  }

  const historyId = await persistPriceChange(tx, {
    article_id: input.article_id,
    previous_price: current.sale_price_reference,
    new_price: proposed,
    source: input.source,
    source_entity_type: input.source_entity_type,
    source_entity_id: input.source_entity_id,
    decision: "OVERWRITE",
    reason: "Écrasement confirmé depuis une ligne de commande client",
    actor_user_id: input.actor_user_id,
    bump_row_version: true,
  });
  return {
    reference_price: proposed,
    reference_source: input.source,
    decision: "OVERWRITE",
    history_id: historyId,
  };
}

export async function applyArticleSheetSalePriceTx(
  tx: Queryable,
  input: {
    article_id: string;
    new_price: number | null;
    confirm_overwrite: boolean;
    reason: string | null;
    actor_user_id: number;
  }
): Promise<{ changed: boolean; history_id: string | null }> {
  const current = await lockArticlePrice(tx, input.article_id);
  if (pricesEqual(current.sale_price_reference, input.new_price)) {
    return { changed: false, history_id: null };
  }
  if (current.sale_price_reference !== null && !input.confirm_overwrite) {
    throw new HttpError(
      409,
      "ARTICLE_SALE_PRICE_OVERWRITE_CONFIRMATION_REQUIRED",
      "Le prix de référence existe déjà. Confirmez explicitement son remplacement.",
      {
        article_id: input.article_id,
        current_reference_price: current.sale_price_reference,
        proposed_price: input.new_price,
      }
    );
  }

  const decision = input.new_price === null
    ? "CLEAR"
    : current.sale_price_reference === null
      ? "SET"
      : "OVERWRITE";
  const historyId = await persistPriceChange(tx, {
    article_id: input.article_id,
    previous_price: current.sale_price_reference,
    new_price: input.new_price,
    source: "ARTICLE_SHEET",
    source_entity_type: "ARTICLE",
    source_entity_id: input.article_id,
    decision,
    reason: input.reason,
    actor_user_id: input.actor_user_id,
    // repoUpdateArticle already increments the version in the same transaction.
    bump_row_version: false,
  });
  return { changed: true, history_id: historyId };
}

export async function seedArticleSheetSalePriceTx(
  tx: Queryable,
  input: { article_id: string; price: number; actor_user_id: number }
): Promise<void> {
  if (!Number.isFinite(input.price) || input.price <= 0) return;
  await persistPriceChange(tx, {
    article_id: input.article_id,
    previous_price: null,
    new_price: input.price,
    source: "ARTICLE_SHEET",
    source_entity_type: "ARTICLE",
    source_entity_id: input.article_id,
    decision: "SET",
    reason: "Prix renseigné dans la fiche article",
    actor_user_id: input.actor_user_id,
    bump_row_version: false,
  });
}
