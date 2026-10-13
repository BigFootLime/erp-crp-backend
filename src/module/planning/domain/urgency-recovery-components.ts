import type { CentralSnapshot } from '../types/planning-central.types';
import type { UrgencyApprovalIssue } from './urgency-recovery-approval';
import { dependencyClosure } from './central-dependencies';
export type RecoveryComponentCoverage = {
    ofId: number;
    definitionMissing: boolean;
    items: Array<{
        label: string;
        missing: number;
        childOfId: number | null;
    }>;
};
/** Future child production counts only once, inside this recovery and before its assembly. */
export function evaluateRecoveryComponents(coverage: RecoveryComponentCoverage[], tree: Array<{
    id: number;
    quantity: number;
}>, snapshot: CentralSnapshot): UrgencyApprovalIssue[] {
    const issues: UrgencyApprovalIssue[] = [];
    const quantities = new Map(tree.map(of => [of.id, of.quantity]));
    const assigned = new Map<number, number>();
    for (const parent of coverage) {
        if (parent.definitionMissing)
            issues.push({
                code: 'RECOVERY_COMPONENT_DEFINITION', of_id: parent.ofId,
                message: 'Définissez les sous-pièces du montage de récupération.'
            });
        const assembly = snapshot.tasks.filter(task => task.ofId === parent.ofId && task.operationType === 'ASSEMBLAGE');
        for (const item of parent.items) {
            if (item.missing <= 1e-9)
                continue;
            const childId = item.childOfId;
            const childTasks = snapshot.tasks.filter(task => task.ofId === childId && task.source === 'OPERATION');
            const required = (assigned.get(childId ?? -1) ?? 0) + item.missing;
            const linkedBeforeAssembly = assembly.length > 0 && assembly.every(operation => {
                const upstream = dependencyClosure(snapshot.dependencies, [operation.id], 'upstream');
                return childTasks.length > 0 && childTasks.every(task => upstream.has(task.id));
            });
            if (childId === null || !linkedBeforeAssembly || required > (quantities.get(childId) ?? 0) + 1e-9) {
                issues.push({
                    code: 'RECOVERY_COMPONENT_UNSECURED', of_id: parent.ofId,
                    message: `${item.label} : réservez les sous-pièces ou planifiez leur fabrication avant le montage.`
                });
            }
            else
                assigned.set(childId, required);
        }
    }
    return issues;
}
