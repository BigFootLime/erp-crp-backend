import { HttpError } from '../../utils/httpError';
const pieceUnits = new Set(['U', 'UNITE', 'UNITÉ', 'UNIT', 'PCE', 'PC', 'PCS', 'PIECE', 'PIÈCE']);
export const isSubcontractPieceUnit = (unit: string) => pieceUnits.has(unit.trim().toUpperCase());
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
