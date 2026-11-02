import type { DemandImportPreviewRow as Line } from "../../demand-import/types";

function group(lines: Line[]) {
  const groups = new Map<string, Line[]>();
  for (const line of lines) {
    const c = line.candidate;
    const key = JSON.stringify([
      c.external_order_key,
      c.external_line_key,
      c.external_schedule_key ?? null,
    ]);
    const group = groups.get(key);
    if (group) group.push(line);
    else groups.set(key, [line]);
  }
  return groups;
}

export function compareCarco(
  current: Line[],
  previous: Line[],
  complete: boolean,
) {
  const prior = group(previous);
  const next = group(current);
  return Array.from(new Set([...next.keys(), ...prior.keys()])).map((id) => {
    const before = prior.get(id) ?? [];
    const after = next.get(id) ?? [];
    const line = (after[0] ?? before[0]).candidate;
    // Never pair an ambiguous group by row position, date or quantity.
    const ambiguous =
      !line.external_order_key ||
      !line.external_line_key ||
      before.length > 1 ||
      after.length > 1;
    const changes =
      before.length === 1 && after.length === 1
        ? (
            [
              "article_code",
              "kind",
              "quantity",
              "source_delivered_quantity",
              "need_date",
              "source_confirmed_date",
              "unit",
              "contract_reference",
            ] as const
          ).filter(
            (field) => before[0].candidate[field] !== after[0].candidate[field],
          )
        : [];
    const status = ambiguous
      ? "AMBIGUOUS"
      : !after.length
        ? complete
          ? "MISSING"
          : "OUT_OF_SCOPE"
        : !before.length
          ? "NEW"
          : changes.length
            ? "CHANGED"
            : "UNCHANGED";
    return {
      status,
      changes,
      indicative: !line.external_schedule_key,
      before,
      after,
    };
  });
}
