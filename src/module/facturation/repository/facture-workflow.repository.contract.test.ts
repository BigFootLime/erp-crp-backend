import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { repoRoot } from "../../../__tests__/helpers/repo-paths";

const source = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/facture-workflow.repository.ts"),
  "utf8"
);
const avoirSource = readFileSync(
  resolve(repoRoot, "src/module/facturation/repository/avoir-workflow.repository.ts"),
  "utf8"
);

describe("facture draft SQL contract", () => {
  it("casts the shared draft reference for varchar and text destinations", () => {
    expect(source).toContain("$1,$2::uuid,$3::varchar,$3::text,NULL,$4");
    expect(source).not.toContain("$1,$2::uuid,$3,$3,NULL,$4");
  });

  it("uses the canonical French invoice-line foreign key", () => {
    expect(source).toContain("facture_id, facture_ligne_id, source_type");
    expect(source).toContain("ORDER BY facture_ligne_id, id");
    expect(source).not.toContain("facture_id, facture_line_id, source_type");
    expect(avoirSource).toContain("WHERE source.facture_ligne_id = fl.id");
    expect(avoirSource).toContain("facture_id, facture_ligne_id,");
    expect(avoirSource).toContain("facture_ligne_id AS facture_line_id");
  });

  it("casts workflow approvers to the integer user foreign key", () => {
    const cast = "approved_by = CASE WHEN $2 = 'APPROVED' THEN $3::integer ELSE NULL END";
    expect(source).toContain(cast);
    expect(avoirSource).toContain(cast);
  });

  it("casts issued legal numbers for the legacy varchar and workflow text columns", () => {
    for (const repository of [source, avoirSource]) {
      expect(repository).toContain("SET numero = $2::varchar");
      expect(repository).toContain("legal_number = $2::text");
    }
  });

  it("versions delivery-line pricing from canonical price values without an optional timestamp column", () => {
    expect(source).not.toContain("cl.updated_at");
    expect(source).toContain("COALESCE(cl.prix_unitaire_ht::text, 'NULL')");
    expect(source).toContain("COALESCE(cl.remise_ligne::text, 'NULL')");
    expect(source).toContain("COALESCE(cl.taux_tva::text, 'NULL')");
  });
});
