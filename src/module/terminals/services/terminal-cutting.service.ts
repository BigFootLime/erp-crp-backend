import type { StationContext } from '../../production/middlewares/station-authorization.middleware';
import { svcDossier, svcScan, svcWorklist } from '../../production/services/station.service';
import { readStationCutting } from '../../production/services/station-cutting.service';
import { stripCostFields } from '../../production/domain/station';
import { dossierDocuments, operationContext } from '../repository/terminal-dossier.repository';
import type { Terminal } from '../repository/terminal-auth.repository';
export async function nativeCuttingWorklist(station: StationContext, q?: string) {
    return stripCostFields(await svcWorklist({ station, query: {
            q, material_only: true, machine_only: false, include_blocked: true, limit: 100,
        } }), false);
}
export async function nativeCuttingScan(station: StationContext, code: string) {
    return svcScan({ station, body: { code, material_only: true } });
}
export async function nativeCuttingDossier(terminal: Terminal, station: StationContext, ofId: number, operationId: string) {
    const context = await operationContext(terminal, ofId, operationId);
    const [base, cutting, documents] = await Promise.all([
        svcDossier({ station, ofId, operationId }),
        readStationCutting(station, ofId, operationId),
        dossierDocuments(context, 'cutting'),
    ]);
    // Every downloadable document belongs to the released dossier; no general GED route.
    return stripCostFields({ ...base, documents: [], documents_manifest: documents,
        plan: { ...(base.plan as object), document: documents.find(d => d.id === (base.plan as {
                document?: {
                    id: string;
                };
            }).document?.id) ?? null },
        material: cutting.material, cutting_operation: cutting.operation,
        scope: { of_id: ofId, operation_id: operationId, machine_id: null },
        contract_version: 1, server_time: new Date().toISOString(),
        cache_expires_at: new Date(Date.now() + 12 * 3600000).toISOString(),
        boundaries: ['Le débit confirmé enregistre la sortie matière et les bruts obtenus.'],
    }, false);
}
