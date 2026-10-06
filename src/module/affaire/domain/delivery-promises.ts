import { HttpError } from "../../../utils/httpError";
export type PromisePart = {
    quantity: number;
    due_date: string;
};
const EPSILON = 0.000001;
/** Commercial promises never redistribute physical stock or production coverage. */
export function assertPromiseParts(parts: PromisePart[], remaining: number) {
    if (remaining <= EPSILON)
        throw new HttpError(409, "PROMISE_ALREADY_SHIPPED", "Toutes les quantités sont déjà expédiées.");
    if (!parts.length || parts.length > 50 || parts.some(p => !Number.isFinite(p.quantity) || p.quantity <= 0))
        throw new HttpError(422, "PROMISE_QUANTITY_INVALID", "Chaque échéance doit porter une quantité positive.");
    const total = parts.reduce((sum, p) => sum + p.quantity, 0);
    if (Math.abs(total - remaining) > EPSILON)
        throw new HttpError(422, "PROMISE_TOTAL_CHANGED", `Répartissez exactement les ${remaining} pièces restant à expédier.`);
    for (const part of parts) {
        const parsed = new Date(part.due_date + "T00:00:00Z");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(part.due_date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== part.due_date)
            throw new HttpError(422, "PROMISE_DATE_INVALID", "Une date d'échéance est invalide.");
    }
}
export type DeliveryMeasure = {
    quantity: number;
    due_date: string;
    delivered_date: string | null;
};
/** Include open overdue pieces in the denominator, while future pieces stay pending. */
export function measureDeliveryPromises(rows: DeliveryMeasure[], today: string) {
    let on_time = 0, late_delivered = 0, open_overdue = 0, pending = 0;
    for (const row of rows) {
        if (row.delivered_date) {
            if (row.delivered_date <= row.due_date)
                on_time += row.quantity;
            else
                late_delivered += row.quantity;
        }
        else if (row.due_date < today)
            open_overdue += row.quantity;
        else
            pending += row.quantity;
    }
    const assessed = on_time + late_delivered + open_overdue;
    return { on_time, late_delivered, open_overdue, pending, assessed,
        punctuality_percent: assessed > 0 ? on_time / assessed * 100 : null };
}
