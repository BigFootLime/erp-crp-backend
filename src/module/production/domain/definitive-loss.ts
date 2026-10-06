import { HttpError } from '../../../utils/httpError';
export function assertDefinitiveLoss(input: {
    status: string;
    potential: boolean;
    loss: number;
    covered: number;
    quantity: number;
}) {
    if (input.status !== 'DONE')
        throw new HttpError(409, 'LOSS_OPERATION_NOT_CLOSED', 'Clôturez l’opération avant de préparer un OF de complément.');
    if (input.potential)
        throw new HttpError(409, 'LOSS_YIELD_NOT_FINAL', 'La découpe avant tournage est une estimation. Déclarez les pertes définitives au tournage.');
    if (![input.loss, input.covered, input.quantity].every(Number.isFinite) || input.quantity <= 0 || !Number.isInteger(input.quantity))
        throw new HttpError(422, 'LOSS_QUANTITY_INVALID', 'Indiquez un nombre entier de pièces à remplacer.');
    const remaining = Math.max(0, input.loss - input.covered);
    if (input.quantity > remaining + 1e-9)
        throw new HttpError(409, 'LOSS_ALREADY_COVERED', 'Le complément dépasse les pertes définitives encore à couvrir.', { remaining });
}
