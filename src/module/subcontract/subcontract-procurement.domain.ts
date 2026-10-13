import { HttpError } from '../../utils/httpError';
const pieceUnits = new Set(['U', 'UNITE', 'UNITÉ', 'UNIT', 'PCE', 'PC', 'PCS', 'PIECE', 'PIÈCE']);
export const isSubcontractPieceUnit = (unit: string) => pieceUnits.has(unit.trim().toUpperCase());
export const committedSupplierOrderStatuses = new Set(['APPROUVEE', 'ENVOYEE', 'ACCUSE_RECU', 'PARTIELLEMENT_RECUE', 'RECUE', 'CLOTUREE']);

type PreparedServiceLine = { purchaseId: string | null; operationId: string; originId: string | null; quantity: number; status: string };
/** Each service processes the same pieces separately. A committed line remains
 * immutable; only the remaining quantity may become a new supplier draft. */
export function assertSubcontractSupplement(input: {
    purchaseId: string; operationId: string; ofQuantity: number;
    lines: PreparedServiceLine[]; rows: Array<{ originId: string | null; quantity: number }>;
    predecessors: Array<{ status: string; good: number }>;
}) {
    const operationLines = input.lines.filter(line => line.operationId === input.operationId);
    if (operationLines.some(line => !line.purchaseId))
        throw new HttpError(409, 'SUBCONTRACT_SERVICE_IDENTITY_MISSING', 'Rapprochez les lignes historiques de leur prestation avant de préparer un complément.');
    const existing = operationLines.filter(line => line.purchaseId === input.purchaseId);
    if (existing.some(line => input.rows.some(row => row.originId === line.originId) && !committedSupplierOrderStatuses.has(line.status)))
        throw new HttpError(409, 'SUBCONTRACT_ORIGIN_ALREADY_PREPARED', 'Un brouillon couvre déjà cette prestation et cette origine. Ouvrez-le pour l’ajuster.');
    const total = input.rows.reduce((sum, row) => sum + row.quantity, 0) + existing.reduce((sum, line) => sum + line.quantity, 0);
    if (total > input.ofQuantity)
        throw new HttpError(422, 'SUBCONTRACT_QUANTITY_EXCEEDED', 'La préparation de cette prestation dépasse la quantité de l’OF.');
    if (input.predecessors.length && input.predecessors.every(p => p.status === 'DONE') && input.predecessors.some(p => total > p.good))
        throw new HttpError(422, 'SUBCONTRACT_REAL_QUANTITY_EXCEEDED', 'Ajustez le complément aux quantités réellement conformes après clôture de l’opération précédente.');
}
export function assertSubcontractPieceUnit(unit: string) {
    if (!isSubcontractPieceUnit(unit)) {
        throw new HttpError(422, 'SUBCONTRACT_PIECE_UNIT_REQUIRED', 'La répartition par origine compte des pièces. Choisissez des conditions fournisseur en pièces ; une conversion de poids ou de longueur doit être définie séparément.');
    }
}
export function assertSubcontractQuantityCeiling(total: number, ofQuantity: number, predecessors: Array<{
    status: string;
    good: number;
}>) {
    if (total > ofQuantity + 1e-9)
        throw new HttpError(409, 'SUBCONTRACT_QUANTITY_EXCEEDED', 'La quantité fournisseur dépasse la quantité de l’OF.');
    if (predecessors.some(p => p.status !== 'DONE'))
        throw new HttpError(409, 'SUBCONTRACT_PREVIOUS_OPERATION_OPEN', 'Clôturez et validez l’opération précédente avant de valider la commande de sous-traitance.');
    if (predecessors.some(p => total > p.good + 1e-9))
        throw new HttpError(409, 'SUBCONTRACT_REAL_QUANTITY_EXCEEDED', 'Ajustez les quantités fournisseur aux pièces réellement conformes après l’opération précédente.');
}
