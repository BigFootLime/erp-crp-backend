import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { AuditContext } from "../../module/production/repository/production.repository";
import type { NeedConfiguration } from "../../module/production/repository/of-material.repository";
import {
  configureOfMaterial,
  confirmOfMaterial,
  getOfMaterial,
} from "../../module/production/services/of-material.service";

type MaterialSelection = {
  sourceRef?: string;
  batchId?: string;
  quantity?: number;
  configuration?: NeedConfiguration;
};

type MaterialState = Exclude<Awaited<ReturnType<typeof getOfMaterial>>, { enabled: false }>;

function selectedNeed(material: MaterialState, sourceRef?: string) {
  const matches = sourceRef
    ? material.needs.filter((need) => need.key === sourceRef)
    : material.needs;
  if (matches.length !== 1)
    throw new Error(
      sourceRef
        ? `Pilot material source ${sourceRef} is missing or ambiguous.`
        : `Pilot OF has ${matches.length} material needs. Select one source explicitly.`,
    );
  return matches[0];
}

/** Reserves through the OF material workflow. It never writes a reservation.
 * A fixture with no explicit need returns material_required false. */
export async function reservePilotOfMaterial(
  ofId: number,
  audit: AuditContext,
  selection: MaterialSelection = {},
) {
  let material = await getOfMaterial(ofId);
  if (!material.enabled || material.needs.length === 0)
    return { material_required: false as const, reservation_ids: [] as string[] };

  let need = selectedNeed(material, selection.sourceRef);
  if (need.blockers.length) {
    if (!selection.configuration)
      throw new Error(
        `Pilot material ${need.key} needs explicit configuration: ${need.blockers.join(" ")}`,
      );
    await configureOfMaterial(
      ofId,
      need.key,
      {
        expectedVersion: material.version,
        idempotencyKey: randomUUID(),
        configuration: selection.configuration,
      },
      audit,
    );
    material = await getOfMaterial(ofId);
    if (!material.enabled) throw new Error("Material workflow became unavailable.");
    need = selectedNeed(material, selection.sourceRef);
  }
  if (need.blockers.length)
    throw new Error(`Pilot material ${need.key} remains blocked: ${need.blockers.join(" ")}`);

  const suggested = need.selections.find(
    (candidate) => !selection.batchId || candidate.batchId === selection.batchId,
  );
  const batchId = selection.batchId ?? suggested?.batchId;
  const quantity = selection.quantity ?? suggested?.quantity;
  if (!batchId || !quantity)
    throw new Error(`No physical lot can cover pilot material ${need.key}.`);

  const confirmed = await confirmOfMaterial(
    ofId,
    {
      expectedVersion: material.version,
      idempotencyKey: randomUUID(),
      selections: [{ needKey: need.key, batchId, quantity }],
      futureSelections: [],
    },
    audit,
    true,
  );
  expect(confirmed.reservedIds.length).toBeGreaterThan(0);

  const after = await getOfMaterial(ofId);
  if (!after.enabled) throw new Error("Material workflow became unavailable.");
  const reservedNeed = selectedNeed(after, need.key);
  expect(reservedNeed.reserved).toBeGreaterThanOrEqual(quantity);
  expect(after.physicalCoverage?.needs).toHaveLength(0);
  return {
    material_required: true as const,
    source_ref: need.key,
    batch_id: batchId,
    quantity,
    reservation_ids: confirmed.reservedIds,
  };
}
