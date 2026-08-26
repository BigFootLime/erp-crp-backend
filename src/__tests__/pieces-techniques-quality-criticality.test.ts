import { describe, expect, it } from "vitest";

import { QUALITY_LEVELS } from "../module/client/validators/client.validators";
import {
  listPiecesTechniquesQuerySchema,
  pieceTechniqueQualityLevelsSchema,
} from "../module/pieces-techniques/validators/pieces-techniques.validators";
import { listAvailableArticleLotsQuerySchema } from "../module/stock/validators/stock.validators";

describe("PT quality, criticality and available-lot contracts", () => {
  it("uses exactly the client quality vocabulary", () => {
    expect(pieceTechniqueQualityLevelsSchema.parse([...QUALITY_LEVELS])).toEqual([...QUALITY_LEVELS]);
    expect(() => pieceTechniqueQualityLevelsSchema.parse(["custom quality"])).toThrow();
  });

  it("parses the server-side criticality filter and technical reference sorting", () => {
    expect(listPiecesTechniquesQuerySchema.parse({ piece_critique: "true", sortBy: "plan_reference" })).toMatchObject({
      piece_critique: true,
      sortBy: "plan_reference",
    });
    expect(listPiecesTechniquesQuerySchema.parse({ piece_critique: "false" }).piece_critique).toBe(false);
  });

  it("bounds the paginated available-lots drawer", () => {
    expect(
      listAvailableArticleLotsQuerySchema.parse({
        params: { id: "11111111-1111-4111-8111-111111111111" },
        query: { page: "2", limit: "50" },
      })
    ).toMatchObject({ query: { page: 2, limit: 50 } });
  });
});
