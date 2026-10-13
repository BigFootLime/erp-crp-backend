import type { PoolClient } from 'pg';
import { HttpError } from '../../utils/httpError';
import type { AuditContext } from '../production/repository/production.repository';
import { savePurchasePreparationsTx } from '../production/repository/purchase-preparation.repository';
import { readSubcontractProcurementTx } from './subcontract-procurement.repository';
import { readExternalPreparationsTx, type ExternalPreparationState } from './subcontract-planning-preparation.repository';

/** Called after the reviewed quantity increase, in the same serializable
 * transaction. Purchases, shipments and material-origin allocations stay intact. */
export async function extendRecoverySupplierPreparationsTx(
  tx: PoolClient, producerId: number, expected: Map<string,ExternalPreparationState>, audit: AuditContext,
) {
  if (!expected.size) return [];
  const fail = () => new HttpError(409,'RECOVERY_SUPPLIER_PREPARATION_CHANGED',
    'Les conditions du complément fournisseur ont changé. Actualisez la proposition.');
  const current = await readSubcontractProcurementTx(tx,producerId);
  for (const [operationId,state] of expected) {
    if (state.issues.length || !state.preparations.length) throw fail();
    for (const preparation of state.preparations) {
      const proposal = current.purchasePreparations.find(p=>p.sourceRef===preparation.purchaseId
        && p.service.selection.operationId===operationId);
      if (!proposal || proposal.id!==preparation.id || proposal.supplierId!==preparation.supplierId
        || proposal.service.forecastQuantity!==preparation.quantity
        || proposal.service.selection.catalogueId!==preparation.catalogueId
        || proposal.service.selection.due!==preparation.due) throw fail();
    }
  }
  await savePurchasePreparationsTx(tx,current.purchasePreparations,'PRESTATION',producerId,current.version,audit,{persistCovered:true});
  const saved = await readExternalPreparationsTx(tx,[...expected.keys()]);
  const comparable = (state:ExternalPreparationState) => JSON.stringify({
    issues:state.issues,preparations:state.preparations.map(({version,...p})=>p).sort((a,b)=>a.id.localeCompare(b.id)),
  });
  for (const [operationId,state] of expected) {
    const actual = saved.get(operationId);
    if (!actual || comparable(actual)!==comparable(state)) throw fail();
  }
  return [...saved.values()].flatMap(s=>s.preparations.map(p=>({id:p.id,operation_id:p.operationId,
    quantity:p.quantity,version:p.version})));
}
