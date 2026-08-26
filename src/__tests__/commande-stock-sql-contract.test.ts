import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function repositorySource(): string {
  return fs.readFileSync(
    path.join(process.cwd(), "src/module/commande-client/repository/commande-client.repository.ts"),
    "utf8"
  );
}

function functionSource(source: string, name: string, nextName: string): string {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("commande stock SQL contract", () => {
  it("groups OLD/NEW availability by the same effective scope that it selects", () => {
    const source = functionSource(
      repositorySource(),
      "loadScopedAvailableQtyByArticle",
      "computeCommandeStockAnalysis"
    );

    expect(source).toMatch(
      /SELECT[\s\S]*COALESCE\(lot\.source_scope, warehouse\.stock_scope, 'NEW'\) AS stock_scope[\s\S]*GROUP BY[\s\S]*availability\.article_id,[\s\S]*COALESCE\(lot\.source_scope, warehouse\.stock_scope, 'NEW'\)/
    );
  });

  it("joins lots before using their scope and FIFO dates for delivery candidates", () => {
    const source = functionSource(
      repositorySource(),
      "loadScopedDeliveryStockCandidates",
      "planDeliveryAllocations"
    );

    expect(source).toMatch(/JOIN public\.lots lot ON lot\.id = availability\.lot_id/);
    expect(source).toMatch(
      /COALESCE\(lot\.source_scope, warehouse\.stock_scope, 'NEW'\) AS stock_scope/
    );
    expect(source).toMatch(
      /CASE COALESCE\(lot\.source_scope, warehouse\.stock_scope, 'NEW'\) WHEN 'OLD' THEN 0 ELSE 1 END/
    );
  });
});
