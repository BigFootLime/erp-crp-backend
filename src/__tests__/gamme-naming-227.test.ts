/**
 * #227 — nommage automatique des gammes.
 * L'opérateur ne doit plus inventer un intitulé : le serveur nomme.
 */
import { describe, expect, it } from "vitest";

import { buildGammeName, resolveGammeName } from "../module/gammes/domain/gamme-naming";
import { createGammeSchema } from "../module/gammes/validators/gammes.validators";

describe("#227 — nom de gamme calculé par le serveur", () => {
  it("compose le nom depuis le code pièce et l'indice", () => {
    expect(buildGammeName({ codePiece: "045-10233-000", indice: "A" })).toBe(
      "Gamme 045-10233-000 — indice A"
    );
  });

  it("suffixe le rang à partir de la deuxième gamme du même indice", () => {
    expect(buildGammeName({ codePiece: "045-10233-000", indice: "A", rank: 1 })).toBe(
      "Gamme 045-10233-000 — indice A"
    );
    expect(buildGammeName({ codePiece: "045-10233-000", indice: "A", rank: 2 })).toBe(
      "Gamme 045-10233-000 — indice A (2)"
    );
  });

  it("retombe sur la désignation quand le code manque, puis sur l'indice seul", () => {
    expect(buildGammeName({ codePiece: null, designation: "Carter aluminium", indice: "B" })).toBe(
      "Gamme Carter aluminium — indice B"
    );
    expect(buildGammeName({ indice: "C" })).toBe("Gamme — indice C");
    expect(buildGammeName({})).toBe("Gamme");
  });

  it("est déterministe : mêmes entrées, même nom", () => {
    const input = { codePiece: "045-10233-000", indice: "A", rank: 3 };
    expect(buildGammeName(input)).toBe(buildGammeName(input));
  });

  it("respecte la borne de colonne (200 caractères)", () => {
    const name = buildGammeName({ codePiece: "X".repeat(400), indice: "A" });
    expect(name.length).toBeLessThanOrEqual(200);
    expect(name.endsWith("…")).toBe(true);
  });

  it("normalise les espaces parasites du code et de l'indice", () => {
    expect(buildGammeName({ codePiece: "  045-10233-000  ", indice: " A " })).toBe(
      "Gamme 045-10233-000 — indice A"
    );
  });
});

describe("#227 — le nom fourni reste prioritaire, l'absence déclenche le calcul", () => {
  it("respecte un intitulé explicite (reprise de données, import, renommage)", () => {
    expect(resolveGammeName("Gamme prototype 2019", { codePiece: "045-10233-000", indice: "A" })).toBe(
      "Gamme prototype 2019"
    );
  });

  it("nomme quand le client n'envoie rien — c'est le cas du parcours de création", () => {
    const generated = "Gamme 045-10233-000 — indice A";
    expect(resolveGammeName(undefined, { codePiece: "045-10233-000", indice: "A" })).toBe(generated);
    expect(resolveGammeName(null, { codePiece: "045-10233-000", indice: "A" })).toBe(generated);
    expect(resolveGammeName("   ", { codePiece: "045-10233-000", indice: "A" })).toBe(generated);
  });
});

describe("#227 — le contrat d'entrée n'exige plus le nom", () => {
  it("accepte une création sans nom", () => {
    expect(createGammeSchema.safeParse({ body: {} }).success).toBe(true);
    expect(createGammeSchema.safeParse({ body: { is_current: true } }).success).toBe(true);
  });

  it("accepte encore un nom explicite", () => {
    const parsed = createGammeSchema.safeParse({ body: { nom: "Gamme série" } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.body.nom).toBe("Gamme série");
  });

  it("rejette toujours un nom vide explicitement transmis", () => {
    expect(createGammeSchema.safeParse({ body: { nom: "" } }).success).toBe(false);
  });
});
